#!/usr/bin/env node
'use strict';
/**
 * Token Monitor Hub -> WakaTime bridge.
 *
 * Polls a Token Monitor Hub (GET /api/stats), diffs per-session token counters
 * with the shared core, and posts the increments as WakaTime heartbeats in the
 * "ai coding" category. It also answers the plugin presence handshake so a
 * desktop plugin can stand down while the Hub owns uploads.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('../shared/wakatime-core.cjs');

const BRIDGE_VERSION = '0.5.0';
const BULK_LIMIT = core.BULK_LIMIT;
const PRESENCE_ENTRY_TTL_MS = 60 * 60 * 1000;
const PRESENCE_MAX_ENTRIES = 64;
const STATE_VERSION = 2;

function log(level, message, extra) {
  const line = `${new Date().toISOString()} ${level} ${message}`;
  if (extra === undefined) console.log(line);
  else console.log(line, typeof extra === 'string' ? extra : JSON.stringify(extra));
}

function parseArgs(argv) {
  const args = { once: false, dryRun: false, verbose: false, postInitial: false, config: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--once') args.once = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--post-initial') args.postInitial = true;
    else if (arg === '--config') args.config = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function readSecret(value, secretFile) {
  if (value && String(value).trim()) return String(value).trim();
  if (!secretFile) return '';
  try {
    return fs.readFileSync(secretFile, 'utf8').trim();
  } catch (error) {
    throw new Error(`Cannot read secret file ${secretFile}: ${error.message}`);
  }
}

function defaultConfigPath() {
  const directory = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const managed = path.join(directory, 'wakatime-bridge', 'config.json');
  return fs.existsSync(managed) ? managed : path.join(__dirname, 'config.json');
}

function loadConfig(args) {
  const configPath = args.config || process.env.TOKEN_MONITOR_WAKATIME_CONFIG || defaultConfigPath();
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' || args.config) {
      throw new Error(`Cannot read config ${configPath}: ${error.message}`);
    }
  }
  const env = process.env;
  const config = {
    configPath,
    hubUrl: env.TOKEN_MONITOR_HUB_URL || file.hubUrl || 'http://127.0.0.1:17321',
    hubSecret: readSecret(env.TOKEN_MONITOR_SECRET, file.hubSecretFile || null),
    wakatimeApiKey: readSecret(env.WAKATIME_API_KEY, file.wakatimeApiKeyFile || null)
      || (file.wakatimeApiKey ? String(file.wakatimeApiKey).trim() : ''),
    pollSeconds: Number(env.TOKEN_MONITOR_WAKATIME_POLL_SECONDS || file.pollSeconds || 60),
    projectPrefix: file.projectPrefix || '',
    projectOverrides: file.projectOverrides || {},
    devices: Array.isArray(file.devices) ? file.devices : [],
    dryRun: Boolean(args.dryRun || env.TOKEN_MONITOR_WAKATIME_DRY_RUN === '1' || file.dryRun),
    postInitial: Boolean(args.postInitial || file.postInitial),
    stateFile: file.stateFile || path.join(path.dirname(configPath), 'state.json'),
    timezone: file.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    backfillWindowMinutes: Number(file.backfillWindowMinutes || 15),
    presenceHost: env.TOKEN_MONITOR_WAKATIME_PRESENCE_HOST || file.presenceHost || '0.0.0.0',
    presencePort: Number(env.TOKEN_MONITOR_WAKATIME_PRESENCE_PORT || file.presencePort || 17322),
    presenceEnabled: file.presenceEnabled !== false,
    language: file.language || 'ai',
    userAgentProduct: file.userAgentProduct || 'token-monitor',
  };
  if (!(config.pollSeconds >= 5)) config.pollSeconds = 60;
  if (!config.hubSecret) throw new Error('Token Monitor hub secret missing (TOKEN_MONITOR_SECRET or hubSecretFile)');
  if (config.devices.length && !config.devices.every(id => typeof id === 'string')) {
    throw new Error('config.devices must be an array of device ids');
  }
  return config;
}

function loadState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state && state.version === 2 && state.baselines && typeof state.baselines === 'object') return state;
    if (state && state.version === 1) {
      log('INFO', 'state v1 found; rebaselining sessions under stable keys');
      return { version: STATE_VERSION, date: core.dayKey(), baselines: {}, counters: { heartbeats: 0, input: 0, output: 0 }, lastPostAt: null };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') log('WARN', `Cannot read state, starting fresh: ${error.message}`);
  }
  return { version: STATE_VERSION, date: core.dayKey(), baselines: {}, counters: { heartbeats: 0, input: 0, output: 0 }, lastPostAt: null };
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

async function hubFetch(config, pathname) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${config.hubUrl.replace(/\/+$/, '')}${pathname}`, {
      headers: { Authorization: `Bearer ${config.hubSecret}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Hub ${pathname} -> HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Flatten Hub stats into normalized session rows understood by the shared core. */
