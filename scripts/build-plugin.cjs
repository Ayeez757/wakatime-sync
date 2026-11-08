#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const dist = path.join(root, 'dist');
const output = path.join(dist, `${manifest.id}-${manifest.version}.tmplugin`);
const tmRepo = process.env.TM_REPO || '/home/ayeez/token-monitor';
const builder = path.join(tmRepo, 'scripts/build-plugin-package.js');

if (!fs.existsSync(builder)) {
  console.error(`Token Monitor checkout not found at ${tmRepo}. Set TM_REPO to a checkout with scripts/build-plugin-package.js.`);
  process.exit(1);
}
fs.mkdirSync(dist, { recursive: true });
if (fs.existsSync(output)) {
  if (!process.argv.includes('--force')) {
    console.error(`${path.relative(root, output)} already exists. Bump the manifest version or pass --force.`);
    process.exit(1);
  }
  fs.rmSync(output);
}
const result = spawnSync(process.execPath, [builder, root, output], { encoding: 'utf8' });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.status !== 0) process.exit(result.status || 1);
console.log(`built ${path.relative(root, output)}`);
