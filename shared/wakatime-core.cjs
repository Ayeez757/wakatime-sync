'use strict';
// Shared by the Token Monitor plugin backend and the Hub bridge. No Electron or
// host APIs here, so the diff/payload logic can be unit-tested with plain node.

const WAKATIME_API = 'https://api.wakatime.com/api/v1';
const BULK_LIMIT = 25;

const CATEGORIES = new Set([
  'coding', 'building', 'indexing', 'debugging', 'browsing', 'running tests',
  'writing tests', 'manual testing', 'writing docs', 'code reviewing', 'communicating',
  'notes', 'researching', 'learning', 'designing', 'ai coding',
]);

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function dayKey(now = Date.now()) {
  const date = new Date(now);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function basename(projectPath) {
  const parts = String(projectPath).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

function isOpaqueProject(value) {
  return /^sha256:/i.test(String(value || '')) || /^[0-9a-f]{16,}$/i.test(String(value || ''));
}

/** Project name for WakaTime, honoring the configured naming mode. */
function projectNameFor(settings, row) {
  const mode = settings.projectMode || 'label';
  if (mode === 'none') return '';
  const label = typeof row.projectLabel === 'string' ? row.projectLabel.trim() : '';
  const raw = typeof row.projectPath === 'string' ? row.projectPath.trim() : '';
  const pathName = raw && !isOpaqueProject(raw) ? basename(raw) : '';
  let name = '';
  if (mode === 'folder') name = pathName || label;
  else name = label || pathName;
  if (!name) return '';
  return settings.projectPrefix ? `${settings.projectPrefix}${name}` : name;
}

/** Per-model counters for one normalized session row. */
function modelEntries(row, settings = {}) {
  const includeCache = settings.includeCacheTokens !== false;
  const models = Array.isArray(row.models) ? row.models.filter(m => m && finite(m.totalTokens)) : [];
  const entries = [];
  for (const model of models) {
    const part = model.tokenComponents;
    const total = finite(model.totalTokens);
    if (!part || typeof part !== 'object') continue;
    const entry = {
      model: model.model || 'unknown',
      total,
      input: finite(part.inputTokens),
      cacheRead: includeCache ? finite(part.cacheReadTokens) : 0,
      cacheWrite: includeCache ? finite(part.cacheWriteTokens) : 0,
      output: finite(part.outputTokens),
    };
    if (!entry.input && !entry.output && !entry.cacheRead && !entry.cacheWrite && total) entry.input = total;
    entries.push(entry);
  }
  if (entries.length) return entries;
  const total = finite(row.totalTokens);
  if (!total) return [];
  const names = models.length ? models : [{ model: 'unknown', totalTokens: total }];
  const sum = names.reduce((acc, model) => acc + finite(model.totalTokens), 0) || total;
  for (const model of names) {
    const share = finite(model.totalTokens) / sum;
    entries.push({
      model: model.model || 'unknown',
      total: finite(model.totalTokens) || total,
      input: Math.round((finite(row.inputTokens)
        + (includeCache ? finite(row.cacheReadTokens) + finite(row.cacheWriteTokens) : 0)) * share),
      cacheRead: 0,
      cacheWrite: 0,
      output: Math.round(finite(row.outputTokens) * share),
    });
  }
  return entries;
}

/**
 * Stable baseline anchor. Opaque row ids have no cross-restart guarantee, so a
 * session start timestamp (immutable for the session) is preferred; the opaque
 * id only serves as a fallback when the host did not project a start time.
 */
function sessionAnchor(row) {
  const startedAt = typeof row.startedAt === 'string' ? row.startedAt.trim() : '';
  if (startedAt) return startedAt;
  return `id:${row.id || ''}`;
}

function stateKey(row, model) {
  return `${row.deviceId || 'aggregate'}|${row.client || 'unknown'}|${sessionAnchor(row)}|${model}`;
}

function heartbeatLanguage(settings, row) {
  const choice = settings.language || 'ai';
  if (choice === 'none') return '';
  if (choice === 'text') return 'Text';
  if (choice === 'client') return row.client || '';
  return 'AI';
}

function makeHeartbeat(settings, row, tokens, time, sessionLabel) {
  const project = projectNameFor(settings, row);
  const language = heartbeatLanguage(settings, row);
  return {
    entity: `token-monitor:${row.client || 'unknown'}`,
    type: 'app',
    category: CATEGORIES.has(settings.category) ? settings.category : 'ai coding',
    time,
    is_write: false,
    ai_session: sessionLabel,
    ai_input_tokens: Math.round(tokens.input),
    ai_output_tokens: Math.round(tokens.output),
    ...(project ? { project } : {}),
    ...(language ? { language } : {}),
    // Transport-only metadata, stripped before the request body is sent.
    // Per-row values let one bridge process group heartbeats per Hub device.
    _hostname: row.hostname || settings.hostname || '',
    _platform: row.platform || settings.platform || 'unknown-unknown',
    _timezone: row.timezone || settings.timezone || '',
  };
}

function userAgentFor({ platform, version, product = 'token-monitor' } = {}) {
  const [os, arch] = String(platform || 'unknown-unknown').split('-');
  const release = version || '0.0.0';
  // No AI-model token: WakaTime derives AI models from its own CLI parsers, and
  // a custom token there becomes a bogus model with invented cost.
  return `wakatime/13.0.0 (${os}-${arch}) node/${process.versions.node} ${product}/${release}`;
}

/**
 * Compare current counters against saved baselines and build heartbeats for the
 * increments. `baselines` is keyed by stateKey(row, model).
 */
function diffRows({ settings, rows, baselines = {}, now = Date.now(), postInitial = false, backfillWindowMinutes = 15 }) {
  const heartbeats = [];
  const next = {};
  const totals = { input: 0, output: 0 };
  let skipped = 0;
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const usedAt = Date.parse(row.lastUsedAt || row.startedAt || '') || now;
    const freshTime = usedAt < now - backfillWindowMinutes * 60000 ? now : usedAt;
    const sessionLabel = `${row.deviceId || 'aggregate'}:${row.id || sessionAnchor(row)}`;
    const entries = modelEntries(row, settings);
    const tokens = { input: 0, output: 0 };
    let lastHbAt = 0;
    for (const entry of entries) {
      const key = stateKey(row, entry.model);
      seen.add(key);
      const current = { input: entry.input, output: entry.output, total: entry.total };
      const previous = baselines[key];
      if (!previous) {
        next[key] = { ...current, at: now };
        if (!postInitial) { skipped++; continue; }
        tokens.input += current.input;
        tokens.output += current.output;
        next[key].hbAt = Math.floor(freshTime / 1000);
        lastHbAt = Math.max(lastHbAt, next[key].hbAt);
        continue;
      }
      lastHbAt = Math.max(lastHbAt, previous.hbAt || 0);
      if (current.input < previous.input || current.output < previous.output || current.total < previous.total) {
        next[key] = { ...current, at: now };
        skipped++;
        continue;
      }
      const delta = {
        input: current.input - previous.input,
        output: current.output - previous.output,
        total: current.total - previous.total,
      };
      next[key] = { ...current, at: now, hbAt: previous.hbAt || 0 };
      if (delta.input <= 0 && delta.output <= 0 && delta.total <= 0) continue;
      tokens.input += delta.input;
      tokens.output += delta.output;
    }
    if (tokens.input <= 0 && tokens.output <= 0) continue;
    const seconds = Math.floor(freshTime / 1000);
    const at = seconds > lastHbAt ? seconds : lastHbAt + 1;
    heartbeats.push(makeHeartbeat(settings, row, tokens, at, sessionLabel));
    for (const entry of entries) next[stateKey(row, entry.model)].hbAt = at;
    totals.input += tokens.input;
    totals.output += tokens.output;
  }
  // Retain baselines for rows that are temporarily missing from this snapshot.
  for (const [key, value] of Object.entries(baselines)) {
    if (seen.has(key) && !next[key]) next[key] = value;
  }
  return { heartbeats, baselines: next, skipped, totals };
}

function postGroups(heartbeats) {
  const groups = new Map();
  for (const heartbeat of heartbeats) {
    const key = `${heartbeat._hostname || ''}|${heartbeat._timezone || ''}|${heartbeat._platform || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(heartbeat);
  }
  return [...groups.values()];
}

function payloadOf(heartbeat) {
  const { _hostname, _platform, _timezone, ...payload } = heartbeat;
  return payload;
}

async function postHeartbeats({ settings, heartbeats, fetchImpl = fetch, version = '0.0.0', product = 'token-monitor' }) {
  const result = { posted: 0, failed: 0, statuses: [] };
  for (const group of postGroups(heartbeats)) {
    const meta = { hostname: group[0]._hostname, platform: group[0]._platform, timezone: group[0]._timezone };
    const payloads = group.map(payloadOf);
    // WakaTime can collapse identical entity+time heartbeats; sub-second spacing
    // keeps every session's counters distinct inside one batch.
    for (let index = 0; index < payloads.length; index++) {
      payloads[index] = { ...payloads[index], time: payloads[index].time + index * 0.001 };
    }
    for (let i = 0; i < payloads.length; i += BULK_LIMIT) {
      const chunk = payloads.slice(i, i + BULK_LIMIT);
      let attempt = 0;
      for (;;) {
        attempt++;
        try {
          const headers = {
            Authorization: `Basic ${Buffer.from(settings.apiKey).toString('base64')}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': userAgentFor({ platform: meta.platform, version, product }),
          };
          if (meta.hostname) headers['X-Machine-Name'] = encodeURIComponent(meta.hostname);
          if (meta.timezone) headers.Timezone = meta.timezone;
          const response = await fetchImpl(`${WAKATIME_API}/users/current/heartbeats.bulk`, {
            method: 'POST',
            headers,
            body: JSON.stringify(chunk),
          });
          result.statuses.push(response.status);
          if ((response.status === 429 || response.status === 302) && attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
            continue;
          }
          if (!response.ok) {
            const text = await response.text().catch(() => '');
            result.failed += chunk.length;
            result.message = `WakaTime ${response.status}: ${text.slice(0, 300)}`;
          } else {
            result.posted += chunk.length;
          }
          break;
        } catch (error) {
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
            continue;
          }
          result.failed += chunk.length;
          result.message = error.message;
          break;
        }
      }
    }
  }
  return result;
}

