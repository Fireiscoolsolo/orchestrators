#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash, randomUUID } = require('crypto');

const NAME = 'fable-orchestrator';
const SRC = path.resolve(__dirname, '..');
const SKILL = 'skills/' + NAME;
const MANIFEST = '.' + NAME + '-install.json';
const LOCK = '.' + NAME + '-install.lock';
const SKILL_FILES = /^(?:SKILL\.md|README\.md|config\.default\.yaml|(?:agents|references)\/[a-z0-9-]+\.md|templates\/[a-z0-9-]+\.yaml|scripts\/(?:tests\/)?[a-z0-9_.-]+\.cjs)$/;
const AGENT_FILE = /^agents\/fable-orchestrator-[a-z0-9-]+\.md$/;
const HASH = /^[a-f0-9]{64}$/;

function parse(argv) {
  const options = { project: null, user: false, agentsOnly: false, adoptIdentical: false, dryRun: false, uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project' && argv[i + 1] && !argv[i + 1].startsWith('--')) options.project = argv[++i];
    else if (arg === '--user') options.user = true;
    else if (arg === '--agents-only') options.agentsOnly = true;
    else if (arg === '--force') options.adoptIdentical = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--uninstall') options.uninstall = true;
    else throw new Error('Unknown or incomplete option: ' + arg);
  }
  if (Boolean(options.project) === options.user) {
    throw new Error('Usage: node install.cjs (--project <dir> | --user) [--agents-only] [--force] [--dry-run] [--uninstall]');
  }
  return options;
}

function stat(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

// Refuse symlinks and junctions anywhere below the selected project or home.
function directory(dir, create) {
  const info = stat(dir);
  if (info && !info.isDirectory()) throw new Error('Expected a regular directory at ' + dir);
  if (!info && create) fs.mkdirSync(dir);
  return Boolean(info || create);
}

function fileIn(base, relative, create = false) {
  const parts = relative.split('/');
  let parent = base;
  for (const part of parts.slice(0, -1)) {
    if (!directory(parent, create)) return null;
    parent = path.join(parent, part);
  }
  if (!directory(parent, create)) return null;
  return path.join(parent, parts.at(-1));
}

function readFile(file) {
  const info = file && stat(file);
  if (!info) return null;
  if (!info.isFile()) throw new Error('Expected a regular file at ' + file);
  return fs.readFileSync(file);
}

function checksum(bytes) {
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
}

function writeAtomic(file, bytes, replacing) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temp, 'wx');
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (replacing) fs.renameSync(temp, file);
    else {
      try { fs.linkSync(temp, file); } catch (error) {
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error.code)) throw error;
        // Some filesystems and managed environments disallow hard links.
        // Keep exclusive creation in the fallback, so an unrelated file is never replaced.
        fs.copyFileSync(temp, file, fs.constants.COPYFILE_EXCL);
      }
    }
  } finally {
    if (stat(temp)) fs.unlinkSync(temp);
  }
}

function managedPath(relative) {
  return AGENT_FILE.test(relative) || (relative.startsWith(SKILL + '/') && SKILL_FILES.test(relative.slice(SKILL.length + 1)));
}

function loadManifest(base) {
  const bytes = readFile(path.join(base, MANIFEST));
  if (!bytes) return { version: 1, files: {}, pending: null };
  const manifest = JSON.parse(bytes);
  if (!manifest || manifest.version !== 1 || !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object') {
    throw new Error('Invalid installation manifest');
  }
  for (const [relative, hash] of Object.entries(manifest.files)) {
    if (!managedPath(relative) || typeof hash !== 'string' || !HASH.test(hash)) throw new Error('Invalid installation manifest entry: ' + relative);
  }
  const pending = manifest.pending;
  if (pending !== null && (!pending || typeof pending.relative !== 'string' || !managedPath(pending.relative)
    || (pending.hash !== null && (typeof pending.hash !== 'string' || !HASH.test(pending.hash))))) {
    throw new Error('Invalid pending installation change');
  }
  return manifest;
}

function saveManifest(base, manifest, dryRun) {
  if (dryRun) return;
  const file = path.join(base, MANIFEST);
  if (!manifest.pending && Object.keys(manifest.files).length === 0) {
    if (readFile(file)) fs.unlinkSync(file);
    return;
  }
  writeAtomic(file, JSON.stringify(manifest, null, 2) + '\n', readFile(file) !== null);
}

function recordOwnership(manifest, relative, hash) {
  if (hash !== null) manifest.files[relative] = hash;
  else delete manifest.files[relative];
}

function recover(base, manifest, dryRun) {
  if (!manifest.pending) return;
  const { relative, hash } = manifest.pending;
  const actual = checksum(readFile(fileIn(base, relative)));
  if (actual === hash) recordOwnership(manifest, relative, hash);
  manifest.pending = null;
  saveManifest(base, manifest, dryRun);
}

