'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('./shared/wakatime-core.cjs');
const manifest = require('./manifest.json');

const PLUGIN_VERSION = manifest.version;
const MAX_PAGES = 20;
const PAGE_LIMIT = 200;
const STATS_CACHE_MS = 30 * 1000;
const PRESENCE_RETRY_MS = 5 * 60 * 1000;
const STATE_VERSION = 2;

function logWarn(message) {
  console.log(`[wakatime-sync] ${message}`);
}

function safeHostname() {
  try { return os.hostname(); } catch { return ''; }
}

function safeTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

function readState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state && state.version === STATE_VERSION && state.baselines && typeof state.baselines === 'object') return state;
    if (state && state.version === 1) {
      // Version 1 keyed baselines by opaque row ids; those are not guaranteed
      // across restarts, so rebuild them under the stable anchor scheme.
      logWarn('state v1 found; rebaselining sessions under stable keys');
      return {
        version: STATE_VERSION,
        date: typeof state.date === 'string' ? state.date : core.dayKey(),
        baselines: {},
        counters: state.counters && typeof state.counters === 'object'
          ? { heartbeats: state.counters.heartbeats || 0, input: state.counters.input || 0, output: state.counters.output || 0 }
          : { heartbeats: 0, input: 0, output: 0 },
        lastPostAt: typeof state.lastPostAt === 'string' ? state.lastPostAt : null,
      };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') logWarn(`Cannot read state: ${error.message}`);
  }
  return { version: STATE_VERSION, date: core.dayKey(), baselines: {}, counters: { heartbeats: 0, input: 0, output: 0 }, lastPostAt: null };
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function validBridgeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch { return null; }
}

