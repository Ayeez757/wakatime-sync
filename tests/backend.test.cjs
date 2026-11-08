'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const backend = require('../backend.cjs');
const bridge = require('../hub-bridge/bridge.js');

const LOCAL_HOST = os.hostname();
const SECRET = 'test-secret';

function sessionRow({ id, client = 'codex', deviceId, projectId = 'proj-1', startedAt = '2026-11-08T10:00:00.000Z' }) {
  return {
    id,
    client,
    deviceId,
    startedAt,
    lastUsedAt: new Date().toISOString(),
    projectId,
    projectPath: 'sha256:abc',
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
  };
}

function makeHost({ settings, devices, sessionsByDevice, pages = null }) {
  return {
    async call(method, arg) {
      if (method === 'settings.get') {
        return {
          status: 'ready',
          values: {
            enabled: true, apiKey: 'k', oauthToken: '', projectPrefix: '', pollSeconds: 30, dryRun: true,
            scope: 'auto', category: 'ai coding', includeCacheTokens: true, projectMode: 'label',
            preferHub: false, hubBridgeUrl: '',
            ...settings,
          },
        };
      }
      if (method === 'app.settings') return { hubUrl: 'http://100.95.190.88:17321', secret: SECRET };
      if (method === 'data.query') {
        const resource = arg.resource;
        if (resource === 'devices') return { availability: 'available', rows: devices, pageInfo: { hasMore: false } };
        if (resource === 'projects') return { availability: 'available', rows: [{ id: 'proj-1', label: 'backend' }], pageInfo: { hasMore: false } };
        if (resource === 'sessions') {
          if (pages) {
            const page = arg.page || {};
            const index = page.cursor ? Number(page.cursor) : 0;
            return {
              availability: 'available',
              rows: pages[index] || [],
              pageInfo: { hasMore: index + 1 < pages.length, nextCursor: index + 1 < pages.length ? String(index + 1) : null },
            };
          }
          const deviceId = arg.filter && arg.filter.deviceId;
          const rows = deviceId ? sessionsByDevice[deviceId] || [] : Object.values(sessionsByDevice).flat();
          return { availability: 'available', rows, pageInfo: { hasMore: false } };
        }
      }
      throw new Error('unexpected host call ' + method);
    },
  };
}

async function startPresence(port) {
  const runtime = { value: () => ({}) };
  const presence = bridge.createPresenceServer({ hubSecret: SECRET }, runtime);
  await new Promise(resolve => presence.server.listen(port, '127.0.0.1', resolve));
  return presence;
}