function skillSources() {
  const files = new Map();
  for (const relative of ['SKILL.md', 'README.md', 'config.default.yaml']) {
    files.set(relative, fs.readFileSync(path.join(SRC, relative)));
  }
  for (const dir of ['agents', 'references', 'templates', 'scripts', 'scripts/tests']) {
    const abs = path.join(SRC, dir);
    if (!directory(abs, false)) continue;
    for (const item of fs.readdirSync(abs, { withFileTypes: true })) {
      const relative = dir + '/' + item.name;
      if (SKILL_FILES.test(relative) && item.isFile()) files.set(relative, fs.readFileSync(path.join(abs, item.name)));
    }
  }
  return files;
}

function installationFiles(options, base) {
  const sources = skillSources();
  const useSourceInPlace = fs.realpathSync.native(SRC) === path.join(base, 'skills', NAME);
  const files = new Map();
  for (const [relative, bytes] of sources) {
    if (!options.agentsOnly && !useSourceInPlace) files.set(SKILL + '/' + relative, bytes);
    if (!relative.startsWith('agents/')) continue;
    const role = path.basename(relative, '.md');
    const name = NAME + '-' + role;
    const source = bytes.toString('utf8');
    const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/.exec(source);
    const agentName = new RegExp('^name: ' + role + '\\r?$', 'm');
    if (!frontmatter || !agentName.test(frontmatter[0])) throw new Error('Unexpected agent definition: ' + relative);
    const renamed = frontmatter[0].replace(agentName, (line) => 'name: ' + name + (line.endsWith('\r') ? '\r' : ''));
    files.set('agents/' + name + '.md', Buffer.from(renamed + source.slice(frontmatter[0].length)));
  }
  return files;
}

function planFile(base, manifest, relative, bytes, options) {
  const current = checksum(readFile(fileIn(base, relative)));
  const next = checksum(bytes);
  const owner = manifest.files[relative];
  if (current === next) {
    if (next === null && owner) return { relative, next, action: 'forget missing file' };
    if (next !== null && !owner && options.adoptIdentical) return { relative, next, action: 'adopt identical file' };
    if (next !== null && !owner) return { relative, action: 'SKIPPED (identical untracked file; use --force to adopt it)', conflict: true };
    return { relative, action: 'up to date' };
  }
  if (current !== null && owner !== current) {
    return { relative, action: owner ? 'SKIPPED (file was changed after installation)' : 'SKIPPED (untracked file)', conflict: true };
  }
  return { relative, action: next === null ? 'remove' : (current === null ? 'install' : 'update'), current, next, bytes };
}

function changeFile(base, manifest, change, options) {
  const { relative, current, next, bytes, action } = change;
  console.log((options.dryRun ? '[dry-run] ' : '') + relative + ': ' + action);
  if (options.dryRun || !Object.hasOwn(change, 'next')) return;
  if (Object.hasOwn(change, 'current')) {
    const file = fileIn(base, relative, next !== null);
    if (checksum(readFile(file)) !== current) throw new Error('File changed while preparing installation: ' + relative);
    manifest.pending = { relative, hash: next };
    saveManifest(base, manifest, false);
    if (next === null) fs.unlinkSync(file);
    else writeAtomic(file, bytes, current !== null);
    manifest.pending = null;
  }
  recordOwnership(manifest, relative, next);
  saveManifest(base, manifest, false);
}

function apply(base, options) {
  const manifest = loadManifest(base);
  recover(base, manifest, options.dryRun);
  const files = options.uninstall ? new Map() : installationFiles(options, base);
  if (options.uninstall) {
    for (const relative of Object.keys(manifest.files)) {
      if (!options.agentsOnly || AGENT_FILE.test(relative)) files.set(relative, null);
    }
    if (files.size === 0) console.log('No managed files to uninstall. Untracked files are kept.');
  } else {
    for (const relative of Object.keys(manifest.files)) {
      if (AGENT_FILE.test(relative) && !files.has(relative)) files.set(relative, null);
    }
  }
  const changes = Array.from(files, ([relative, bytes]) => planFile(base, manifest, relative, bytes, options));
  const skillConflict = !options.uninstall && changes.some((change) => change.relative.startsWith(SKILL + '/') && change.conflict);
  if (skillConflict) console.log('Skill files were kept together because one or more already exists or was modified.');
  for (const change of changes) {
    if (!skillConflict || !change.relative.startsWith(SKILL + '/') || change.conflict) changeFile(base, manifest, change, options);
  }
  if (!options.uninstall) console.log('Restart Claude Code if this project did not previously have a user or project skill and agent directory.');
}

function main() {
  const options = parse(process.argv.slice(2));
  const folder = fs.realpathSync.native(options.project || os.homedir());
  if (!fs.statSync(folder).isDirectory()) throw new Error('Project path must name a directory');
  const base = path.join(folder, '.claude');
  const exists = directory(base, false);
  if (options.dryRun || (options.uninstall && !exists)) {
    apply(base, options);
    return;
  }
  directory(base, true);
  const lock = path.join(base, LOCK);
  const owner = process.pid + ' ' + randomUUID() + '\n';
  try {
    fs.writeFileSync(lock, owner, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('An installation lock already exists at ' + lock + '. Confirm its owner has stopped before removing the lock.');
  }
  try { apply(base, options); } finally {
    if (readFile(lock)?.toString('utf8') === owner) fs.unlinkSync(lock);
  }
}

try { main(); } catch (error) {
  console.error('Install failed: ' + error.message);
  process.exitCode = 1;
}
