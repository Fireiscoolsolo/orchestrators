'use strict';
// Regressions for the 2026-11 audit. Real CLI, filesystem, Git repositories and worktrees in
// temporary directories; worker and reviewer reports are fixtures, not live model calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('../miniyaml.cjs');
const sm = require('../state_manager.cjs');

const FO = path.resolve(__dirname, '..', 'fo.cjs');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };

function cli(root, args, input = '') {
  const r = spawnSync(process.execPath, [FO, ...args], { cwd: root, encoding: 'utf8', input, windowsHide: true });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
function ok(root, args, input) {
  const r = cli(root, args, input);
  assert.equal(r.code, 0, `${args.join(' ')}: ${r.out}`);
  return r.out;
}
function refused(root, args, pattern, input) {
  const r = cli(root, args, input);
  assert.notEqual(r.code, 0, `${args.join(' ')} should have been refused:\n${r.out}`);
  assert.match(r.out, pattern);
  return r.out;
}
function git(repo, ...args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}:\n${r.stderr}`);
  return r.stdout.trim();
}
function scratch(t, prefix) {
  const base = fs.realpathSync.native(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, prefix));
  t.after(() => {
    // Only ever remove the directory this test created under the system temporary directory.
    assert.equal(path.dirname(dir), base);
    assert.ok(path.basename(dir).startsWith(prefix));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}
const contract = (id, scope, commands, extra = {}) => ({
  task_id: id, title: `Task ${id}`, objective: `Complete ${id}`, priority: 'medium', dependencies: [],
  complexity_score: 2, risk_level: 'low', file_scope: scope, acceptance_criteria: ['the change satisfies its checks'],
  verification: ['execute checks'], verification_commands: commands, ...extra,
});
const sharedReport = (id, attempt, files) => yaml.dump({
  task_id: id, attempt_id: attempt, status: 'implemented', summary: `Implemented ${id}`, files_changed: files,
  verification: { tests_run: false, tests_passed: null, build_passed: null }, known_issues: [],
});

/** Shared-workspace run with one task whose worker changed src/a.js. */
function sharedFixture(t, { commands = [], rounds } = {}) {
  const root = scratch(t, 'fo-audit-shared-');
  write(path.join(root, 'src/a.js'), 'module.exports = 1;\n');
  write(path.join(root, 'notes.txt'), 'unrelated user content\n');
  if (rounds !== undefined) write(path.join(root, '.claude/fable-orchestrator/config.yaml'), yaml.dump({ execution: { max_review_rounds: rounds } }));
  const runDir = /run_dir: (.+)/.exec(ok(root, ['init', '--stdin'], 'Update a helper'))[1].trim();
  ok(root, ['plan', '--stdin'], yaml.dump(contract('S-001', ['src/'], commands)));
  const spec = JSON.parse(ok(root, ['next', '--json'])).specs[0];
  const state = () => new sm.Store(runDir).read();
  const task = () => state().tasks['S-001'];
  write(path.join(root, 'src/a.js'), 'module.exports = 2;\n');
  ok(root, ['report', 'S-001', '--stdin'], sharedReport('S-001', spec.attempt_id, ['src/a.js']));
  const check = (note) => ok(root, ['check', 'S-001', '--name', 'Inspect helper', '--result', 'pass', '--note', note]);
  const approve = () => ok(root, ['review', 'S-001', '--stdin'], yaml.dump({
    task_id: 'S-001', reviewer: 'orchestrator', verdict: 'approve', candidate_snapshot: task().verified_snapshot_id,
    criteria: [{ met: true, evidence: 'inspected the verified helper' }], findings: [],
  }));
  return { root, runDir, state, task, check, approve, spec };
}

// ------------------------------------------------- finding 1: re-verification

test('reproduction: --reverify inside an open cycle cannot carry a stale manual check to review', (t) => {
  const f = sharedFixture(t);
  f.check('read helper value 2');
  write(path.join(f.root, 'src/a.js'), 'module.exports = 666;\n');
  refused(f.root, ['verify', 'S-001', '--reverify', '--reason', 'content changed'], /REVERIFY_NOT_APPLICABLE/);
  assert.equal(f.task().state, 'VERIFYING');
  assert.equal(f.task().review_round, 0, 'a refused command consumes nothing');
  // The continuation compares against the report snapshot and refuses the changed content.
  const out = ok(f.root, ['verify', 'S-001']);
  assert.match(out, /shared workspace changed before checks/);
  assert.match(out, /manual check freshness/);
  assert.equal(f.task().state, 'CORRECTION_REQUIRED');
  assert.equal(f.task().verified_snapshot, undefined);
  // A fresh cycle starts with no checks, so the old inspection cannot count.
  refused(f.root, ['verify', 'S-001', '--reverify', '--reason', 'inspect the changed helper'], /NO_VERIFICATION_EVIDENCE/);
  assert.equal(f.task().verify_cycle, 2);
  assert.equal(f.task().review_round, 1);
  assert.deepEqual(sm.currentChecks(f.task()).filter((x) => x.kind === 'manual'), []);
  f.check('read helper value 666');
  assert.match(ok(f.root, ['verify', 'S-001']), /-> REVIEWING/);
  assert.match(f.approve(), /APPROVED/);
});

test('--reverify is refused from IMPLEMENTED and leaves the report snapshot comparison in force', (t) => {
  const f = sharedFixture(t, { commands: ['node -e "process.exit(0)"'] });
  write(path.join(f.root, 'src/a.js'), 'module.exports = 3;\n');
  refused(f.root, ['verify', 'S-001', '--reverify', '--reason', 'skip the comparison'], /REVERIFY_NOT_APPLICABLE/);
  assert.equal(f.task().state, 'IMPLEMENTED');
  assert.match(ok(f.root, ['verify', 'S-001']), /shared workspace changed before checks/);
});

test('a pending manual-only snapshot that changes before continuation is refused, including A-B-A edits', (t) => {
  for (const variant of ['changed', 'restored']) {
    const f = sharedFixture(t);
    f.check('read helper value 2');
    assert.match(ok(f.root, ['verify', 'S-001']), /-> REVIEWING/);
    write(path.join(f.root, 'src/a.js'), 'module.exports = 5;\n');
    refused(f.root, ['verify', 'S-001', '--reverify', '--reason', 'inspect changed helper'], /NO_VERIFICATION_EVIDENCE/);
    const pending = f.task().pending_verification_snapshot;
    assert.equal(pending.truncated, false, 'the pending cycle keeps its content snapshot');
    write(path.join(f.root, 'src/a.js'), 'module.exports = 9;\n');
    f.check('read helper value 9');
    if (variant === 'restored') write(path.join(f.root, 'src/a.js'), 'module.exports = 5;\n');
    const out = ok(f.root, ['verify', 'S-001']);
    if (variant === 'changed') {
      // The check matches the current content, but that content differs from the pending snapshot.
      assert.match(out, /shared workspace changed before checks: src\/a.js/);
    } else {
      // Content is back to the pending snapshot, so only the check's own binding reveals it saw other content.
      assert.doesNotMatch(out, /shared workspace changed/);
      assert.match(out, /FAIL \[candidate\] manual check freshness/);
    }
    assert.equal(f.task().state, 'CORRECTION_REQUIRED', variant);
    assert.equal(f.task().verified_snapshot, undefined, variant);
  }
});

test('ordinary manual-only continuation with unchanged content still reaches review', (t) => {
  const f = sharedFixture(t);
  f.check('read helper value 2');
  const manual = f.task().checks.find((x) => x.kind === 'manual');
  assert.match(manual.snapshot_id, /^[0-9a-f]{64}$/, 'the manual check is bound to inspected content');
  assert.match(ok(f.root, ['verify', 'S-001']), /-> REVIEWING/);
  assert.equal(f.task().verified_snapshot_id, manual.snapshot_id);
  // Manual-only re-verification: the cycle waits for manual evidence, then continues.
  write(path.join(f.root, 'src/a.js'), 'module.exports = 4;\n');
  refused(f.root, ['verify', 'S-001', '--reverify', '--reason', 'inspect changed helper'], /NO_VERIFICATION_EVIDENCE/);
  f.check('read helper value 4');
  assert.match(ok(f.root, ['verify', 'S-001']), /-> REVIEWING/);
  assert.match(f.approve(), /APPROVED/);
});

test('re-verification from REVIEWING and CORRECTION_REQUIRED consumes rounds and stops at the limit', (t) => {
  const f = sharedFixture(t, { commands: ['node -e "process.exit(0)"'], rounds: 2 });
  assert.match(ok(f.root, ['verify', 'S-001']), /-> REVIEWING/);
  ok(f.root, ['verify', 'S-001', '--reverify', '--reason', 'first re-verification from REVIEWING']);
  assert.equal(f.task().review_round, 1);
  assert.equal(f.task().verify_cycle, 2);
  // Make the next cycle fail, so the task sits in CORRECTION_REQUIRED.
  write(path.join(f.root, 'notes.txt'), 'out of scope edit\n');
  ok(f.root, ['verify', 'S-001', '--reverify', '--reason', 'second re-verification from REVIEWING']);
  assert.equal(f.task().state, 'CORRECTION_REQUIRED');
  assert.equal(f.task().review_round, 2);
  write(path.join(f.root, 'notes.txt'), 'unrelated user content\n');
  refused(f.root, ['verify', 'S-001', '--reverify', '--reason', 'third re-verification'], /CORRECTION_LIMIT/);
  assert.equal(f.task().review_round, 2, 'the refused attempt consumed nothing');
  ok(f.root, ['authorize', 'S-001', '--extra-rounds', '1', '--by', 'user', '--reason', 'User granted one more round']);
  assert.match(ok(f.root, ['verify', 'S-001', '--reverify', '--reason', 'restored notes']), /-> REVIEWING/);
});

// ---------------------------------------------------------------- git fixtures

function gitRepo(t, prefix, isolation) {
  const dir = scratch(t, prefix);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Orchestrator Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  write(path.join(repo, 'value.cjs'), 'module.exports = 1;\n');
  write(path.join(repo, 'check.cjs'), "require('node:assert/strict').equal(require('./value.cjs'), 2);\n");
  write(path.join(repo, '.gitignore'), '.claude/\n.fable-inbox/\n');
  git(repo, 'add', '--', 'value.cjs', 'check.cjs', '.gitignore');
  git(repo, 'commit', '-m', 'fixture');
  if (isolation) write(path.join(repo, '.claude/fable-orchestrator/config.yaml'), yaml.dump({ isolation: { strategy: isolation } }));
  const runDir = /run_dir: (.+)/.exec(ok(repo, ['init', '--stdin'], 'Set the value to 2'))[1].trim();
  const state = () => new sm.Store(runDir).read();
  return { dir, repo, runDir, state };
}

/** Managed-isolation run: fo creates the worker worktree itself. */
function managedFixture(t, commands = ['node check.cjs']) {
  const f = gitRepo(t, 'fo-audit-git-', 'managed');
  ok(f.repo, ['plan', '--stdin'], yaml.dump(contract('G-001', ['value.cjs'], commands)));
  const spec = JSON.parse(ok(f.repo, ['next', '--json'])).specs[0];
  const a = f.state().tasks['G-001'].attempts[0];
  write(path.join(a.workdir, 'value.cjs'), 'module.exports = 2;\n');
  git(a.workdir, 'add', '--', 'value.cjs');
  git(a.workdir, 'commit', '-m', 'implement value');
  ok(f.repo, ['report', 'G-001', '--stdin'], yaml.dump({
    task_id: 'G-001', attempt_id: spec.attempt_id, status: 'implemented', summary: 'Set value to 2',
    files_changed: ['value.cjs'], verification: { tests_run: true, tests_passed: true, build_passed: null },
    known_issues: [], commit: git(a.workdir, 'rev-parse', 'HEAD'), branch: a.branch, worktree_path: a.workdir,
  }));
  return { ...f, spec, task: () => f.state().tasks['G-001'] };
}

test('git manual checks are bound to the candidate commit and --reverify is refused in VERIFYING', (t) => {
  const f = managedFixture(t, []);
  ok(f.repo, ['check', 'G-001', '--name', 'Inspect value', '--result', 'pass', '--note', 'value.cjs exports 2']);
  const manual = f.task().checks.find((x) => x.kind === 'manual');
  assert.equal(manual.candidate.commit, f.task().attempts[0].commit);
  refused(f.repo, ['verify', 'G-001', '--reverify', '--reason', 'skip'], /REVERIFY_NOT_APPLICABLE/);
  assert.match(ok(f.repo, ['verify', 'G-001']), /-> REVIEWING/);
});

test('git re-verification from REVIEWING is refused while a reviewer dispatch is outstanding', (t) => {
  const f = managedFixture(t);
  ok(f.repo, ['verify', 'G-001']);
  // Force one independent perspective so a reviewer dispatch exists for this cycle.
  new sm.Store(f.runDir).transact((state) => { state.tasks['G-001'].route.review = { independent: 1, perspectives: ['correctness'] }; });
  ok(f.repo, ['review-package', 'G-001']);
  refused(f.repo, ['verify', 'G-001', '--reverify', '--reason', 'replace cycle'], /REVIEW_IN_PROGRESS/);
  assert.equal(f.task().state, 'REVIEWING');
  assert.equal(f.task().review_round, 0);
});

// ------------------------------- finding 2: evidence written around state commits

/** Run the real CLI with a preload that injects one persistence or write fault into state_manager. */
function faulty(t, root, fault, args, input = '') {
  const preload = path.join(scratch(t, 'fo-audit-fault-'), 'fault.cjs');
  write(preload, [
    "'use strict';",
    `const sm = require(${JSON.stringify(path.resolve(__dirname, '..', 'state_manager.cjs'))});`,
    `const [kind, arg] = ${JSON.stringify(fault)}.split(':');`,
    'if (kind === "save") {',
    '  let n = 0;',
    '  const save = sm.Store.prototype.save;',
    '  sm.Store.prototype.save = function (state) { if (++n === Number(arg)) throw new Error("injected commit failure"); return save.call(this, state); };',
    '}',
    'if (kind === "write") {',
    '  const writeAtomic = sm.writeAtomic;',
    '  sm.writeAtomic = (file, text) => { if (file.endsWith(arg)) throw new Error("injected write failure"); return writeAtomic(file, text); };',
    '}',
  ].join('\n'));
  const r = spawnSync(process.execPath, ['-r', preload, FO, ...args], { cwd: root, encoding: 'utf8', input, windowsHide: true });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const listDir = (dir, re) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => re.test(f)) : []);
const digest = (file) => require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function withReviewer(f) {
  ok(f.repo, ['verify', 'G-001']);
  new sm.Store(f.runDir).transact((state) => { state.tasks['G-001'].route.review = { independent: 1, perspectives: ['correctness'] }; });
}

test('a failed review-dispatch commit leaves no diff file, and the retry records exactly one bound diff', (t) => {
  const f = managedFixture(t);
  withReviewer(f);
  const calls = f.state().budget.agent_calls;
  const evidence = path.join(f.runDir, 'evidence');
  const failed = faulty(t, f.repo, 'save:1', ['review-package', 'G-001']);
  assert.notEqual(failed.code, 0);
  assert.match(failed.out, /injected commit failure/);
  assert.doesNotMatch(failed.out, /REVIEW DISPATCH/, 'no prompt is issued for an uncommitted dispatch');
  assert.deepEqual(listDir(evidence, /-review-.*\.diff$/), [], 'no orphaned diff');
  assert.equal((f.task().review_dispatches || []).length, 0);
  assert.equal(f.state().budget.agent_calls, calls);
  const out = ok(f.repo, ['review-package', 'G-001']);
  const d = f.task().review_dispatches.at(-1);
  assert.deepEqual(listDir(evidence, /-review-.*\.diff$/), [`G-001-review-${d.id}.diff`]);
  assert.equal(digest(path.join(f.runDir, d.diff.file)), d.diff.sha256);
  assert.match(out, new RegExp(`SHA-256 ${d.diff.sha256}`));
});

test('a review diff that cannot be written after commit retires the unissued dispatch and returns its call', (t) => {
  const f = managedFixture(t);
  withReviewer(f);
  const calls = f.state().budget.agent_calls;
  const failed = faulty(t, f.repo, 'write:.diff', ['review-package', 'G-001']);
  assert.notEqual(failed.code, 0);
  assert.match(failed.out, /EVIDENCE_WRITE_FAILED/);
  assert.doesNotMatch(failed.out, /REVIEW DISPATCH/);
  const [d] = f.task().review_dispatches;
  assert.equal(d.status, 'failed');
  assert.equal(f.state().budget.agent_calls, calls);
  ok(f.repo, ['review-package', 'G-001']);
  const [old, replacement] = f.task().review_dispatches;
  assert.equal(old.status, 'superseded');
  assert.equal(replacement.status, 'unknown');
  assert.equal(digest(path.join(f.runDir, replacement.diff.file)), replacement.diff.sha256);
});

test('a failed report commit leaves no report copy, and the accepted retry is bound by digest', (t) => {
  const f = gitRepo(t, 'fo-audit-report-', 'managed');
  ok(f.repo, ['plan', '--stdin'], yaml.dump(contract('G-001', ['value.cjs'], ['node check.cjs'])));
  const spec = JSON.parse(ok(f.repo, ['next', '--json'])).specs[0];
  const a = f.state().tasks['G-001'].attempts[0];
  write(path.join(a.workdir, 'value.cjs'), 'module.exports = 2;\n');
  git(a.workdir, 'add', '--', 'value.cjs');
  git(a.workdir, 'commit', '-m', 'implement value');
  const report = yaml.dump({
    task_id: 'G-001', attempt_id: spec.attempt_id, status: 'implemented', summary: 'Set value to 2',
    files_changed: ['value.cjs'], verification: { tests_run: true, tests_passed: true, build_passed: null },
    known_issues: [], commit: git(a.workdir, 'rev-parse', 'HEAD'), branch: a.branch, worktree_path: a.workdir,
  });
  assert.notEqual(faulty(t, f.repo, 'save:1', ['report', 'G-001', '--stdin'], report).code, 0);
  assert.deepEqual(listDir(path.join(f.runDir, 'reports'), /\.yaml$/), [], 'no orphaned report copy');
  assert.equal(f.state().tasks['G-001'].state, 'DISPATCHED');
  ok(f.repo, ['report', 'G-001', '--stdin'], report);
  const recorded = f.state().tasks['G-001'].attempts[0].report_record;
  assert.equal(digest(path.join(f.runDir, recorded.file)), recorded.sha256);
});

test('an interrupted verification leaves only unreferenced logs; the accepted rerun names its own', (t) => {
  const f = sharedFixture(t, { commands: ['node -e "process.exit(0)"'] });
  const failed = faulty(t, f.root, 'save:2', ['verify', 'S-001']);
  assert.notEqual(failed.code, 0);
  const evidence = path.join(f.runDir, 'evidence');
  const orphans = listDir(evidence, /\.log$/);
  assert.equal(orphans.length, 1, 'the interrupted run wrote its log');
  assert.equal(f.task().checks.length, 0, 'but recorded no check');
  ok(f.root, ['reconcile', 'S-001', '--reason', 'verifier process exited after an injected commit failure']);
  assert.match(ok(f.root, ['verify', 'S-001']), /-> REVIEWING/);
  const commands = f.task().checks.filter((x) => x.kind === 'command');
  assert.equal(commands.length, 1);
  assert.ok(!orphans.includes(path.basename(commands[0].evidence)), 'accepted evidence never reuses an orphan name');
  assert.equal(digest(path.join(f.runDir, commands[0].evidence)), commands[0].evidence_sha256);
  assert.equal(commands[0].operation.slice(0, 8), path.basename(commands[0].evidence).split('-')[3]);
});

test('an interrupted operation recorded on another host is never reconciled from its process ID here', (t) => {
  const f = sharedFixture(t, { commands: ['node -e "process.exit(0)"'] });
  assert.notEqual(faulty(t, f.root, 'save:2', ['verify', 'S-001']).code, 0);
  assert.equal(f.task().verification_operation.host, os.hostname());
  new sm.Store(f.runDir).transact((state) => { state.tasks['S-001'].verification_operation.host = 'another-build-host'; });
  refused(f.root, ['reconcile', 'S-001', '--reason', 'looks stopped'], /OPERATION_ACTIVE[\s\S]*another-build-host/);
  assert.ok(f.task().verification_operation, 'the operation record is kept');
});

test('a failed dispatch commit leaves worktrees that the retry takes over; modified leftovers are refused', (t) => {
  for (const variant of ['clean', 'modified']) {
    const f = gitRepo(t, 'fo-audit-next-', 'managed');
    ok(f.repo, ['plan', '--stdin'], yaml.dump(contract('G-001', ['value.cjs'], ['node check.cjs'])));
    const failed = faulty(t, f.repo, 'save:1', ['next', '--json']);
    assert.notEqual(failed.code, 0);
    assert.equal(f.state().tasks['G-001'].attempts.length, 0, 'the dispatch was not committed');
    const leftover = path.join(f.runDir, 'wt', 'G-001-a1');
    assert.ok(fs.existsSync(leftover), 'git worktree add ran before the failed commit');
    if (variant === 'modified') {
      write(path.join(leftover, 'value.cjs'), 'module.exports = "unrecorded work";\n');
      const r = cli(f.repo, ['next', '--json']);
      assert.notEqual(r.code, 0);
      assert.match(r.out, /WORKTREE_CONFLICT/);
      assert.equal(fs.readFileSync(path.join(leftover, 'value.cjs'), 'utf8'), 'module.exports = "unrecorded work";\n', 'never overwritten');
      continue;
    }
    const spec = JSON.parse(ok(f.repo, ['next', '--json'])).specs[0];
    assert.equal(f.state().project.git.integration_branch, `fable/${f.state().run_id}/integration`);
    assert.equal(f.state().tasks['G-001'].attempts[0].workdir, leftover);
    assert.equal(spec.attempt, 1);
  }
});

// ---------------------------------------- shared workspace ownership across tasks

test('shared mode keeps the workspace with a started task while it is blocked, so retries keep a valid baseline', (t) => {
  const root = scratch(t, 'fo-audit-owner-');
  write(path.join(root, 'src/a.js'), 'module.exports = 1;\n');
  write(path.join(root, 'src/b.js'), 'module.exports = 1;\n');
  ok(root, ['init', '--stdin'], 'Update two helpers');
  ok(root, ['plan', '--stdin'], [yaml.dump(contract('A-001', ['src/a.js'], ['node -e "process.exit(0)"'])),
    yaml.dump(contract('B-001', ['src/b.js'], ['node -e "process.exit(0)"']))].join('---\n'));
  const first = JSON.parse(ok(root, ['next', '--json']));
  assert.deepEqual(first.specs.map((s) => s.task_id), ['A-001']);
  write(path.join(root, 'src/a.js'), 'module.exports = "partial";\n');
  ok(root, ['report', 'A-001', '--stdin'], yaml.dump({
    task_id: 'A-001', attempt_id: first.specs[0].attempt_id, status: 'blocked', summary: 'Stopped halfway',
    reason: 'needs a decision from the user', files_changed: ['src/a.js'],
    verification: { tests_run: false, tests_passed: null, build_passed: null }, known_issues: [],
  }));
  const held = JSON.parse(ok(root, ['next', '--json']));
  assert.deepEqual(held.specs, [], 'no other task starts on top of unfinished partial edits');
  assert.match(JSON.stringify(held.deferred), /A-001/);
  ok(root, ['unblock', 'A-001', '--reason', 'User decided']);
  const retry = JSON.parse(ok(root, ['next', '--json'])).specs;
  assert.deepEqual(retry.map((s) => s.task_id), ['A-001']);
  write(path.join(root, 'src/a.js'), 'module.exports = 2;\n');
  ok(root, ['report', 'A-001', '--stdin'], sharedReport('A-001', retry[0].attempt_id, ['src/a.js']));
  assert.match(ok(root, ['verify', 'A-001']), /-> REVIEWING/);
});

test('a shared owner waiting for a retry is dispatched even when a higher-priority task competes for the only slot', (t) => {
  const root = scratch(t, 'fo-audit-slot-');
  write(path.join(root, 'src/a.js'), 'module.exports = 1;\n');
  write(path.join(root, 'src/b.js'), 'module.exports = 1;\n');
  ok(root, ['init', '--stdin'], '--max-workers 1 Update two helpers');
  ok(root, ['plan', '--stdin'], [yaml.dump(contract('A-001', ['src/a.js'], ['node -e "process.exit(0)"'])),
    yaml.dump(contract('B-001', ['src/b.js'], ['node -e "process.exit(0)"']))].join('---\n'));
  const first = JSON.parse(ok(root, ['next', '--json'])).specs;
  assert.deepEqual(first.map((s) => s.task_id), ['A-001']);
  ok(root, ['worker-failed', 'A-001', '--attempt-id', first[0].attempt_id, '--kind', 'crash', '--reason', 'host reported the worker crashed']);
  // B now sorts ahead of A for the single worker slot.
  new sm.Store(path.join(root, '.claude/fable-orchestrator/runs', fs.readFileSync(path.join(root, '.claude/fable-orchestrator/current'), 'utf8').trim()))
    .transact((state) => { state.tasks['B-001'].contract.priority = 'critical'; });
  const next = JSON.parse(ok(root, ['next', '--json']));
  assert.deepEqual(next.specs.map((s) => s.task_id), ['A-001'], 'the owner gets the slot');
  assert.match(JSON.stringify(next.deferred), /B-001.*held by A-001/);
});
