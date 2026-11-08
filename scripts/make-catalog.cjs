#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const packagePath = path.join(root, 'dist', `${manifest.id}-${manifest.version}.tmplugin`);
if (!fs.existsSync(packagePath)) {
  console.error(`Missing ${path.relative(root, packagePath)}; run npm run build first.`);
  process.exit(1);
}
const catalogPath = path.join(root, 'catalog.json');
const repository = 'https://github.com/Ayeez757/wakatime-sync';
const url = `https://raw.githubusercontent.com/Ayeez757/wakatime-sync/main/dist/${path.basename(packagePath)}`;
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(packagePath)).digest('hex');

const catalog = fs.existsSync(catalogPath)
  ? JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  : { format: 1, title: { en: 'Ayeez757 plugins', 'zh-CN': 'Ayeez757 插件' }, plugins: [] };

let entry = catalog.plugins.find(plugin => plugin.id === manifest.id);
if (!entry) {
  entry = { id: manifest.id, name: manifest.name, description: manifest.description, author: manifest.author, versions: [] };
  catalog.plugins.push(entry);
}
entry.name = manifest.name;
entry.description = manifest.description;
entry.author = manifest.author;
entry.repository = repository;
entry.versions = entry.versions.filter(version => version.version !== manifest.version);
entry.versions.unshift({
  version: manifest.version,
  types: ['widget', 'page', 'automation'],
  url,
  sha256,
  engines: manifest.engines || { tokenMonitor: '>=0.82.0' },
  changelog: `See ${repository}/blob/main/CHANGELOG.md`,
});
fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`catalog.json updated: ${manifest.id}@${manifest.version} sha256=${sha256}`);