async function fetchTodayStats({ oauthToken, now = Date.now(), fetchImpl = fetch }) {
  // statusbar/today is the cached "today" summary the official CLI reads for
  // `--today`; stats/<range> rejects "today" as a range.
  const response = await fetchImpl(`${WAKATIME_API}/users/current/statusbar/today`, {
    headers: { Authorization: `Bearer ${oauthToken}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`WakaTime statusbar HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  const body = await response.json();
  const data = body && typeof body.data === 'object' && body.data ? body.data : body || {};
  const rows = value => (Array.isArray(value) ? value : [])
    .filter(item => item && item.name)
    .slice(0, 8)
    .map(item => ({ name: String(item.name), seconds: finite(item.total_seconds), text: typeof item.text === 'string' ? item.text : '' }));
  const grand = data.grand_total && typeof data.grand_total === 'object' ? data.grand_total : {};
  const categories = rows(data.categories);
  const ai = categories.find(item => /^ai( coding)?$/i.test(item.name));
  const breakdown = (Array.isArray(grand.ai_model_breakdown) ? grand.ai_model_breakdown : [])
    .filter(model => model && model.name)
    .slice(0, 6)
    .map(model => ({
      name: String(model.name),
      inputTokens: finite(model.input_tokens),
      cachedInputTokens: finite(model.cached_input_tokens),
      outputTokens: finite(model.output_tokens),
      costUsd: typeof model.cost === 'number' ? model.cost : null,
    }));
  return {
    totalSeconds: finite(grand.total_seconds),
    text: typeof grand.text === 'string' ? grand.text : '',
    aiSeconds: ai ? ai.seconds : 0,
    aiInputTokens: finite(grand.ai_input_tokens),
    aiCachedInputTokens: finite(grand.ai_cached_input_tokens),
    aiOutputTokens: finite(grand.ai_output_tokens),
    aiSessions: finite(grand.ai_sessions),
    aiModelCostUsd: typeof grand.ai_model_total_cost === 'number' ? grand.ai_model_total_cost : null,
    aiModels: breakdown,
    range: data.range && typeof data.range === 'object'
      ? { start: data.range.start, end: data.range.end, timezone: data.range.timezone }
      : null,
    categories,
    projects: rows(data.projects),
    machines: rows(data.machines),
    fetchedAt: now,
  };
}

module.exports = {
  WAKATIME_API,
  BULK_LIMIT,
  CATEGORIES,
  dayKey,
  diffRows,
  fetchTodayStats,
  modelEntries,
  postGroups,
  postHeartbeats,
  projectNameFor,
  sessionAnchor,
  stateKey,
  userAgentFor,
};