exports.activate = async ({ dataDirectory, host, publish, log }) => {
  const stateFile = path.join(dataDirectory, 'state.json');
  let state = readState(stateFile);
  let persisted = JSON.stringify(state);
  let status = {
    state: 'idle',
    enabled: false,
    dryRun: false,
    scope: null,
    delegation: null,
    availability: null,
    truncated: false,
    lastPostAt: null,
    lastError: null,
    counters: { ...state.counters },
    baselines: 0,
    lastPollAt: null,
    polls: 0,
  };
  let stopped = false;
  let timer = null;
  let timerSeconds = 0;
  let currentTick = null;
  let statsCache = null;
  let presenceRetryAt = 0;

  const emit = value => {
    status = { ...status, ...value };
    if (!stopped) publish(status);
  };
  if (log) log(`WakaTime sync ${PLUGIN_VERSION} backend starting`);

  function persist() {
    const bytes = JSON.stringify(state);
    if (bytes === persisted) return;
    writeState(stateFile, state);
    persisted = bytes;
  }

  async function readSettings() {
    const snapshot = await host.call('settings.get');
    if (snapshot.status !== 'ready') throw new Error('Plugin settings need attention');
    let appSettings = {};
    try { appSettings = await host.call('app.settings'); } catch { appSettings = {}; }
    return {
      hubUrl: typeof appSettings.hubUrl === 'string' ? appSettings.hubUrl : '',
      hubSecret: typeof appSettings.secret === 'string' && appSettings.secret
        ? appSettings.secret
        : (typeof appSettings.hubHostSecret === 'string' ? appSettings.hubHostSecret : ''),
      ...snapshot.values,
      // Transport metadata for WakaTime machine/timezone attribution.
      hostname: safeHostname(),
      platform: `${process.platform}-${process.arch}`,
      timezone: safeTimezone(),
    };
  }

  async function queryAll(query) {
    const rows = [];
    let cursor;
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const envelope = await host.call('data.query', {
        ...query,
        page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      });
      if (envelope.availability !== 'available') return { rows, availability: envelope.availability, truncated };
      if (Array.isArray(envelope.rows)) rows.push(...envelope.rows);
      const hasMore = Boolean(envelope.pageInfo && envelope.pageInfo.hasMore);
      cursor = envelope.pageInfo && envelope.pageInfo.nextCursor;
      if (!cursor || !hasMore) return { rows, availability: 'available', truncated };
      if (page === MAX_PAGES - 1) { truncated = true; break; }
    }
    return { rows, availability: 'available', truncated };
  }

  /**
   * Pick this machine's device record when the App reads a shared Hub. When the
   * hostname cannot be matched on a multi-device Hub the plugin fails closed
   * instead of uploading every device (that would duplicate other machines).
   */
  async function resolveScope(settings) {
    const scope = settings.scope || 'auto';
    if (scope === 'aggregate') return { filter: {}, mode: 'aggregate', label: 'all devices' };
    let devices = { rows: [], availability: 'denied' };
    try {
      devices = await queryAll({ resource: 'devices', period: 'today' });
    } catch {
      devices = { rows: [], availability: 'denied' };
    }
    const rows = Array.isArray(devices.rows) ? devices.rows : [];
    const host = (settings.hostname || '').toLowerCase();
    const match = host ? rows.find(row => String(row.hostname || '').toLowerCase() === host) : null;
    if (match) return { filter: { deviceId: match.id }, mode: 'this-device', label: match.displayName || match.hostname || 'this device' };
    if (rows.length === 0) return { filter: {}, mode: 'aggregate', label: 'all devices' };
    if (rows.length === 1) {
      // Local collection or a one-device Hub: the aggregate is this machine.
      return { filter: {}, mode: 'aggregate-single', label: rows[0].displayName || rows[0].hostname || 'single device' };
    }
    return { filter: null, mode: 'scope-unresolved', label: `unmatched (${rows.length} devices)` };
  }

  async function loadProjectLabels(scope) {
    const labels = new Map();
    try {
      const projects = await queryAll({ resource: 'projects', period: 'today', ...(scope.filter.deviceId ? { filter: scope.filter } : {}) });
      if (projects.availability === 'available') {
        for (const row of projects.rows) if (row && row.id && row.label) labels.set(row.id, row.label);
      }
    } catch {
      // Project labels are presentation only; missing labels fall back to path names.
    }
    return labels;
  }

  async function collectRows(scope) {
    const labels = await loadProjectLabels(scope);
    const sessions = await queryAll({
      resource: 'sessions',
      period: 'today',
      ...(scope.filter.deviceId ? { filter: scope.filter } : {}),
    });
    const rows = sessions.rows.map(row => {
      const label = row && row.projectId ? labels.get(row.projectId) : '';
      return label ? { ...row, projectLabel: label } : row;
    });
    return { rows, availability: sessions.availability, truncated: sessions.truncated };
  }

  /** Ask the Hub bridge whether it is running and owns uploads. */
  async function probeBridge(settings) {
    if (!settings.hubUrl) return { mode: 'no-hub' };
    const hub = validBridgeUrl(settings.hubUrl);
    if (!hub) return { mode: 'invalid-hub' };
    const base = settings.hubBridgeUrl ? validBridgeUrl(settings.hubBridgeUrl) : null;
    const target = base ? base.href.replace(/\/+$/, '') : `${hub.protocol}//${hub.hostname}:17322`;
    if (!settings.hubSecret) return { mode: 'no-secret' };
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`${target}/presence/plugin`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.hubSecret}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ hostname: settings.hostname, version: PLUGIN_VERSION, at: new Date().toISOString() }),
        signal: controller.signal,
      });
      if (!response.ok) return { mode: 'bridge-error', status: response.status };
      const body = await response.json();
      if (body && body.takeOver === true) return { mode: 'hub-active', bridgeAt: body.at || null };
      return { mode: 'bridge-present', bridgeAt: body && body.at ? body.at : null };
    } catch (error) {
      return { mode: 'bridge-unreachable', error: error.message };
    } finally {
      clearTimeout(deadline);
    }
  }

  function rollover(now) {
    const today = core.dayKey(now);
    if (state.date === today) return false;
    state = { version: STATE_VERSION, date: today, baselines: {}, counters: { heartbeats: 0, input: 0, output: 0 }, lastPostAt: null };
    emit({ counters: { ...state.counters }, lastPostAt: null });
    return true;
  }

  async function runTick(reason) {
    try {
      const settings = await readSettings();
      if (!settings.enabled) {
        emit({ state: 'off', enabled: false, dryRun: Boolean(settings.dryRun), lastError: null, availability: null, scope: null, delegation: null, truncated: false });
        return status;
      }
      if (!settings.apiKey && !settings.dryRun) {
        emit({ state: 'error', enabled: true, lastError: 'Missing WakaTime API key' });
        return status;
      }
      if (Number(settings.pollSeconds) && Math.max(30, Number(settings.pollSeconds)) !== timerSeconds) schedule(settings);
      const now = Date.now();
      rollover(now);

      let delegation = status.delegation;
      if (settings.preferHub !== false) {
        if (now >= presenceRetryAt || (delegation && delegation.mode === 'hub-active')) {
          delegation = await probeBridge(settings);
          if (delegation.mode === 'bridge-unreachable' || delegation.mode === 'bridge-error') {
            presenceRetryAt = now + PRESENCE_RETRY_MS;
          } else {
            presenceRetryAt = 0;
          }
        }
        if (delegation && delegation.mode === 'hub-active') {
          persist();
          emit({
            state: 'hub-active',
            enabled: true,
            dryRun: Boolean(settings.dryRun),
            delegation,
            scope: { mode: 'hub', label: 'Hub bridge' },
            availability: status.availability,
            truncated: false,
            lastError: null,
            counters: { ...state.counters },
            baselines: Object.keys(state.baselines).length,
            lastPollAt: new Date(now).toISOString(),
            polls: status.polls + 1,
            reason,
          });
          return status;
        }
      }

      const scope = await resolveScope(settings);
      if (scope.mode === 'scope-unresolved') {
        persist();
        emit({
          state: 'scope-unresolved',
          enabled: true,
          dryRun: Boolean(settings.dryRun),
          delegation,
          scope: { mode: scope.mode, label: scope.label },
          availability: status.availability,
          lastError: `No Hub device matches hostname "${settings.hostname}". Set "Which sessions to upload" to all devices, or rename the device.`,
          counters: { ...state.counters },
          baselines: Object.keys(state.baselines).length,
          lastPollAt: new Date(now).toISOString(),
          polls: status.polls + 1,
          reason,
        });
        return status;
      }

      const collection = await collectRows(scope);
      let result = { heartbeats: [], skipped: 0, totals: { input: 0, output: 0 } };
      if (collection.availability === 'available') {
        result = core.diffRows({
          settings,
          rows: collection.rows,
          baselines: state.baselines,
          now,
          backfillWindowMinutes: 15,
        });
      }
      const summary = {
        enabled: true,
        dryRun: Boolean(settings.dryRun),
        delegation,
        scope: { mode: scope.mode, label: scope.label },
        availability: collection.availability,
        truncated: Boolean(collection.truncated),
        baselines: Object.keys(result.baselines).length,
        lastPollAt: new Date(now).toISOString(),
        polls: status.polls + 1,
        reason,
      };
      if (result.heartbeats.length) {
        if (settings.dryRun) {
          if (log) log(`dry run: ${result.heartbeats.length} heartbeat(s)`);
          state.baselines = result.baselines;
          state.counters = {
            heartbeats: state.counters.heartbeats + result.heartbeats.length,
            input: state.counters.input + result.totals.input,
            output: state.counters.output + result.totals.output,
          };
          persist();
          emit({ ...summary, state: 'dry-run', lastError: null, counters: { ...state.counters } });
          return status;
        }
        const posted = await core.postHeartbeats({
          settings,
          heartbeats: result.heartbeats,
          version: PLUGIN_VERSION,
        });
        state.baselines = result.baselines;
        state.counters = {
          heartbeats: state.counters.heartbeats + posted.posted,
          input: state.counters.input + result.totals.input,
          output: state.counters.output + result.totals.output,
        };
        if (posted.posted) state.lastPostAt = new Date(now).toISOString();
        persist();
        emit({
          ...summary,
          state: posted.failed ? 'error' : 'ready',
          lastError: posted.failed ? posted.message : null,
          counters: { ...state.counters },
          lastPostAt: state.lastPostAt,
        });
        return status;
      }
      state.baselines = result.baselines;
      persist();
      emit({ ...summary, state: 'ready', lastError: null, counters: { ...state.counters } });
      return status;
    } catch (error) {
      emit({ state: 'error', lastError: error.message, polls: status.polls + 1 });
      return status;
    }
  }

  // A manual refresh while a scheduled tick is in flight waits for it and then
  // polls again, so the Refresh button never silently no-ops.
  async function tick(reason = 'timer') {
    if (stopped) return status;
    if (currentTick) { try { await currentTick; } catch { /* superseded by the manual run */ } }
    if (stopped) return status;
    currentTick = runTick(reason);
    try {
      return await currentTick;
    } finally {
      currentTick = null;
    }
  }

  function schedule(settings) {
    if (timer) clearInterval(timer);
    timer = null;
    if (stopped) return;
    timerSeconds = Math.max(30, Number(settings.pollSeconds) || 60);
    timer = setInterval(() => { void tick('timer'); }, timerSeconds * 1000);
    if (timer.unref) timer.unref();
  }

  // Kick off once so a restored background session starts uploading promptly.
  const initial = await readSettings().catch(error => ({ error }));
  if (!initial.error) {
    emit({ enabled: Boolean(initial.enabled), dryRun: Boolean(initial.dryRun) });
    schedule(initial);
    void tick('startup');
  } else {
    emit({ state: 'error', lastError: initial.error.message });
  }

  return {
    async call(method, value) {
      if (method === 'refresh') return tick('manual');
      if (method === 'status') return status;
      if (method === 'wakatime-stats') {
        const force = Boolean(value && value.force);
        const now = Date.now();
        if (!force && statsCache && now - statsCache.at < STATS_CACHE_MS) return statsCache.value;
        const settings = await readSettings();
        if (!settings.oauthToken) throw new Error('No OAuth access token configured');
        const stats = await core.fetchTodayStats({ oauthToken: settings.oauthToken });
        statsCache = { value: stats, at: now };
        return stats;
      }
      throw new Error(`Unknown operation: ${method}`);
    },
    update(context) {
      // Keep the timer alive while the host runs this background plugin; hidden UI
      // does not stop uploads because the whole point is continuous reporting.
      if (stopped) return;
      void readSettings().then(schedule).catch(() => {});
      void context;
    },
    dispose() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
};
