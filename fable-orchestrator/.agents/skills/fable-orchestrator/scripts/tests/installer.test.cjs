'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const source = path.resolve(__dirname, '..', '..');
const agent = 'fable-orchestrator-review-worker.md';

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-installer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function exec(sourceDir, target, ...args) {
  return spawnSync(process.execPath, [path.join(sourceDir, 'scripts', 'install.cjs'), '--project', target, ...args], { encoding: 'utf8' });
}

function run(sourceDir, target, ...args) {
  const result = exec(sourceDir, target, ...args);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function hash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('dry run creates no files and real install namespaces the filename and registered agent name', (t) => {
  const target = sandbox(t);
  const agentDir = path.join(target, '.claude', 'agents');
  const oldAgent = path.join(agentDir, 'review-worker.md');
  assert.match(run(source, target, '--dry-run'), /\[dry-run\].*fable-orchestrator-review-worker\.md: install/);
  assert.ok(!fs.existsSync(path.join(target, '.claude')));

  write(oldAgent, 'existing generic reviewer');
  run(source, target);
  assert.equal(fs.readFileSync(oldAgent, 'utf8'), 'existing generic reviewer');
  assert.match(fs.readFileSync(path.join(agentDir, agent), 'utf8'), /^name: fable-orchestrator-review-worker\r?$/m);
  assert.match(run(source, target), /fable-orchestrator-review-worker\.md: up to date/);
});

test('uninstall preserves edits, legacy files, and untracked files, including with force', (t) => {
  const target = sandbox(t);
  run(source, target);
  const base = path.join(target, '.claude');
  const skill = path.join(base, 'skills', 'fable-orchestrator');
  const agentDir = path.join(base, 'agents');
  const reviewer = path.join(agentDir, agent);
  const legacy = path.join(agentDir, 'review-worker.md');
  const additions = path.join(skill, 'my-notes.md');
  write(reviewer, 'local changes');
  write(legacy, '# managed-by: fable-orchestrator\nlegacy reviewer');
  write(additions, 'local notes');

  assert.match(run(source, target, '--force'), /review-worker\.md: SKIPPED \(file was changed/);
  assert.match(run(source, target, '--uninstall', '--dry-run'), /\[dry-run\].*SKILL\.md: remove/);
  assert.ok(fs.existsSync(path.join(skill, 'SKILL.md')));
  run(source, target, '--uninstall', '--force');
  assert.ok(!fs.existsSync(path.join(skill, 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(agentDir, 'fable-orchestrator-test-worker.md')));
  assert.equal(fs.readFileSync(reviewer, 'utf8'), 'local changes');
  assert.equal(fs.readFileSync(additions, 'utf8'), 'local notes');
  assert.match(fs.readFileSync(legacy, 'utf8'), /legacy reviewer/);
});

test('safe update upgrades unchanged files and preserves the entire skill when one file conflicts', (t) => {
  const target = sandbox(t);
  const nextVersion = sandbox(t);
  fs.cpSync(source, nextVersion, { recursive: true });
  run(source, target);

  const installed = path.join(target, '.claude', 'skills', 'fable-orchestrator');
  write(path.join(nextVersion, 'README.md'), 'new guide');
  write(path.join(nextVersion, 'SKILL.md'), 'new skill');
  write(path.join(installed, 'SKILL.md'), 'local instructions');
  const readme = hash(path.join(installed, 'README.md'));
  assert.match(run(nextVersion, target), /Skill files were kept together/);
  assert.equal(hash(path.join(installed, 'README.md')), readme);
  assert.equal(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), 'local instructions');

  fs.copyFileSync(path.join(source, 'SKILL.md'), path.join(installed, 'SKILL.md'));
  run(nextVersion, target);
  assert.equal(fs.readFileSync(path.join(installed, 'README.md'), 'utf8'), 'new guide');
  assert.equal(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), 'new skill');
});

test('force adopts identical files only and agents-only uninstall leaves the skill installed', (t) => {
  const target = sandbox(t);
  const from = sandbox(t);
  run(source, from);
  const base = path.join(target, '.claude');
  const reviewer = path.join(base, 'agents', agent);
  write(reviewer, fs.readFileSync(path.join(from, '.claude', 'agents', agent)));
  const conflict = path.join(base, 'agents', 'fable-orchestrator-test-worker.md');
  write(conflict, 'my testing instructions');

  assert.match(run(source, target), /identical untracked file/);
  assert.match(run(source, target, '--force'), /review-worker\.md: adopt identical file/);
  assert.equal(fs.readFileSync(conflict, 'utf8'), 'my testing instructions');
  run(source, target, '--agents-only', '--uninstall');
  assert.ok(!fs.existsSync(reviewer));
  assert.ok(fs.existsSync(path.join(base, 'skills', 'fable-orchestrator', 'SKILL.md')));
  assert.equal(fs.readFileSync(conflict, 'utf8'), 'my testing instructions');
});

test('recovers ownership when a file update completed before manifest finalization', (t) => {
  const target = sandbox(t);
  const installed = sandbox(t);
  run(source, installed, '--agents-only');
  const relative = 'agents/' + agent;
  const base = path.join(target, '.claude');
  const file = path.join(base, relative);
  write(file, fs.readFileSync(path.join(installed, '.claude', relative)));
  write(path.join(base, '.fable-orchestrator-install.json'), JSON.stringify({
    version: 1, files: {}, pending: { relative, hash: hash(file) },
  }));
  run(source, target, '--uninstall');
  assert.ok(!fs.existsSync(file));
  assert.ok(!fs.existsSync(path.join(base, '.fable-orchestrator-install.json')));
});

test('an invalid manifest cannot target unrelated files and an active installer prevents writes', (t) => {
  const target = sandbox(t);
  const base = path.join(target, '.claude');
  const sentinel = path.join(target, 'notes.md');
  const lock = path.join(base, '.fable-orchestrator-install.lock');
  write(sentinel, 'keep me');
  write(lock, 'another installer');
  assert.match(exec(source, target).stderr, /installation lock already exists/);
  assert.ok(!fs.existsSync(path.join(base, 'skills')));
  fs.unlinkSync(lock);
  write(path.join(base, '.fable-orchestrator-install.json'), JSON.stringify({
    version: 1, files: { '../notes.md': hash(sentinel) }, pending: null,
  }));
  const result = exec(source, target, '--uninstall');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid installation manifest entry/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep me');
});

test('refuses a redirected agent directory without writing to its target', (t) => {
  const target = sandbox(t);
  const elsewhere = sandbox(t);
  fs.mkdirSync(path.join(target, '.claude'));
  try {
    fs.symlinkSync(elsewhere, path.join(target, '.claude', 'agents'), 'junction');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
    t.skip('The environment does not permit creating a directory link');
    return;
  }
  const result = exec(source, target, '--agents-only');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Expected a regular directory/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});
