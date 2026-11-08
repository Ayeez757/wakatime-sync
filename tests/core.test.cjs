'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/wakatime-core.cjs');

const session = () => ({
  id: 'row-1',
  client: 'codex',
  deviceId: 'dev-1',
  startedAt: '2026-11-08T10:00:00.000Z',
  lastUsedAt: new Date().toISOString(),
  projectLabel: 'PianoPath',
  projectPath: 'D:\\Develop\\project\\PianoPath',
  totalTokens: 1000,
  inputTokens: 300,
  outputTokens: 100,
  cacheReadTokens: 600,
  cacheWriteTokens: 0,
  models: [{
    model: 'gpt-6.1-sol',
    totalTokens: 1000,
    tokenComponents: { totalTokens: 1000, inputTokens: 300, cacheReadTokens: 600, cacheWriteTokens: 0, outputTokens: 100 },
  }],
});

const baseSettings = {
  category: 'ai coding',
  includeCacheTokens: true,
  projectMode: 'label',
  projectPrefix: '',
  hostname: 'TESTBOX',
  platform: 'linux-x64',
  timezone: 'Asia/Shanghai',
};

test('cached input tokens follow the includeCacheTokens switch', () => {
  const row = session();
  const withCache = core.modelEntries(row, { includeCacheTokens: true })[0];
  const withoutCache = core.modelEntries(row, { includeCacheTokens: false })[0];
  assert.equal(withCache.input, 300);
  assert.equal(withCache.cacheRead, 600);
  assert.equal(withoutCache.cacheRead, 0);
  assert.equal(withCache.output, 100);
});

test('project naming modes', () => {
  const row = session();
  assert.equal(core.projectNameFor({ projectMode: 'label' }, row), 'PianoPath');
  assert.equal(core.projectNameFor({ projectMode: 'folder' }, row), 'PianoPath');
  assert.equal(core.projectNameFor({ projectMode: 'none' }, row), '');
  assert.equal(core.projectNameFor({ projectMode: 'folder', projectPrefix: 'ai-' }, row), 'ai-PianoPath');
  assert.equal(core.projectNameFor({ projectMode: 'label' }, { projectLabel: '', projectPath: 'sha256:abc' }), '');
  assert.equal(core.projectNameFor({ projectMode: 'folder' }, { projectLabel: 'backend', projectPath: '/home/x/backend' }), 'backend');
});

test('baselines use the stable session anchor, not the opaque row id', () => {
  const row = session();
  const key = core.stateKey(row, 'gpt-6.1-sol');
  assert.match(key, /dev-1\|codex\|2026-11-08T10:00:00.000Z\|gpt-6\.1-sol/);
  const restarted = { ...row, id: 'row-restarted-opaque-id' };
  assert.equal(core.stateKey(restarted, 'gpt-6.1-sol'), key);
});

test('diffs emit one heartbeat per session with summed model deltas', () => {
  const row = session();
  const settings = { ...baseSettings };
  const first = core.diffRows({ settings, rows: [row], baselines: {} });
  assert.equal(first.heartbeats.length, 0);
  assert.equal(first.skipped, 1);

  row.models[0].totalTokens = 1500;
  row.models[0].tokenComponents = { totalTokens: 1500, inputTokens: 700, cacheReadTokens: 600, cacheWriteTokens: 0, outputTokens: 200 };
  const second = core.diffRows({ settings, rows: [row], baselines: first.baselines });
  assert.equal(second.heartbeats.length, 1);
  const heartbeat = second.heartbeats[0];
  // baseline input = 300 + 600 cache read; after = 700 + 600 -> delta 400.
  assert.equal(heartbeat.ai_input_tokens, 400);
  assert.equal(heartbeat.ai_output_tokens, 100);
  assert.equal(heartbeat.project, 'PianoPath');
  assert.equal(heartbeat._hostname, 'TESTBOX');
  assert.equal(heartbeat._timezone, 'Asia/Shanghai');
});

test('regressions do not produce negative heartbeats', () => {
  const row = session();
  const settings = { ...baseSettings };
  const first = core.diffRows({ settings, rows: [row], baselines: {} });
  row.models[0].totalTokens = 10;
  row.models[0].tokenComponents = { totalTokens: 10, inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 };
  const second = core.diffRows({ settings, rows: [row], baselines: first.baselines });
  assert.equal(second.heartbeats.length, 0);
  assert.equal(second.skipped, 1);
});

test('user agent carries the supplied version and no AI model token', () => {
  const ua = core.userAgentFor({ platform: 'win32-x64', version: '9.9.9' });
  assert.match(ua, /^wakatime\/13\.0\.0 \(win32-x64\) node\/\S+ token-monitor\/9\.9\.9$/);
  const bridgeUa = core.userAgentFor({ platform: 'linux-x64', version: '0.4.0', product: 'token-monitor' });
  assert.ok(!/gpt|claude|deepseek/i.test(bridgeUa));
});

test('heartbeats are posted with machine headers and stripped transport fields', async () => {
  const settings = { ...baseSettings };
  const row = session();
  const first = core.diffRows({ settings, rows: [row], baselines: {} });
  row.models[0].totalTokens = 2000;
  row.models[0].tokenComponents = { totalTokens: 2000, inputTokens: 1300, cacheReadTokens: 600, cacheWriteTokens: 0, outputTokens: 300 };
  const second = core.diffRows({ settings, rows: [row], baselines: first.baselines });

  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 201, text: async () => '' };
  };
  const result = await core.postHeartbeats({ settings: { ...settings, apiKey: 'k' }, heartbeats: second.heartbeats, fetchImpl: fakeFetch, version: '0.4.0' });
  assert.equal(result.posted, 1);
  const call = calls[0];
  assert.equal(call.headers['X-Machine-Name'], 'TESTBOX');
  assert.equal(call.headers.Timezone, 'Asia/Shanghai');
  assert.match(call.headers['User-Agent'], /token-monitor\/0\.4\.0$/);
  assert.ok(!('_hostname' in call.body[0]));
  assert.ok(!('_timezone' in call.body[0]));
  assert.equal(call.body[0].category, 'ai coding');
});

test('same-second heartbeats get distinct sub-second times', async () => {
  const settings = { ...baseSettings };
  const heartbeats = [0, 1, 2].map(index => ({
    entity: 'token-monitor:codex',
    category: 'ai coding',
    time: 1000,
    ai_session: `session-${index}`,
    ai_input_tokens: 10,
    ai_output_tokens: 5,
    _hostname: 'TESTBOX',
    _platform: 'linux-x64',
    _timezone: 'Asia/Shanghai',
  }));
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 201, text: async () => '' };
  };
  await core.postHeartbeats({ settings: { ...settings, apiKey: 'k' }, heartbeats, fetchImpl: fakeFetch, version: '0.4.0' });
  const times = calls[0].map(heartbeat => heartbeat.time);
  assert.deepEqual(times, [1000, 1000.001, 1000.002]);
});
