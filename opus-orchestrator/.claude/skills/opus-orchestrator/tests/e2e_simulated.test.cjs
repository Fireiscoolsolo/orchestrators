'use strict';
// End-to-end test of scripts/demo.cjs: the whole scenario (specification 18.2) in both
// workspace strategies, asserted from the persisted run state.
// SIMULATED AGENTS: the workers and reviewers are scripted code in demo.cjs; no model is called
// and no real agent is launched. Everything else (oo, its state, the verification commands, git)
// is real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('../scripts/lib/yaml.cjs');
const store = require('../scripts/lib/store.cjs');

const SKILL = path.resolve(__dirname, '..');
const DEMO_SCRIPT = path.join(SKILL, 'scripts', 'demo.cjs');
const FIXTURE = path.join(SKILL, 'demo', 'project');
const SCRIPTED = path.join(SKILL, 'demo', 'scripted');
const roots = [];

test.after(() => {
  while (roots.length) {
    try {
      fs.rmSync(roots.pop(), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (_) {
      // a directory still held open is not a test failure
    }
  }
});

function cleanEnv() {
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) if (k.startsWith('OPUS_ORCH_')) delete env[k];
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runNode(args, cwd) {
  const r = spawnSync(process.execPath, args, { cwd: cwd || SKILL, env: cleanEnv(), encoding: 'utf8', timeout: 280000, windowsHide: true });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Runs demo.cjs with --keep and returns what it printed plus the persisted state of its run. */
function runDemo(extraArgs) {
  const r = runNode([DEMO_SCRIPT, '--keep', ...extraArgs]);
  const dir = (/^Demo directory: (.+)$/m.exec(r.stdout) || [])[1];
  if (dir) roots.push(dir.trim());
  assert.equal(r.code, 0, `demo.cjs ${extraArgs.join(' ')} exited ${r.code}\n${r.out}`);
  const project = (/^Project copy: +(.+)$/m.exec(r.stdout) || [])[1].trim();
  const reportPath = (/^Final report: (.+)$/m.exec(r.stdout) || [])[1].trim();
  const paths = store.resolvePaths({ projectDir: project });
  const runId = fs.readFileSync(paths.currentFile, 'utf8').trim();
  const tasks = {};
  for (const id of ['SLUG-001', 'WORD-001', 'SUM-001', 'DOC-001']) tasks[id] = store.loadTask(paths, runId, id);
  return { r, project, reportPath, paths, runId, run: store.loadRun(paths), tasks, events: store.readEvents(paths, runId) };
}

/** Assertions shared by both strategies, all from the persisted state and the printed transcript. */
function assertScenario(d) {
  const text = d.r.stdout;

  // the transcript says plainly that the agents are simulated and no model is called
  assert.match(text.split('\n').slice(0, 6).join('\n'), /SIMULATED by scripted code/);
  assert.match(text.split('\n').slice(0, 6).join('\n'), /No model is called/);
  assert.match(text, /RESULT: PASSED \(simulated-agent demonstration/);
  // one entry per step with the oo command and its exit code, in order
  for (let n = 1; n <= 11; n++) {
    assert.match(text, new RegExp(`^\\[${String(n).padStart(2)}/11\\] .*oo [a-z-]+.* -> exit \\d+`, 'm'), `step ${n} is printed with its oo command and exit code`);
  }
  const stepOrder = [...text.matchAll(/^\[ ?(\d+)\/11\]/gm)].map((m) => Number(m[1]));
  assert.deepEqual(stepOrder.filter((n, i) => i === 0 || n !== stepOrder[i - 1]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  if (d.run.workspace.strategy === 'worktree') {
    assert.match(text, /\[ 4\/11\] verification: oo verify WORD-001 -> exit 0\n\s+oo verify SLUG-001 -> exit 1/);
  } else {
    // shared workspace: SLUG-001 alone first; WORD-001 only after SLUG-001's verification closed its window
    assert.match(text, /\[ 3\/11\] dispatch of SLUG-001 \(shared workspace: one writer at a time\): oo next -> exit 0/);
    assert.match(text, /\[ 4\/11\] verification: oo verify SLUG-001 -> exit 1[\s\S]*oo next -> exit 0[\s\S]*oo verify WORD-001 -> exit 0/);
  }
  assert.match(text, /\[10\/11\] deliver: oo deliver -> exit 0/);
  assert.match(text, /\[11\/11\] final-report: oo final-report -> exit 0/);
  assert.ok(fs.existsSync(d.reportPath), 'the printed final report path exists');
  assert.equal(path.resolve(d.reportPath), path.join(d.paths.runsDir, d.runId, 'final-report.md'));

  // all four tasks COMPLETED; exactly one correction round, for SLUG-001 only
  for (const [id, t] of Object.entries(d.tasks)) assert.equal(t.status, 'COMPLETED', `${id} is COMPLETED`);
  assert.equal(d.tasks['SLUG-001'].review_round, 1);
  for (const id of ['WORD-001', 'SUM-001', 'DOC-001']) {
    assert.equal(d.tasks[id].review_round, 0, `${id} had no correction round`);
    assert.deepEqual(d.tasks[id].corrections || [], []);
    assert.deepEqual(d.tasks[id].evidence.rounds || [], []);
    assert.equal(d.tasks[id].attempts, 1);
  }

  // SLUG-001: the correction cycle came from the verification run, not from a hard-coded state
  const slug = d.tasks['SLUG-001'];
  assert.equal(slug.attempts, 2);
  assert.equal(slug.corrections.length, 1);
  assert.equal(slug.evidence.rounds.length, 1);
  const failedRound = slug.evidence.rounds[0];
  assert.equal(failedRound.round, 0);
  assert.equal(failedRound.verification.passed, false, 'the archived round records the failed verification');
  const failedCmds = failedRound.verification.commands.filter((c) => c.exit_code !== 0);
  assert.equal(failedCmds.length, 1);
  assert.match(failedCmds[0].command, /acceptance\/slugify\.acceptance\.test\.js/);
  assert.match(failedCmds[0].output_tail, /a long title is cut to at most 40 characters/);
  const unit = failedRound.verification.commands.find((c) => /test\/slugify\.test\.js/.test(c.command));
  assert.equal(unit.exit_code, 0, 'the first slugify passed its unit tests');
  assert.ok(fs.existsSync(path.join(d.project, ...failedRound.verification.evidence_file.split('/'))) || fs.existsSync(failedRound.verification.evidence_file), 'the failed verification evidence file exists');
  assert.equal(slug.evidence.verification.passed, true, 'the current verification passed');
  assert.ok(slug.evidence.verification.commands.every((c) => c.exit_code === 0));
  assert.equal(slug.evidence.verification.commands.length, 2);
  assert.match(slug.corrections[0].failure, /acceptance\/slugify\.acceptance\.test\.js exited 1/);
  assert.match(slug.corrections[0].required_change, /40 characters/);
  assert.equal(slug.verification_runs, 2);
  const slugPath = slug.history.map((h) => h.to);
  assert.deepEqual(slugPath.filter((s) => ['CORRECTION_REQUIRED', 'READY', 'COMPLETED'].includes(s)),
    ['READY', 'CORRECTION_REQUIRED', 'READY', 'COMPLETED']);
  const verifyingStates = slug.history.filter((h) => h.from === 'VERIFYING').map((h) => h.to);
  assert.deepEqual(verifyingStates, ['CORRECTION_REQUIRED', 'REVIEWING']);
  // the second worker package carries the targeted correction
  const pkg2 = fs.readFileSync(path.join(d.project, ...slug.dispatch.package.split('/')), 'utf8');
  assert.match(pkg2, /## Correction request \(round 1\)/);
  assert.match(pkg2, /40 characters/);
  // an independent review was recorded for slugify (complexity 5, balanced mode) after a review package
  const reviews = slug.evidence.reviews;
  assert.deepEqual(reviews.map((r) => [r.reviewer, r.independent, r.verdict]), [['opus-reviewer', true, 'approve'], ['orchestrator', false, 'approve']]);
  assert.equal(slug.evidence.review_packages.length, 1);

  // the other tasks passed their first verification and were reviewed once
  for (const id of ['WORD-001', 'SUM-001', 'DOC-001']) {
    const t = d.tasks[id];
    assert.equal(t.evidence.verification.passed, true);
    assert.equal(t.verification_runs, 1);
    assert.deepEqual(t.evidence.reviews.map((r) => r.reviewer), ['orchestrator']);
    assert.equal(t.evidence.integration.passed, true);
  }
  assert.equal(slug.evidence.integration.passed, true);

  // dependencies: the dependent tasks started only after what they need was COMPLETED
  const at = (id, state) => d.tasks[id].history.find((h) => h.to === state).ts;
  assert.ok(at('SUM-001', 'DISPATCHED') >= at('SLUG-001', 'COMPLETED') && at('SUM-001', 'DISPATCHED') >= at('WORD-001', 'COMPLETED'));
  assert.ok(at('DOC-001', 'DISPATCHED') >= at('SUM-001', 'COMPLETED'));
  if (d.run.workspace.strategy === 'worktree') {
    // the two independent tasks were dispatched in the same oo next (isolated worktrees)
    const batch = d.events.find((e) => e.type === 'dispatch' && e.tasks.length === 2);
    assert.deepEqual([...batch.tasks].sort(), ['SLUG-001', 'WORD-001']);
  } else {
    // shared workspace: never two writers at once
    assert.ok(d.events.filter((e) => e.type === 'dispatch').every((e) => e.tasks.length <= 1), 'one task per dispatch in the shared workspace');
    assert.ok(at('WORD-001', 'DISPATCHED') >= d.tasks['SLUG-001'].history.find((h) => h.from === 'VERIFYING').ts, 'WORD-001 waited for SLUG-001\'s verification');
  }
  // every accepted worker report matched the attempt it was dispatched as
  for (const t of Object.values(d.tasks)) {
    for (const e of t.attempt_log) assert.match(e.attempt_id, new RegExp(`^${t.task_id}-a${e.attempt}-[0-9a-f]{6}$`));
    assert.equal(t.result.attempt_id, t.dispatch.attempt_id);
  }

  // final report and delivery
  const report = fs.readFileSync(d.reportPath, 'utf8');
  assert.match(report, /Overall status: COMPLETE\b/);
  assert.match(report, /### COMPLETED \(4\)/);
  assert.match(report, /\| SLUG-001 \| verification \| 0 \| `node --test acceptance\/slugify\.acceptance\.test\.js` \| 1 \|/);
  assert.match(report, /\| SLUG-001 \| verification \| 1 \| `node --test acceptance\/slugify\.acceptance\.test\.js` \| 0 \|/);
  assert.match(report, /SLUG-001: round 0 failed, current round 1 passed/);
  assert.equal(d.run.delivered, true);

  // the finished project passes every one of its own tests
  const own = runNode(['--test', 'test/summary.test.js', 'test/slugify.test.js', 'test/wordcount.test.js', 'acceptance/slugify.acceptance.test.js'], d.project);
  assert.equal(own.code, 0, own.out);
  assert.match(fs.readFileSync(path.join(d.project, 'README.md'), 'utf8'), /### `summarize\(text\)`/);
}

test('simulated-agent: demo.cjs completes the whole scenario in the shared strategy', () => {
  const d = runDemo([]);
  assert.equal(d.run.workspace.strategy, 'shared');
  assert.match(d.r.stdout, /not a repository: the shared strategy/);
  assert.ok(!fs.existsSync(path.join(d.project, '.git')), 'the copy is not a repository');
  assertScenario(d);
  for (const t of Object.values(d.tasks)) assert.equal(t.dispatch.mode, 'shared');
  assert.match(fs.readFileSync(d.reportPath, 'utf8'), /Workspace strategy: shared/);
});

test('simulated-agent: demo.cjs --git completes the same scenario in the worktree strategy with real branches and merges', () => {
  const d = runDemo(['--git']);
  assert.equal(d.run.workspace.strategy, 'worktree');
  assert.match(d.r.stdout, /worktree strategy with real branches, worktrees and merges/);
  assertScenario(d);
  const ws = d.run.workspace;
  assert.equal(ws.base_branch, 'main');
  for (const t of Object.values(d.tasks)) {
    assert.equal(t.dispatch.mode, 'isolated');
    assert.ok(t.result.commit && t.result.branch, `${t.task_id} reported a commit and a branch`);
    assert.ok(/^[0-9a-f]{40}$/.test(t.evidence.integration.merged_commit), `${t.task_id} has a merge commit`);
    assert.equal(git(d.project, 'rev-parse', `refs/heads/${t.result.branch}`), t.result.commit, `${t.task_id}: the branch exists and points at the reported commit`);
  }
  // the integration branch holds one merge per task, and deliver fast-forwarded main onto it
  const merges = git(d.project, 'log', '--merges', '--format=%H', ws.integration_branch).split('\n').filter(Boolean);
  assert.equal(merges.length, 4);
  assert.deepEqual([...merges].sort(), Object.values(d.tasks).map((t) => t.evidence.integration.merged_commit).sort());
  assert.equal(git(d.project, 'rev-parse', 'main'), git(d.project, 'rev-parse', ws.integration_branch));
  assert.equal(git(d.project, 'rev-parse', 'main'), d.tasks['DOC-001'].evidence.integration.merged_commit);
  assert.equal(d.run.delivery.head, git(d.project, 'rev-parse', 'main'));
  assert.equal(git(d.project, 'status', '--porcelain'), '', 'the main checkout is clean after delivery');
  // SLUG-001 was corrected on its own branch: two commits there, both merged through one integration merge
  const slugCommits = git(d.project, 'log', '--format=%s', `${ws.base_commit}..${d.tasks['SLUG-001'].result.branch}`).split('\n').filter((l) => /^SLUG-001:/.test(l));
  assert.equal(slugCommits.length, 2);
  assert.match(fs.readFileSync(d.reportPath, 'utf8'), /Workspace strategy: worktree/);
});

test('simulated-agent: demo.cjs reports a usage error with exit code 2 and prints its help', () => {
  const bad = runNode([DEMO_SCRIPT, '--nonsense']);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /unknown argument "--nonsense"/);
  const help = runNode([DEMO_SCRIPT, '--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /--keep/);
  assert.match(help.out, /--git/);
});

test('simulated-agent: without --keep demo.cjs deletes its temporary directory and says so', () => {
  const r = runNode([DEMO_SCRIPT]);
  assert.equal(r.code, 0, r.out);
  const dir = (/^Demo directory: (.+)$/m.exec(r.stdout) || [])[1].trim();
  assert.ok(!fs.existsSync(dir), 'the temporary directory is gone');
  assert.match(r.stdout, /was deleted; run with --keep to keep it/);
});

// ---------------------------------------------------------------------------
// The fixture itself
// ---------------------------------------------------------------------------

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(f, base));
    else out.push(path.relative(base, f).split(path.sep).join('/'));
  }
  return out.sort();
}

function copyFixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'oo-fixture-')));
  roots.push(root);
  const dir = path.join(root, 'project');
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function testsIn(dir, files) {
  return runNode(['--test', ...files], dir);
}

test('the fixture project has the required files, small sources and no hidden rule outside the acceptance test', () => {
  const files = listFiles(FIXTURE);
  assert.deepEqual(files, [
    'README.md', 'acceptance/slugify.acceptance.test.js', 'package.json', 'src/slugify.js', 'src/wordcount.js',
    'test/slugify.test.js', 'test/summary.test.js', 'test/wordcount.test.js',
  ]);
  assert.ok(!files.includes('src/summary.js'), 'summary.js does not exist yet');
  for (const f of files) {
    const lines = fs.readFileSync(path.join(FIXTURE, f), 'utf8').split('\n').length;
    if (f.startsWith('src/')) assert.ok(lines < 40, `${f} has ${lines} lines`);
  }
  assert.match(fs.readFileSync(path.join(FIXTURE, 'README.md'), 'utf8'), /## API\n\n_The API documentation has not been written yet\._/);
  // package.json has no dependencies
  const pkg = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  // the truncation rule is stated nowhere but in the acceptance test: not in the fixture, the request or the specs
  const rule = /truncat|\b40\b|forty|too long|long title|maximum length|max(imum)? ?length|cut (to|off)|shorten/i;
  const others = files.filter((f) => f !== 'acceptance/slugify.acceptance.test.js').map((f) => path.join(FIXTURE, f))
    .concat([path.join(SKILL, 'demo', 'request.md'), path.join(SKILL, 'demo', 'specs.yaml')]);
  for (const f of others) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), rule, `${path.relative(SKILL, f)} must not mention the hidden rule`);
  assert.match(fs.readFileSync(path.join(FIXTURE, 'acceptance', 'slugify.acceptance.test.js'), 'utf8'), /40 characters/);
});

test('the fixture tests fail before the work and pass after a correct implementation; a first slugify from the specification fails only the acceptance test', () => {
  const dir = copyFixture();
  const unit = ['test/slugify.test.js', 'test/wordcount.test.js', 'test/summary.test.js'];
  for (const f of [...unit, 'acceptance/slugify.acceptance.test.js']) {
    assert.notEqual(testsIn(dir, [f]).code, 0, `${f} fails on the stubs`);
  }
  const put = (rel, scripted) => fs.copyFileSync(path.join(SCRIPTED, scripted), path.join(dir, ...rel.split('/')));
  // the first, specification-only slugify and the other correct sources
  put('src/slugify.js', 'slugify.first.js');
  put('src/wordcount.js', 'wordcount.js');
  put('src/summary.js', 'summary.js');
  for (const f of unit) assert.equal(testsIn(dir, [f]).code, 0, `${f} passes with the first implementation`);
  const acc = testsIn(dir, ['acceptance/slugify.acceptance.test.js']);
  assert.notEqual(acc.code, 0, 'the acceptance test fails for an implementation written from the specification alone');
  assert.match(acc.out, /a long title is cut to at most 40 characters/);
  // the corrected slugify passes everything
  put('src/slugify.js', 'slugify.corrected.js');
  assert.equal(testsIn(dir, [...unit, 'acceptance/slugify.acceptance.test.js']).code, 0);
});

test('demo/specs.yaml: four tasks, independent slugify and wordcount with disjoint scopes, summary and documentation chained, acceptance test among the slugify commands', () => {
  const specs = yaml.parse(fs.readFileSync(path.join(SKILL, 'demo', 'specs.yaml'), 'utf8'));
  assert.deepEqual(specs.map((s) => s.task_id), ['SLUG-001', 'WORD-001', 'SUM-001', 'DOC-001']);
  const by = Object.fromEntries(specs.map((s) => [s.task_id, s]));
  assert.deepEqual(by['SLUG-001'].dependencies, []);
  assert.deepEqual(by['WORD-001'].dependencies, []);
  assert.deepEqual(by['SUM-001'].dependencies, ['SLUG-001', 'WORD-001']);
  assert.deepEqual(by['DOC-001'].dependencies, ['SUM-001']);
  assert.equal(by['DOC-001'].kind, 'documentation');
  const scope = (id) => by[id].authorized_files;
  for (const a of scope('SLUG-001')) assert.ok(!scope('WORD-001').includes(a), 'slugify and wordcount scopes are disjoint');
  assert.ok(by['SLUG-001'].verification_commands.some((c) => /acceptance\/slugify\.acceptance\.test\.js/.test(c)));
  // every file a task may change is a file of the fixture (or the one the task creates)
  const known = new Set([...listFiles(FIXTURE), 'src/summary.js']);
  for (const s of specs) for (const f of s.authorized_files) assert.ok(known.has(f), `${s.task_id}: ${f} is a fixture file`);
});