test('auto scope baselines only this machine on a shared Hub', async () => {
  const devices = [
    { id: 'dev-other', hostname: 'OTHERBOX', displayName: 'OTHERBOX' },
    { id: 'dev-local', hostname: LOCAL_HOST, displayName: LOCAL_HOST },
  ];
  const sessionsByDevice = {
    'dev-other': [sessionRow({ id: 'other-session', deviceId: 'dev-other' })],
    'dev-local': [sessionRow({ id: 'local-session', deviceId: 'dev-local' })],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-backend-'));
  const messages = [];
  const instance = await backend.activate({
    dataDirectory: dir,
    host: makeHost({ devices, sessionsByDevice }),
    publish: value => messages.push(value),
    log: () => {},
  });
  const status = await instance.call('refresh');
  instance.dispose();
  assert.equal(status.scope.mode, 'this-device');
  assert.equal(status.scope.label, LOCAL_HOST);
  assert.equal(status.baselines, 1);
  assert.equal(status.truncated, false);
});

test('unmatched hostname on a multi-device Hub fails closed', async () => {
  const devices = [
    { id: 'dev-a', hostname: 'BOX-A', displayName: 'BOX-A' },
    { id: 'dev-b', hostname: 'BOX-B', displayName: 'BOX-B' },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-backend-'));
  const instance = await backend.activate({
    dataDirectory: dir,
    host: makeHost({ devices, sessionsByDevice: {} }),
    publish: () => {},
    log: () => {},
  });
  const status = await instance.call('refresh');
  instance.dispose();
  assert.equal(status.state, 'scope-unresolved');
  assert.equal(status.baselines, 0);
  assert.match(status.lastError, /No Hub device matches hostname/);
});

test('a single-device Hub (or local mode) still uploads', async () => {
  const devices = [{ id: 'dev-only', hostname: 'SOMEWHERE', displayName: 'SOMEWHERE' }];
  const sessionsByDevice = { 'dev-only': [sessionRow({ id: 'only-session', deviceId: 'dev-only' })] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-backend-'));
  const instance = await backend.activate({
    dataDirectory: dir,
    host: makeHost({ devices, sessionsByDevice }),
    publish: () => {},
    log: () => {},
  });
  const status = await instance.call('refresh');
  instance.dispose();
  assert.equal(status.scope.mode, 'aggregate-single');
  assert.equal(status.baselines, 1);
});

test('pagination truncation is surfaced', async () => {
  const pages = Array.from({ length: 25 }, (_, index) => [sessionRow({ id: `session-${index}`, deviceId: null, startedAt: `2026-11-08T10:00:${String(index).padStart(2, '0')}.000Z` })]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-backend-'));
  const instance = await backend.activate({
    dataDirectory: dir,
    host: makeHost({ devices: [{ id: 'dev-only', hostname: 'OTHER', displayName: 'OTHER' }], sessionsByDevice: {}, pages }),
    publish: () => {},
    log: () => {},
  });
  const status = await instance.call('refresh');
  instance.dispose();
  assert.equal(status.truncated, true);
});

test('hub bridge presence makes the plugin stand by', async () => {
  const port = 17411;
  const presence = await startPresence(port);
  const devices = [{ id: 'dev-only', hostname: LOCAL_HOST, displayName: LOCAL_HOST }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-backend-'));
  const instance = await backend.activate({
    dataDirectory: dir,
    host: makeHost({
      settings: { preferHub: true, hubBridgeUrl: `http://127.0.0.1:${port}` },
      devices,
      sessionsByDevice: { 'dev-only': [sessionRow({ id: 'held-session', deviceId: 'dev-only' })] },
    }),
    publish: () => {},
    log: () => {},
  });
  const status = await instance.call('refresh');
  instance.dispose();
  await new Promise(resolve => presence.server.close(resolve));
  assert.equal(status.state, 'hub-active');
  assert.equal(status.delegation.mode, 'hub-active');
  assert.equal(status.baselines, 0);
});

test('an unreachable bridge falls back to local uploads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-backend-'));
  const instance = await backend.activate({
    dataDirectory: dir,
    host: makeHost({
      settings: { preferHub: true, hubBridgeUrl: 'http://127.0.0.1:17412' },
      devices: [{ id: 'dev-only', hostname: LOCAL_HOST, displayName: LOCAL_HOST }],
      sessionsByDevice: { 'dev-only': [sessionRow({ id: 'fallback-session', deviceId: 'dev-only' })] },
    }),
    publish: () => {},
    log: () => {},
  });
  const status = await instance.call('refresh');
  instance.dispose();
  assert.equal(status.delegation.mode, 'bridge-unreachable');
  assert.equal(status.baselines, 1);
});

test('state v1 is migrated to stable baselines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-backend-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 1,
    date: new Date().toISOString().slice(0, 10),
    baselines: { 'dev|opaque|gpt': { input: 10, output: 1, total: 11, at: Date.now() } },
    counters: { heartbeats: 3, input: 10, output: 1 },
    lastPostAt: null,
  }), { mode: 0o600 });
  const instance = await backend.activate({
    dataDirectory: dir,
    host: makeHost({
      devices: [{ id: 'dev-only', hostname: LOCAL_HOST, displayName: LOCAL_HOST }],
      sessionsByDevice: { 'dev-only': [sessionRow({ id: 'migrated', deviceId: 'dev-only' })] },
    }),
    publish: () => {},
    log: () => {},
  });
  await instance.call('refresh');
  instance.dispose();
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(stored.version, 2);
  assert.ok(!Object.keys(stored.baselines).some(key => key.includes('|opaque|')));
  assert.equal(stored.counters.heartbeats, 3);
});