function deviceRows(config, stats) {
  const rows = [];
  const partial = [];
  const devices = Array.isArray(stats.devices) ? stats.devices : [];
  for (const device of devices) {
    if (!device || typeof device !== 'object') continue;
    const deviceId = device.deviceId || device.id || 'unknown';
    if (config.devices.length && !config.devices.includes(deviceId)) continue;
    const sessions = device.periods && device.periods.today && device.periods.today.sessions;
    if (device.sessionDetailsOmitted && device.sessionDetailsOmitted.today) partial.push(deviceId);
    if (!sessions || typeof sessions !== 'object') continue;
    for (const [sessionKey, session] of Object.entries(sessions)) {
      if (!session || typeof session !== 'object') continue;
      const label = typeof session.projectLabel === 'string' ? session.projectLabel.trim() : '';
      const mapped = (label && config.projectOverrides[label])
        || (typeof session.projectId === 'string' && config.projectOverrides[session.projectId])
        || label;
      rows.push({
        id: sessionKey,
        client: session.client,
        deviceId,
        startedAt: session.startedAt,
        lastUsedAt: session.lastUsedAt,
        projectLabel: mapped || '',
        projectPath: typeof session.projectId === 'string' ? session.projectId : '',
        totalTokens: session.totalTokens,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        cacheReadTokens: session.cacheReadTokens,
        cacheWriteTokens: session.cacheWriteTokens,
        models: Object.entries(session.models || {}).map(([model, tokens]) => ({
          model,
          totalTokens: tokens,
          tokenComponents: session.modelTokenComponents && session.modelTokenComponents[model]
            ? session.modelTokenComponents[model]
            : null,
        })),
        hostname: device.hostname || deviceId,
        platform: device.platform || 'unknown-unknown',
        timezone: config.timezone,
      });
    }
  }
  if (!devices.length && stats.periods && stats.periods.today) {
    for (const [sessionKey, session] of Object.entries(stats.periods.today.sessions || {})) {
      if (!session || typeof session !== 'object') continue;
      rows.push({
        id: sessionKey,
        client: session.client,
        deviceId: 'aggregate',
        startedAt: session.startedAt,
        lastUsedAt: session.lastUsedAt,
        projectLabel: session.projectLabel || '',
        projectPath: session.projectId || '',
        totalTokens: session.totalTokens,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        cacheReadTokens: session.cacheReadTokens,
        cacheWriteTokens: session.cacheWriteTokens,
        models: Object.entries(session.models || {}).map(([model, tokens]) => ({
          model,
          totalTokens: tokens,
          tokenComponents: session.modelTokenComponents && session.modelTokenComponents[model]
            ? session.modelTokenComponents[model]
            : null,
        })),
        hostname: config.hostname || os.hostname(),
        platform: `${process.platform}-${process.arch}`,
        timezone: config.timezone,
      });
    }
  }
  return { rows, partial };
}

function createPresenceServer(config, runtime) {
  const plugins = new Map();
  const authorized = request => {
    const header = request.headers.authorization || '';
    const candidate = header.startsWith('Bearer ') ? header.slice(7).trim() : String(request.headers['x-token-monitor-secret'] || '');
    const expected = config.hubSecret;
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const prune = now => {
    for (const [key, entry] of plugins) if (now - entry.seenAt > PRESENCE_ENTRY_TTL_MS) plugins.delete(key);
    while (plugins.size > PRESENCE_MAX_ENTRIES) {
      const oldest = [...plugins.entries()].sort((x, y) => x[1].seenAt - y[1].seenAt)[0];
      if (!oldest) break;
      plugins.delete(oldest[0]);
    }
  };
  const server = http.createServer((request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (!authorized(request)) return send(401, { ok: false, error: 'unauthorized' });
    const url = new URL(request.url || '/', 'http://localhost');
    const now = Date.now();
    prune(now);
    if (request.method === 'GET' && url.pathname === '/presence') {
      return send(200, {
        ok: true,
        role: 'hub-bridge',
        uploader: 'hub',
        version: BRIDGE_VERSION,
        at: new Date().toISOString(),
        plugins: [...plugins.values()].map(entry => ({
          hostname: entry.hostname,
          version: entry.version,
          at: entry.at,
          ageMs: Math.max(0, now - entry.seenAt),
        })),
        runtime: runtime.value(),
      });
    }
    if (request.method === 'POST' && url.pathname === '/presence/plugin') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => {
        body += chunk;
        if (body.length > 4096) request.destroy();
      });
      request.on('end', () => {
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { return send(400, { ok: false, error: 'invalid_json' }); }
        const hostname = typeof payload.hostname === 'string' ? payload.hostname.slice(0, 128) : '';
        const version = typeof payload.version === 'string' ? payload.version.slice(0, 32) : '';
        plugins.set(hostname || 'unknown', { hostname, version, at: new Date().toISOString(), seenAt: Date.now() });
        prune(Date.now());
        log('INFO', `plugin presence from ${hostname || 'unknown'} ${version} -> hub owns uploads`);
        return send(200, { ok: true, role: 'hub-bridge', uploader: 'hub', takeOver: true, at: new Date().toISOString() });
      });
      return undefined;
    }
    return send(404, { ok: false, error: 'not_found' });
  });
  server.on('error', error => log('WARN', `presence server: ${error.message}`));
  return { server, plugins };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node bridge.js [--once] [--dry-run] [--verbose] [--post-initial] [--config <path>]

