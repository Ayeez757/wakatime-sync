'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bridge = require('../hub-bridge/bridge.js');

const SECRET = 'bridge-secret';

const stats = () => ({
  devices: [
    {
      deviceId: 'dev-win',
      hostname: 'AYEEZ-THINKBOOK',
      platform: 'win32-x64',
      periods: {
        today: {
          sessions: {
            'codex:rollout-1': {
              client: 'codex',
              sessionId: 'rollout-1',
              startedAt: '2026-11-08T10:00:00.000Z',
              lastUsedAt: '2026-11-08T10:05:00.000Z',
              totalTokens: 1000,
              inputTokens: 300,
              outputTokens: 100,
              cacheReadTokens: 600,
              cacheWriteTokens: 0,
              projectLabel: 'backend',
              projectId: 'sha256:abc',
              models: { 'gpt-6.1-sol': 1000 },
              modelTokenComponents: {
                'gpt-6.1-sol': { totalTokens: 1000, inputTokens: 300, cacheReadTokens: 600, cacheWriteTokens: 0, outputTokens: 100 },
              },
            },
          },
        },
      },
    },
    { deviceId: 'dev-idle', hostname: 'idle-box', platform: 'linux-x64', sessionDetailsOmitted: { today: true }, periods: { today: { sessions: {} } } },
  ],
});

test('deviceRows normalizes Hub sessions with per-device transport metadata', () => {
  const config = { devices: [], projectPrefix: '', projectOverrides: {}, timezone: 'Asia/Shanghai' };
  const { rows, partial } = bridge.deviceRows(config, stats());
  const row = rows.find(item => item.id === 'codex:rollout-1');
  assert.ok(row);
  assert.equal(row.client, 'codex');
  assert.equal(row.deviceId, 'dev-win');
  assert.equal(row.hostname, 'AYEEZ-THINKBOOK');
  assert.equal(row.platform, 'win32-x64');
  assert.equal(row.timezone, 'Asia/Shanghai');
  assert.equal(row.projectLabel, 'backend');
  assert.equal(row.models[0].tokenComponents.outputTokens, 100);
  assert.deepEqual(partial, ['dev-idle']);
});

test('deviceRows honors the devices filter and project overrides', () => {
  const config = {
    devices: ['dev-win'],
    projectPrefix: 'ai-',
    projectOverrides: { backends: 'renamed', 'sha256:abc': 'renamed' },
    timezone: 'Asia/Shanghai',
  };
  const { rows } = bridge.deviceRows(config, stats());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projectLabel, 'renamed');
});

test('loadState migrates v1 baselines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-bridge-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, date: '2026-11-08', baselines: { old: { input: 1, output: 1, total: 2 } } }));
  const state = bridge.loadState(file);
  assert.equal(state.version, 2);
  assert.deepEqual(state.baselines, {});
});

test('presence endpoint authenticates, records plugins and reports runtime', async () => {
  const port = 17421;
  const plugins = [];
  const presence = bridge.createPresenceServer({ hubSecret: SECRET }, { value: () => ({ lastTickAt: 'now' }) });
  await new Promise(resolve => presence.server.listen(port, '127.0.0.1', resolve));
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/presence`);
    assert.equal(unauthorized.status, 401);

    const hello = await fetch(`http://127.0.0.1:${port}/presence/plugin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname: 'MYPC', version: '0.4.0' }),
    });
    const helloBody = await hello.json();
    assert.equal(helloBody.takeOver, true);

    const info = await fetch(`http://127.0.0.1:${port}/presence`, { headers: { Authorization: `Bearer ${SECRET}` } });
    const body = await info.json();
    assert.equal(body.role, 'hub-bridge');
    assert.equal(body.version, bridge.BRIDGE_VERSION);
    assert.equal(body.plugins.length, 1);
    assert.equal(body.plugins[0].hostname, 'MYPC');
    assert.ok(typeof body.plugins[0].ageMs === 'number');
    assert.equal(body.runtime.lastTickAt, 'now');
    plugins.push(...presence.plugins.keys());
  } finally {
    await new Promise(resolve => presence.server.close(resolve));
  }
  assert.deepEqual(plugins, ['MYPC']);
});

test('presence entries expire after the TTL', async () => {
  const port = 17422;
  const presence = bridge.createPresenceServer({ hubSecret: SECRET }, { value: () => ({}) });
  presence.plugins.set('STALE', { hostname: 'STALE', version: '0.1.0', at: new Date().toISOString(), seenAt: Date.now() - 2 * 60 * 60 * 1000 });
  await new Promise(resolve => presence.server.listen(port, '127.0.0.1', resolve));
  try {
    const info = await fetch(`http://127.0.0.1:${port}/presence`, { headers: { Authorization: `Bearer ${SECRET}` } });
    const body = await info.json();
    assert.equal(body.plugins.length, 0);
  } finally {
    await new Promise(resolve => presence.server.close(resolve));
  }
});
