'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INSTALL = path.resolve(__dirname, '..', 'scripts', 'install.cjs');
const RUN_TESTS = path.resolve(__dirname, '..', 'scripts', 'run_tests.cjs');

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oo-install-'));
  tmpDirs.push(d);
  return d;
}
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const AGENT = (n, extra) => `---\nname: ${n}\ndescription: d\ntools: Read\nmodel: opus\n---\n${extra || 'body'}\n`;

// Builds a skill fixture containing a copy of install.cjs so that __dirname resolves to the fixture.
function makeSkill(root, opts = {}) {
  const s = path.join(root, 'src-skill');
  write(path.join(s, 'SKILL.md'), opts.skillMd || '---\nname: opus-orchestrator\ndescription: something\n---\nSee references/a.md and scripts/x.cjs.\n');
  write(path.join(s, 'README.md'), opts.readme || 'Read templates/t.yaml\n');
  write(path.join(s, 'VERSION'), opts.version || '1.2.3\n');
  write(path.join(s, 'references', 'a.md'), 'a');
  write(path.join(s, 'templates', 't.yaml'), 't');
  write(path.join(s, 'scripts', 'x.cjs'), 'x');
  write(path.join(s, 'scripts', 'install.cjs'), fs.readFileSync(INSTALL));
  write(path.join(s, 'history', 'old.md'), 'old');
  write(path.join(s, 'agents', 'opus-a.md'), AGENT('opus-a'));
  write(path.join(s, 'agents', 'opus-b.md'), AGENT('opus-b'));
  return s;
}
function run(skill, args, env) {
  return spawnSync(process.execPath, [path.join(skill, 'scripts', 'install.cjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
  });
}

test('install into a temp project copies skill and agents, excludes history', () => {
  const root = tmp();
  const src = makeSkill(root);
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const r = run(src, ['--project', proj]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const t = path.join(proj, '.claude', 'skills', 'opus-orchestrator');
  assert.ok(fs.existsSync(path.join(t, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(t, 'scripts', 'x.cjs')));
  assert.ok(!fs.existsSync(path.join(t, 'history')));
  assert.ok(fs.existsSync(path.join(proj, '.claude', 'agents', 'opus-a.md')));
  assert.ok(fs.existsSync(path.join(proj, '.claude', 'agents', 'opus-b.md')));
  assert.match(r.stdout, /opus-a\.md/);
  assert.match(r.stdout, /SKILL\.md/);
  assert.match(r.stdout, /brand-new agents directory[^\n]*restart/i);
});

test('--user targets OPUS_ORCH_HOME', () => {
  const root = tmp();
  const src = makeSkill(root);
  const home = path.join(root, 'home');
  const r = run(src, ['--user'], { OPUS_ORCH_HOME: home });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'opus-orchestrator', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(home, '.claude', 'agents', 'opus-a.md')));
});

test('same path: skill copy skipped, agents installed', () => {
  const root = tmp();
  // source skill lives at <root>/.claude/skills/opus-orchestrator
  const proj = path.join(root, 'proj');
  const tmpSrc = makeSkill(root);
  const skillHere = path.join(proj, '.claude', 'skills', 'opus-orchestrator');
  fs.mkdirSync(path.dirname(skillHere), { recursive: true });
  fs.cpSync(tmpSrc, skillHere, { recursive: true });
  const r = run(skillHere, ['--project', proj]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /skipped/);
  assert.ok(fs.existsSync(path.join(proj, '.claude', 'agents', 'opus-a.md')));
  assert.ok(fs.existsSync(path.join(skillHere, 'history', 'old.md')), 'nothing deleted');
});

test('--agents-only installs only agents', () => {
  const root = tmp();
  const src = makeSkill(root);
  const proj = path.join(root, 'proj');
  const r = run(src, ['--project', proj, '--agents-only']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(proj, '.claude', 'agents', 'opus-b.md')));
  assert.ok(!fs.existsSync(path.join(proj, '.claude', 'skills')));
});

test('differing agent file is refused without --overwrite and nothing is written', () => {
  const root = tmp();
  const src = makeSkill(root);
  const proj = path.join(root, 'proj');
  const existing = path.join(proj, '.claude', 'agents', 'opus-b.md');
  write(existing, 'mine');
  const r = run(src, ['--project', proj]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /opus-b\.md/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'mine');
  assert.ok(!fs.existsSync(path.join(proj, '.claude', 'agents', 'opus-a.md')));
  assert.ok(!fs.existsSync(path.join(proj, '.claude', 'skills')));
});

test('--overwrite backs up the old agent file first', () => {
  const root = tmp();
  const src = makeSkill(root);
  const proj = path.join(root, 'proj');
  const existing = path.join(proj, '.claude', 'agents', 'opus-b.md');
  write(existing, 'mine');
  const r = run(src, ['--project', proj, '--overwrite']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(existing + '.bak', 'utf8'), 'mine');
  assert.equal(fs.readFileSync(existing, 'utf8'), AGENT('opus-b'));
});

