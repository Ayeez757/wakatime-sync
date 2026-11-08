'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/wakatime-core.cjs');

const token = process.env.WAKATIME_OAUTH_TOKEN;

test('live statusbar/today parses AI coding counters', { skip: !token && 'set WAKATIME_OAUTH_TOKEN to run' }, async () => {
  const stats = await core.fetchTodayStats({ oauthToken: token });
  assert.ok(Number.isFinite(stats.totalSeconds));
  assert.ok(Array.isArray(stats.categories));
  assert.ok(stats.categories.length > 0 || stats.totalSeconds === 0);
  assert.ok(Array.isArray(stats.aiModels));
});

test('live OAUTH token is rejected without read scope', { skip: !process.env.WAKATIME_API_KEY && 'set WAKATIME_API_KEY to run' }, async () => {
  await assert.rejects(
    core.fetchTodayStats({ oauthToken: process.env.WAKATIME_API_KEY }),
    /401|403/,
  );
});
