#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const failures = [];
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(cjs|mjs|js)$/.test(entry.name)) checkSyntax(full);
  }
};

function checkSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push(`syntax: ${path.relative(root, file)}\n${result.stderr.trim()}`);
}

function checkManifest() {
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const problems = [];
  if (manifest.tmApi !== 1) problems.push('tmApi must be 1');
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(manifest.id || '')) problems.push('invalid id');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) problems.push('version must be SemVer');
  if (!Array.isArray(manifest.files) || !manifest.files.length) problems.push('files list missing');
  for (const file of manifest.files || []) {
    if (!fs.existsSync(path.join(root, file))) problems.push(`declared file missing: ${file}`);
  }
  for (const file of ['manifest.json', manifest.ui, manifest.backend, ...(manifest.css || [])].filter(Boolean)) {
    if (!fs.existsSync(path.join(root, file))) problems.push(`entry missing: ${file}`);
    if (manifest.files && !manifest.files.includes(file) && file !== 'manifest.json') problems.push(`entry not declared in files: ${file}`);
  }
  const settings = manifest.settings;
  if (settings) {
    if (!Number.isSafeInteger(settings.version) || settings.version < 1) problems.push('settings.version invalid');
    const ids = new Set();
    for (const field of settings.fields || []) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(field.id || '')) problems.push(`invalid settings id: ${field.id}`);
      if (ids.has(field.id)) problems.push(`duplicate settings id: ${field.id}`);
      ids.add(field.id);
      if (!Object.hasOwn(field, 'default')) problems.push(`settings default missing: ${field.id}`);
      if (field.type === 'select' && !(field.options || []).some(option => option.value === field.default)) {
        problems.push(`select default not an option: ${field.id}`);
      }
    }
  }
  if (problems.length) failures.push(`manifest:\n - ${problems.join('\n - ')}`);
  return manifest;
}

function checkSecrets(manifest) {
  const suspect = [
    { name: 'WakaTime API key', re: /waka_[0-9a-f]{8}-[0-9a-f]{4}-/i },
    { name: 'WakaTime OAuth token', re: /waka_tok_[A-Za-z0-9_-]{16,}/ },
    { name: 'Hub secret value', re: /TOKEN_MONITOR_SECRET\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/ },
    { name: 'Private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  ];
  const scan = (file) => {
    const relative = path.relative(root, file);
    if (relative === 'scripts/check.cjs') return;
    const text = fs.readFileSync(file, 'utf8');
    for (const { name, re } of suspect) {
      if (re.test(text)) failures.push(`secret (${name}) in ${relative}`);
    }
  };
  const walkText = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walkText(full);
      else if (/\.(cjs|mjs|js|json|md|yml|yaml|example)$/.test(entry.name) || entry.name === 'config.example.json') scan(full);
    }
  };
  walkText(root);
  if (manifest.files.includes('config.json')) failures.push('config.json must not be packaged or committed');
}

const manifest = checkManifest();
walk(root);
checkSecrets(manifest);
if (failures.length) {
  console.error(failures.join('\n\n'));
  process.exitCode = 1;
} else {
  console.log(`check ok: ${manifest.id}@${manifest.version} · ${manifest.files.length} packaged files`);
}