test('regression: an update refuses to replace skill files the user changed, keeps a .bak with --overwrite, and never copies run state', () => {
  const root = tmp();
  const src = makeSkill(root);
  write(path.join(src, '.claude', 'opus-orchestrator', 'runs', 'r', 'run.json'), '{"secret": "run state"}');
  write(path.join(src, '.opus-inbox', 'draft.md'), 'draft');
  const proj = path.join(root, 'proj');
  let r = run(src, ['--project', proj]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Installing opus-orchestrator 1\.2\.3 from /);
  const t = path.join(proj, '.claude', 'skills', 'opus-orchestrator');
  assert.ok(!fs.existsSync(path.join(t, '.claude')), 'run state is not installed');
  assert.ok(!fs.existsSync(path.join(t, '.opus-inbox')), 'the inbox is not installed');
  // the user applies a proposal in the installed copy: VERSION and a file change
  write(path.join(t, 'VERSION'), '1.2.4\n');
  write(path.join(t, 'references', 'a.md'), 'user edit');
  // the source moves on as well
  write(path.join(src, 'templates', 't.yaml'), 't v2');
  r = run(src, ['--project', proj]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /VERSION exists with different content/);
  assert.match(r.stdout, /references[\\/]a\.md exists with different content/);
  assert.match(r.stdout, /Nothing was written/);
  assert.equal(fs.readFileSync(path.join(t, 'references', 'a.md'), 'utf8'), 'user edit');
  assert.equal(fs.readFileSync(path.join(t, 'templates', 't.yaml'), 'utf8'), 't', 'not even the unconflicted file was written');
  r = run(src, ['--project', proj, '--overwrite']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(path.join(t, 'references', 'a.md.bak'), 'utf8'), 'user edit');
  assert.equal(fs.readFileSync(path.join(t, 'VERSION.bak'), 'utf8'), '1.2.4\n');
  assert.equal(fs.readFileSync(path.join(t, 'templates', 't.yaml'), 'utf8'), 't v2');
});

test('an invalid source skill is refused before anything is written', () => {
  const root = tmp();
  const src = makeSkill(root, { version: 'banana\n' });
  const proj = path.join(root, 'proj');
  const r = run(src, ['--project', proj]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /VERSION is not a semantic version[\s\S]*Nothing was written/);
  assert.ok(!fs.existsSync(proj));
});

test('the shipped skill validates and reports version 1.1.0', () => {
  const r = spawnSync(process.execPath, [INSTALL, '--validate'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /is a valid opus-orchestrator skill directory \(version 1\.1\.0\)/);
  const v = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'oo.cjs'), 'version'], { encoding: 'utf8', env: { ...process.env, OPUS_ORCH_PROJECT_DIR: tmp() } });
  assert.match(v.stdout, /^opus-orchestrator 1\.1\.0$/m);
});

test('identical existing agent file is not a conflict', () => {
  const root = tmp();
  const src = makeSkill(root);
  const proj = path.join(root, 'proj');
  assert.equal(run(src, ['--project', proj]).status, 0);
  assert.equal(run(src, ['--project', proj]).status, 0);
});

test('--dry-run writes nothing', () => {
  const root = tmp();
  const src = makeSkill(root);
  const proj = path.join(root, 'proj');
  const r = run(src, ['--project', proj, '--dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /dry-run/);
  assert.match(r.stdout, /opus-a\.md/);
  assert.ok(!fs.existsSync(proj));
});

test('validate: valid skill passes', () => {
  const root = tmp();
  const src = makeSkill(root);
  const r = run(src, ['--validate', src]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

function invalid(mutate, pattern) {
  const root = tmp();
  const src = makeSkill(root);
  mutate(src);
  const r = run(src, ['--validate', src]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, pattern);
}

test('validate: wrong skill name', () => invalid((s) => write(path.join(s, 'SKILL.md'), '---\nname: other\ndescription: x\n---\n'), /name must be opus-orchestrator/));
test('validate: empty description', () => invalid((s) => write(path.join(s, 'SKILL.md'), '---\nname: opus-orchestrator\ndescription:\n---\n'), /description/));
test('validate: missing SKILL.md', () => invalid((s) => fs.rmSync(path.join(s, 'SKILL.md')), /SKILL\.md is missing/));
test('validate: agent missing model', () => invalid((s) => write(path.join(s, 'agents', 'opus-a.md'), '---\nname: opus-a\ndescription: d\ntools: Read\n---\n'), /opus-a\.md frontmatter is missing model/));
test('validate: bad VERSION', () => invalid((s) => write(path.join(s, 'VERSION'), 'banana\n'), /VERSION/));
test('validate: dangling reference in README', () => invalid((s) => write(path.join(s, 'README.md'), 'see config/nope.yaml\n'), /README\.md mentions config\/nope\.yaml/));
test('validate: dangling reference in SKILL.md', () => invalid((s) => write(path.join(s, 'SKILL.md'), '---\nname: opus-orchestrator\ndescription: x\n---\nuse agents/ghost.md\n'), /agents\/ghost\.md/));

test('run_tests.cjs: exit 1 when one file fails, 0 when all pass, filter works', () => {
  const root = tmp();
  const dir = path.join(root, 'tests');
  write(path.join(dir, 'good.test.cjs'), "require('node:test')('ok', () => {});\n");
  write(path.join(dir, 'bad.test.cjs'), "require('node:test')('boom', () => { throw new Error('x'); });\n");
  const both = spawnSync(process.execPath, [RUN_TESTS, '--dir', dir], { encoding: 'utf8' });
  assert.equal(both.status, 1);
  assert.match(both.stdout, /boom/);
  const good = spawnSync(process.execPath, [RUN_TESTS, '--dir', dir, 'good'], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const none = spawnSync(process.execPath, [RUN_TESTS, '--dir', dir, 'zzz'], { encoding: 'utf8' });
  assert.equal(none.status, 1);
});