Environment: TOKEN_MONITOR_HUB_URL, TOKEN_MONITOR_SECRET, WAKATIME_API_KEY,
             TOKEN_MONITOR_WAKATIME_POLL_SECONDS, TOKEN_MONITOR_WAKATIME_DRY_RUN`);
    return;
  }
  const config = loadConfig(args);
  if (!config.dryRun && !config.wakatimeApiKey) throw new Error('WakaTime API key missing (WAKATIME_API_KEY or config.wakatimeApiKey)');
  const state = loadState(config.stateFile);
  log('INFO', `bridge ${BRIDGE_VERSION} starting: hub=${config.hubUrl} poll=${config.pollSeconds}s dryRun=${config.dryRun} devices=${config.devices.length || 'all'}`);

  const runtime = {
    lastTickAt: null,
    lastPostAt: null,
    error: null,
    partial: [],
    value() {
      return {
        lastTickAt: this.lastTickAt,
        lastPostAt: this.lastPostAt,
        heartbeatsToday: state.counters.heartbeats,
        inputToday: state.counters.input,
        outputToday: state.counters.output,
        partial: this.partial,
        error: this.error,
      };
    },
  };

  let presence = null;
  if (config.presenceEnabled && !args.once) {
    presence = createPresenceServer(config, runtime);
    presence.server.listen(config.presencePort, config.presenceHost, () => {
      log('INFO', `presence server on http://${config.presenceHost}:${config.presencePort} (plugins yield to the hub)`);
    });
  }

  const settings = {
    apiKey: config.wakatimeApiKey,
    projectMode: 'label',
    projectPrefix: config.projectPrefix,
    category: 'ai coding',
    includeCacheTokens: true,
    language: config.language,
    timezone: config.timezone,
  };

  async function tick() {
    try {
      const stats = await hubFetch(config, '/api/stats');
      const now = Date.now();
      const today = core.dayKey(now);
      if (state.date !== today) {
        log('INFO', `Day rollover ${state.date} -> ${today}; dropping baselines`);
        state.baselines = {};
        state.counters = { heartbeats: 0, input: 0, output: 0 };
        state.date = today;
      }
      const { rows, partial } = deviceRows(config, stats);
      runtime.partial = partial;
      const result = core.diffRows({
        settings,
        rows,
        baselines: state.baselines,
        now,
        postInitial: config.postInitial,
        backfillWindowMinutes: config.backfillWindowMinutes,
      });
      state.baselines = result.baselines;
      if (result.heartbeats.length) {
        if (config.dryRun) {
          log('INFO', `DRY RUN: would post ${result.heartbeats.length} heartbeat(s)`, result.heartbeats.slice(0, 3));
        } else {
          const posted = await core.postHeartbeats({
            settings,
            heartbeats: result.heartbeats,
            version: BRIDGE_VERSION,
            product: config.userAgentProduct,
          });
          state.counters = {
            heartbeats: state.counters.heartbeats + posted.posted,
            input: state.counters.input + result.totals.input,
            output: state.counters.output + result.totals.output,
          };
          if (posted.posted) {
            state.lastPostAt = new Date(now).toISOString();
            runtime.lastPostAt = state.lastPostAt;
          }
          if (posted.failed) {
            runtime.error = posted.message || 'upload failed';
            log('ERROR', `posted ${posted.posted}/${result.heartbeats.length}`, posted);
          } else {
            runtime.error = null;
            log('INFO', `posted ${posted.posted}/${result.heartbeats.length} heartbeat(s)`);
          }
        }
      } else if (config.verbose) {
        log('DEBUG', `no token deltas (${result.skipped} baseline(s) established)`);
      }
      runtime.lastTickAt = new Date(now).toISOString();
      saveState(config.stateFile, state);
    } catch (error) {
      runtime.error = error.message;
      runtime.lastTickAt = new Date().toISOString();
      log('ERROR', `tick failed: ${error.message}`);
    }
  }

  await tick();
  if (args.once) return;

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log('INFO', 'bridge stopping');
    if (presence) presence.server.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, config.pollSeconds * 1000));
    if (stopping) return;
    await tick();
  }
}

if (require.main === module) {
  main().catch(error => {
    log('ERROR', error.message);
    process.exitCode = 1;
  });
}

module.exports = { BRIDGE_VERSION, createPresenceServer, deviceRows, loadConfig, loadState };
