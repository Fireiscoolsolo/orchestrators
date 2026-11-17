'use strict';
// End-to-end tests of the fo command line against real git repositories.
// Workers are SIMULATED here: the test plays the worker (creates a worktree, commits,
// writes a completion report). Live agent behaviour is covered by the headless demo, not by this file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('../miniyaml.cjs');

const FO = path.resolve(__dirname, '..', 'fo.cjs');
const INSTALL = path.resolve(__dirname, '..', 'install.cjs');
const tmp = (p) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function fo(cwd, args, input) {
  const r = spawnSync(process.execPath, [FO].concat(args), { cwd, encoding: 'utf8', input: input === undefined ? '' : input });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}
function ok(cwd, args, input) {
  const r = fo(cwd, args, input);
  assert.equal(r.code, 0, `fo ${args.join(' ')} failed:\n${r.all}`);
  return r.out;
}
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

function mkRepo() {
  const repo = tmp('fo-repo-');
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  write(path.join(repo, 'lib', 'calc.js'), 'exports.add = (a, b) => a + b;\n');
  write(path.join(repo, 'checks', 'double.js'), "const assert = require('assert');\nconst { double } = require('../lib/double.js');\nassert.strictEqual(double(2), 4);\nassert.strictEqual(double(-1), -2);\n");
  write(path.join(repo, 'checks', 'triple.js'), "const assert = require('assert');\nconst { triple } = require('../lib/triple.js');\nassert.strictEqual(triple(3), 9, 'triple(3) must be 9');\n");
  write(path.join(repo, 'checks', 'combo.js'), "const assert = require('assert');\nconst { combo } = require('../lib/combo.js');\nassert.strictEqual(combo(2), 10);\n");
  write(path.join(repo, 'notes.txt'), 'original notes\n');
  write(path.join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'initial');
  return repo;
}

const contract = (id, o) => Object.assign({
  task_id: id, title: `Task ${id}`, objective: 'Deliver what the acceptance criteria describe', priority: 'medium',
  dependencies: [], complexity_score: 2, risk_level: 'low', file_scope: ['lib/'],
  acceptance_criteria: ['the check script exits with code 0'], verification: ['run the check script'], verification_commands: [],
}, o);

function start(cwd, requestText) {
  const req = path.join(tmp('fo-req-'), 'request.txt');
  fs.writeFileSync(req, requestText);
  const out = ok(cwd, ['init', '--request-file', req]);
  const runDir = /run_dir: (.+)/.exec(out)[1].trim();
  return { out, runDir, tasks: path.join(runDir, 'tasks') };
}
const putContract = (run, c) => write(path.join(run.tasks, `${c.task_id}.yaml`), yaml.dump(c));
const next = (cwd) => JSON.parse(ok(cwd, ['next', '--json']));
const stateOf = (run) => JSON.parse(fs.readFileSync(path.join(run.runDir, 'state.json'), 'utf8'));
const events = (run) => fs.readFileSync(path.join(run.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

/** Play the worker for one dispatch spec in its own git worktree, as native isolation would. */
function worker(repo, scratch, spec, mutate, reportExtra, opts) {
  const refs = [...spec.prompt.matchAll(/git merge --no-edit ([0-9a-f]{40})/g)].map((m) => m[1]);
  assert.ok(refs.length >= 1, 'the task package tells the worker what to merge first');
  const dir = path.join(scratch, `${spec.task_id}-d${spec.attempt}`);
  const branch = `wt-${spec.task_id}-d${spec.attempt}`.toLowerCase();
  git(repo, 'worktree', 'add', '-b', branch, dir, 'main');
  if (!(opts && opts.skipMerge)) for (const r of refs) git(dir, 'merge', '--no-edit', r);
  const files = mutate(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', `${spec.task_id}: work`);
  const report = Object.assign({
    task_id: spec.task_id, status: 'implemented', summary: `Implemented ${spec.task_id}`, files_changed: files,
    verification: { tests_run: true, tests_passed: true, build_passed: null }, known_issues: [],
    commit: git(dir, 'rev-parse', 'HEAD'), branch, worktree_path: dir,
  }, reportExtra || {});
  const file = path.join(scratch, `${spec.task_id}-d${spec.attempt}.report.md`);
  fs.writeFileSync(file, `Work finished.\n\n\`\`\`yaml\n${yaml.dump(report)}\`\`\`\n`);
  return file;
}
function reviewFile(scratch, id, n, verdict) {
  const approve = verdict !== 'reject';
  const file = path.join(scratch, `${id}.review.${Date.now()}.yaml`);
  fs.writeFileSync(file, yaml.dump({
    task_id: id, reviewer: 'orchestrator', verdict: approve ? 'approve' : 'reject',
    criteria: Array.from({ length: n }, () => ({ met: approve, evidence: 'check output and diff inspected' })),
    findings: approve ? [] : ['the behaviour does not match the criterion'],
  }));
  return file;
}
function correctionFile(scratch, id, failure, change) {
  const file = path.join(scratch, `${id}.correction.${Date.now()}.yaml`);
  fs.writeFileSync(file, yaml.dump({ task_id: id, failure, evidence: 'verification output', expected_behavior: 'the check exits 0', required_change: change, verification: ['re-run the check script'] }));
  return file;
}

test('full run: parallel dispatch, dependency order, failing test, targeted correction, scope violation, integration, delivery', () => {
  const repo = mkRepo();
  const scratch = tmp('fo-wt-');
  fs.appendFileSync(path.join(repo, 'notes.txt'), 'my uncommitted edit\n');
  fs.writeFileSync(path.join(repo, 'scratch.txt'), 'untracked user file\n');

  const run = start(repo, '--max-workers 2 Add double, triple and combo helpers, then document them. Make sure everything works.');
  assert.match(run.out, /max_workers 2/);
  assert.match(run.out, /workspace: native/);
  assert.match(run.out, /uncommitted changes \(notes\.txt, scratch\.txt\)/);
  assert.equal(git(repo, 'status', '--porcelain').split('\n').filter((l) => l.includes('.claude')).length, 0, 'runtime state is git-ignored');

  const noPlan = fo(repo, ['next']);
  assert.equal(noPlan.code, 2);
  assert.match(noPlan.err, /NO_PLAN/);

  putContract(run, contract('A-001', { title: 'Add double', file_scope: ['lib/double.js'], verification_commands: ['node checks/double.js'], dependencies: ['C-001'] }));
  putContract(run, contract('B-001', { title: 'Add triple', file_scope: ['lib/triple.js'], verification_commands: ['node checks/triple.js'] }));
  putContract(run, contract('C-001', { title: 'Add combo', file_scope: ['lib/combo.js'], verification_commands: ['node checks/combo.js'], dependencies: ['A-001', 'B-001'] }));
  putContract(run, contract('D-001', { title: 'Document helpers', assigned_role: 'documentation-worker', file_scope: ['README.md'], dependencies: ['C-001'], acceptance_criteria: ['README.md documents double, triple and combo'], verification: ['read the README against the code'] }));
  const cyc = fo(repo, ['plan']);
  assert.equal(cyc.code, 2);
  assert.match(cyc.err, /dependency cycle/);
  assert.equal(stateOf(run).order.length, 0, 'a rejected plan changes nothing');

  putContract(run, contract('A-001', { title: 'Add double', file_scope: ['lib/double.js'], verification_commands: ['node checks/double.js'] }));
  const plan = ok(repo, ['plan']);
  assert.match(plan, /level 0: A-001, B-001\s+\(parallel candidates\)/);
  assert.match(plan, /level 1: C-001/);
  assert.match(plan, /level 2: D-001/);
  assert.match(plan, /D-001\s+2\s+low\s+light\s+documentation-worker\s+haiku/);

  // two independent tasks go out together; the dependent ones wait
  const b1 = next(repo);
  assert.deepEqual(b1.specs.map((s) => s.task_id), ['A-001', 'B-001']);
  assert.ok(b1.specs.every((s) => s.agent.isolation === 'worktree' && s.agent.model === 'haiku' && s.agent.subagent_type === 'implementation-worker'));
  assert.match(b1.specs[0].prompt, /## Acceptance criteria/);
  assert.match(b1.specs[0].prompt, /lib\/double\.js/);
  assert.equal(next(repo).specs.length, 0, 'nothing else is dispatchable while both run');
  ok(repo, ['started', 'A-001', 'B-001']);

  const early = fo(repo, ['review', 'B-001', '--file', reviewFile(scratch, 'B-001', 1)]);
  assert.equal(early.code, 2, 'a running task cannot be reviewed');

  // A: correct implementation
  const repA = worker(repo, scratch, b1.specs[0], (dir) => { write(path.join(dir, 'lib', 'double.js'), 'exports.double = (x) => x * 2;\n'); return ['lib/double.js']; });
  const verA = ok(repo, ['report', 'A-001', '--file', repA, '--verify']);
  assert.match(verA, /PASS \[command\] node checks\/double\.js \(exit 0/);
  assert.match(verA, /PASS \[scope\] file scope/);
  assert.match(verA, /-> REVIEWING/);
  assert.equal(fo(repo, ['integrate', 'A-001']).code, 2, 'unreviewed work cannot be integrated');
  const intA = ok(repo, ['review', 'A-001', '--file', reviewFile(scratch, 'A-001', 1), '--integrate']);
  assert.match(intA, /-> COMPLETED \(merge [0-9a-f]{10}\)/);
  const integration = stateOf(run).project.git.integration_branch;
  assert.match(git(repo, 'show', `${integration}:lib/double.js`), /double/);
  assert.ok(!fs.existsSync(path.join(repo, 'lib', 'double.js')), 'the user checkout is untouched until delivery');

  // B: the worker claims success, the independent check fails
  const repB = worker(repo, scratch, b1.specs[1], (dir) => { write(path.join(dir, 'lib', 'triple.js'), 'exports.triple = (x) => x * 2;\n'); return ['lib/triple.js']; });
  const verB = ok(repo, ['report', 'B-001', '--file', repB, '--verify']);
  assert.match(verB, /FAIL \[command\] node checks\/triple\.js \(exit 1/);
  assert.match(verB, /triple\(3\) must be 9/, 'the failing output is shown so a targeted correction can be written');
  assert.match(verB, /-> CORRECTION_REQUIRED/);
  const premature = fo(repo, ['review', 'B-001', '--file', reviewFile(scratch, 'B-001', 1)]);
  assert.equal(premature.code, 2);
  assert.match(premature.err, /WRONG_STATE/, 'a failed test blocks approval');
  assert.equal(fo(repo, ['integrate', 'B-001']).code, 2);
  assert.match(fs.readFileSync(path.join(repo, '.claude', 'fable-orchestrator', 'learning', 'observations.jsonl'), 'utf8'), /claim_mismatch/);
  assert.equal(next(repo).specs.length, 0, 'C-001 stays put while its dependency is uncorrected');

  const corr = ok(repo, ['correct', 'B-001', '--file', correctionFile(scratch, 'B-001', 'triple(3) returns 6', 'multiply by 3 in lib/triple.js')]);
  assert.match(corr, /correction round 1 of 3/);
  const b2 = next(repo);
  assert.deepEqual(b2.specs.map((s) => [s.task_id, s.attempt]), [['B-001', 2]]);
  assert.match(b2.specs[0].prompt, /## Correction request \(round 1\)/);
  assert.match(b2.specs[0].prompt, /multiply by 3 in lib\/triple\.js/);
  ok(repo, ['started', 'B-001']);
  const repB2 = worker(repo, scratch, b2.specs[0], (dir) => {
    assert.match(fs.readFileSync(path.join(dir, 'lib', 'triple.js'), 'utf8'), /x \* 2/, 'the correction starts from the previous attempt');
    write(path.join(dir, 'lib', 'triple.js'), 'exports.triple = (x) => x * 3;\n');
    return ['lib/triple.js'];
  });
  assert.match(ok(repo, ['report', 'B-001', '--file', repB2, '--verify']), /-> REVIEWING/);
  assert.match(ok(repo, ['review', 'B-001', '--file', reviewFile(scratch, 'B-001', 1), '--integrate']), /Now ready: C-001/);

  // C: depends on both; first attempt strays outside its scope
  const b3 = next(repo);
  assert.deepEqual(b3.specs.map((s) => s.task_id), ['C-001']);
  ok(repo, ['started', 'C-001']);
  const repC = worker(repo, scratch, b3.specs[0], (dir) => {
    assert.ok(fs.existsSync(path.join(dir, 'lib', 'double.js')) && fs.existsSync(path.join(dir, 'lib', 'triple.js')), 'integrated dependencies are visible to the dependent task');
    write(path.join(dir, 'lib', 'combo.js'), "const { double } = require('./double.js');\nconst { triple } = require('./triple.js');\nexports.combo = (x) => double(x) + triple(x);\n");
    write(path.join(dir, 'lib', 'extra.js'), '// not asked for\n');
    return ['lib/combo.js'];
  });
  const verC = ok(repo, ['report', 'C-001', '--file', repC, '--verify']);
  assert.match(verC, /PASS \[command\] node checks\/combo\.js/);
  assert.match(verC, /FAIL \[scope\] file scope - modified outside the authorized scope: lib\/extra\.js/);
  assert.match(verC, /-> CORRECTION_REQUIRED/);
  ok(repo, ['correct', 'C-001', '--file', correctionFile(scratch, 'C-001', 'lib/extra.js was created outside the file scope', 'remove lib/extra.js')]);
  const b4 = next(repo);
  ok(repo, ['started', 'C-001']);
  const repC2 = worker(repo, scratch, b4.specs[0], (dir) => { fs.unlinkSync(path.join(dir, 'lib', 'extra.js')); return ['lib/combo.js']; });
  assert.match(ok(repo, ['report', 'C-001', '--file', repC2, '--verify']), /-> REVIEWING/);
  ok(repo, ['review', 'C-001', '--file', reviewFile(scratch, 'C-001', 1), '--integrate']);

  // D: documentation has no command; it needs a recorded manual check
  const b5 = next(repo);
  assert.equal(b5.specs[0].agent.subagent_type, 'documentation-worker');
  ok(repo, ['started', 'D-001']);
  const repD = worker(repo, scratch, b5.specs[0], (dir) => { fs.appendFileSync(path.join(dir, 'README.md'), '\n## Helpers\n\n- double(x)\n- triple(x)\n- combo(x)\n'); return ['README.md']; },
    { verification: { tests_run: false, tests_passed: null, build_passed: null } });
  assert.match(ok(repo, ['report', 'D-001', '--file', repD]), /-> IMPLEMENTED/);
  const noEvidence = fo(repo, ['verify', 'D-001']);
  assert.equal(noEvidence.code, 2);
  assert.match(noEvidence.err, /NO_VERIFICATION_EVIDENCE/);
  ok(repo, ['check', 'D-001', '--name', 'README documents the three helpers', '--result', 'pass', '--note', 'read README.md in the task checkout against lib/*.js']);
  assert.match(ok(repo, ['verify', 'D-001']), /PASS \[manual\] README documents the three helpers/);
  const last = ok(repo, ['review', 'D-001', '--file', reviewFile(scratch, 'D-001', 1), '--integrate']);
  assert.match(last, /All tasks finished/);
  assert.match(ok(repo, ['next']), /NOTHING TO DISPATCH \(COMPLETE\)/);

  // ordering evidence from the event log
  const ev = events(run);
  const at = (task, to) => ev.find((e) => e.type === 'transition' && e.task === task && e.to === to).seq;
  assert.ok(at('B-001', 'DISPATCHED') < at('A-001', 'IMPLEMENTED'), 'A and B were in flight at the same time');
  assert.ok(at('C-001', 'DISPATCHED') > at('A-001', 'COMPLETED') && at('C-001', 'DISPATCHED') > at('B-001', 'COMPLETED'), 'C waited for both dependencies');
  assert.ok(at('D-001', 'DISPATCHED') > at('C-001', 'COMPLETED'));

  // delivery leaves the user's own changes alone
  const delivered = ok(repo, ['deliver']);
  assert.match(delivered, /DELIVERY: delivered/);
  for (const f of ['double.js', 'triple.js', 'combo.js']) assert.ok(fs.existsSync(path.join(repo, 'lib', f)));
  assert.ok(!fs.existsSync(path.join(repo, 'lib', 'extra.js')));
  assert.match(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), /combo\(x\)/);
  assert.equal(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8'), 'original notes\nmy uncommitted edit\n');
  assert.equal(fs.readFileSync(path.join(repo, 'scratch.txt'), 'utf8'), 'untracked user file\n');
  assert.deepEqual(spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort(), [' M notes.txt', '?? scratch.txt']);
  for (const c of ['double', 'triple', 'combo']) assert.equal(spawnSync(process.execPath, [`checks/${c}.js`], { cwd: repo }).status, 0);

  const report = ok(repo, ['final-report']);
  assert.match(report, /\*\*COMPLETE\*\* \(4 of 4 tasks completed\)/);
  assert.match(report, /Delivery: delivered/);
  assert.match(report, /FAIL \[command\] node checks\/triple\.js/);
  assert.match(report, /Correction round 1: triple\(3\) returns 6/);
  assert.match(report, /B-001 Add triple \| COMPLETED \| implementation-worker \/ haiku \| 2 \| 1 \|/);
  assert.match(report, /Agent dispatches recorded: 6/);
  assert.match(ok(repo, ['status']), /COMPLETE/);

  const clean = ok(repo, ['cleanup']);
  assert.match(clean, /removed integration worktree/);
  assert.equal(git(repo, 'branch', '--list', 'fable/*'), '');
  assert.equal(git(repo, 'branch', '--list', 'wt-*'), '');
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1);
  assert.match(ok(repo, ['learn']), /No proposal meets the evidence threshold yet/);
});

test('resume: tasks interrupted in flight are retried within the limit, then blocked; escalation changes the route', () => {
  const repo = mkRepo();
  const run = start(repo, 'Add a helper');
  putContract(run, contract('R-001', { file_scope: ['lib/helper.js'], verification_commands: ['node -e "process.exit(0)"'] }));
  ok(repo, ['plan']);
  for (const expected of [/retry 1\/2/, /retry 2\/2/]) {
    assert.equal(next(repo).specs.length, 1);
    ok(repo, ['started', 'R-001']);
    const out = ok(repo, ['resume']);
    assert.match(out, expected);
    assert.match(out, /ORIGINAL REQUEST:\s+Add a helper/);
  }
  next(repo);
  ok(repo, ['started', 'R-001']);
  assert.match(ok(repo, ['resume']), /R-001: was in flight when the run stopped -> BLOCKED/);
  assert.equal(stateOf(run).tasks['R-001'].block.kind, 'retries_exhausted');
  assert.equal(next(repo).specs.length, 0, 'a blocked task is not re-dispatched silently');

  const same = fo(repo, ['escalate', 'R-001', '--kind', 'model', '--model', 'haiku', '--reason', 'try again']);
  assert.equal(same.code, 2);
  assert.match(same.err, /NO_MEANINGFUL_CHANGE/);
  assert.match(ok(repo, ['escalate', 'R-001', '--kind', 'model', '--reason', 'three interrupted attempts on haiku']), /implementation-worker on sonnet \(standard\); state READY/);
  const spec = next(repo).specs[0];
  assert.equal(spec.agent.model, 'sonnet');
  assert.equal(spec.attempt, 4);

  ok(repo, ['started', 'R-001']);
  assert.match(ok(repo, ['worker-failed', 'R-001', '--kind', 'permission', '--reason', 'Bash was denied']), /-> BLOCKED/);
  const late = fo(repo, ['report', 'R-001', '--file', path.join(run.runDir, 'request.md')]);
  assert.notEqual(late.code, 0, 'a report for a task that is no longer running is refused');
});

test('plan-only stops before dispatch; --resume executes the accepted plan; --status reads the run', () => {
  const repo = mkRepo();
  const run = start(repo, '--plan-only --mode thorough Add a helper');
  assert.match(run.out, /PLAN-ONLY/);
  putContract(run, contract('P-001', { complexity_score: 5, file_scope: ['lib/helper.js'], verification_commands: ['node -e "process.exit(0)"'] }));
  const plan = ok(repo, ['plan']);
  assert.match(plan, /PLAN-ONLY: present this plan to the user and stop/);
  assert.match(plan, /orchestrator \+ 1 independent/, 'thorough mode asks for an independent review at complexity 5');
  const refused = fo(repo, ['next']);
  assert.equal(refused.code, 3);
  assert.match(refused.err, /PLAN_ONLY/);
  assert.match(ok(repo, ['init', '--status']), /PLANNED|plan-only/);
  assert.match(ok(repo, ['init', '--resume']), /resuming executes the accepted plan/);
  const spec = next(repo).specs[0];
  assert.deepEqual([spec.agent.model, spec.agent.effort], ['sonnet', 'high']);
  const none = fo(repo, ['init']);
  assert.equal(none.code, 2);
  assert.match(none.err, /NO_REQUEST/);
  const bad = fo(repo, ['init', '--mode', 'turbo', 'do it']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /BAD_ARGUMENTS/);
});

test('independent review: the reviewer prompt is generated and the orchestrator alone cannot approve', () => {
  const repo = mkRepo();
  const scratch = tmp('fo-wt-');
  const run = start(repo, '--mode maximum Add double');
  putContract(run, contract('A-001', { file_scope: ['lib/double.js'], verification_commands: ['node checks/double.js'] }));
  ok(repo, ['plan']);
  const spec = next(repo).specs[0];
  ok(repo, ['started', 'A-001']);
  const rep = worker(repo, scratch, spec, (dir) => { write(path.join(dir, 'lib', 'double.js'), 'exports.double = (x) => x * 2;\n'); return ['lib/double.js']; });
  assert.match(ok(repo, ['report', 'A-001', '--file', rep, '--verify']), /1 independent review\(s\) required first/);
  assert.match(ok(repo, ['review', 'A-001', '--file', reviewFile(scratch, 'A-001', 1)]), /approval still needs 1 independent review-worker approval/);
  const pkg = ok(repo, ['review-package', 'A-001']);
  assert.match(pkg, /subagent_type=review-worker/);
  assert.match(pkg, /git diff [0-9a-f]{40}\.\.\.[0-9a-f]{40}/);
  const indep = path.join(scratch, 'indep.yaml');
  fs.writeFileSync(indep, yaml.dump({ task_id: 'A-001', reviewer: 'review-worker', perspective: 'correctness', verdict: 'approve', criteria: [{ met: true, evidence: 'ran node checks/double.js: exit 0' }], findings: [] }));
  assert.match(ok(repo, ['review', 'A-001', '--file', indep]), /A-001: APPROVED/);
  assert.equal(stateOf(run).budget.agent_calls, 2, 'the reviewer dispatch is counted');
});

test('limits: correction rounds and the agent-call budget stop the run and ask for the user', () => {
  const repo = mkRepo();
  const scratch = tmp('fo-wt-');
  write(path.join(repo, '.claude', 'fable-orchestrator', 'config.yaml'), 'budget:\n  agent_call_limit: 2\n');
  const run = start(repo, '--review-rounds 1 Add triple and double');
  putContract(run, contract('B-001', { file_scope: ['lib/triple.js'], verification_commands: ['node checks/triple.js'] }));
  putContract(run, contract('A-001', { file_scope: ['lib/double.js'], verification_commands: ['node checks/double.js'], dependencies: ['B-001'] }));
  ok(repo, ['plan']);
  const wrong = (dir) => { write(path.join(dir, 'lib', 'triple.js'), `exports.triple = (x) => x * 2; // ${Date.now()}\n`); return ['lib/triple.js']; };
  const spec = next(repo).specs[0];
  ok(repo, ['started', 'B-001']);
  ok(repo, ['report', 'B-001', '--file', worker(repo, scratch, spec, wrong), '--verify']);
  ok(repo, ['correct', 'B-001', '--file', correctionFile(scratch, 'B-001', 'triple(3) returns 6', 'multiply by 3')]);
  const batch = ok(repo, ['next']);
  assert.match(batch, /DISPATCH 1 task/);
  assert.match(batch, /BUDGET LIMIT: agent call limit reached \(2\/2\)/);
  const st = stateOf(run);
  assert.equal(st.budget.agent_calls, 2);
  assert.equal(st.tasks['B-001'].state, 'DISPATCHED');
  ok(repo, ['started', 'B-001']);
  const a2 = st.tasks['B-001'].attempts[1];
  const again = worker(repo, scratch, { task_id: 'B-001', attempt: 2, prompt: a2.start_refs.map((r) => `git merge --no-edit ${r}`).join(' ') }, wrong);
  assert.match(ok(repo, ['report', 'B-001', '--file', again, '--verify']), /Correction limit reached: escalate to the user/);
  const limit = fo(repo, ['correct', 'B-001', '--file', correctionFile(scratch, 'B-001', 'still 6', 'multiply by 3')]);
  assert.equal(limit.code, 3);
  assert.match(limit.err, /CORRECTION_LIMIT/);
  assert.match(limit.err, /Do not raise it yourself/);

  const notUser = fo(repo, ['authorize', 'B-001', '--extra-rounds', '1', '--by', 'orchestrator', '--reason', 'I think so']);
  assert.equal(notUser.code, 3);
  ok(repo, ['authorize', 'B-001', '--extra-rounds', '1', '--by', 'user', '--reason', 'user said one more try']);
  const c2 = path.join(scratch, 'c2.yaml');
  fs.writeFileSync(c2, yaml.dump({ task_id: 'B-001', failure: 'still 6', evidence: 'log', expected_behavior: '9', required_change: 'multiply by 3', verification: ['node checks/triple.js'] }));
  const needsChange = fo(repo, ['correct', 'B-001', '--file', c2]);
  assert.equal(needsChange.code, 2);
  assert.match(needsChange.err, /must change something/);
  fs.writeFileSync(c2, yaml.dump({ task_id: 'B-001', failure: 'still 6', evidence: 'log', expected_behavior: '9', required_change: 'multiply by 3', verification: ['node checks/triple.js'], strategy_change: { kind: 'model', detail: 'two misses on haiku' } }));
  assert.match(ok(repo, ['correct', 'B-001', '--file', c2]), /implementation-worker on sonnet/);

  const stopped = ok(repo, ['next']);
  assert.match(stopped, /BUDGET LIMIT: agent call limit reached \(2\/2\)/);
  assert.equal(stateOf(run).tasks['B-001'].state, 'READY', 'nothing is dispatched past the limit');
  ok(repo, ['authorize', '--extra-agent-calls', '1', '--by', 'user', '--reason', 'user approved one more call']);
  assert.equal(next(repo).specs.length, 1);
});

test('integration: an interrupted merge is recovered; a merge conflict is aborted, sent back, and resolved by a correction', () => {
  const repo = mkRepo();
  const scratch = tmp('fo-wt-');
  const run = start(repo, 'Change add twice');
  const noop = ['node -e "process.exit(0)"'];
  putContract(run, contract('A-001', { file_scope: ['lib/calc.js'], verification_commands: noop }));
  putContract(run, contract('B-001', { file_scope: ['lib/calc.js'], verification_commands: noop, dependencies: ['A-001'] }));
  ok(repo, ['plan']);
  const sA = next(repo).specs[0];
  ok(repo, ['started', 'A-001']);
  const repA = worker(repo, scratch, sA, (dir) => { write(path.join(dir, 'lib', 'calc.js'), 'exports.add = (a, b) => a + b; // from A\n'); return ['lib/calc.js']; });
  assert.match(ok(repo, ['report', 'A-001', '--file', repA, '--verify']), /-> REVIEWING/);
  assert.match(ok(repo, ['review', 'A-001', '--file', reviewFile(scratch, 'A-001', 1)]), /A-001: APPROVED/);

  // simulate a crash in the middle of integrating A: the state says INTEGRATING and a merge is half done
  const st = stateOf(run);
  const integ = st.project.git.integration_path;
  git(integ, 'merge', '--no-ff', '--no-commit', st.tasks['A-001'].attempts[0].commit);
  st.tasks['A-001'].state = 'INTEGRATING';
  fs.writeFileSync(path.join(run.runDir, 'state.json'), JSON.stringify(st));
  assert.match(ok(repo, ['resume']), /A-001: integration was interrupted -> APPROVED/);
  assert.notEqual(spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: integ }).status, 0, 'the half-finished merge was aborted');
  assert.match(ok(repo, ['integrate', 'A-001']), /-> COMPLETED/);
  const tipAfterA = git(integ, 'rev-parse', 'HEAD');

  // B skips the "merge first" step and edits the same line from the old base: a real conflict
  const sB = next(repo).specs[0];
  ok(repo, ['started', 'B-001']);
  const repB = worker(repo, scratch, sB, (dir) => { write(path.join(dir, 'lib', 'calc.js'), 'exports.add = (a, b) => b + a; // from B\n'); return ['lib/calc.js']; }, null, { skipMerge: true });
  const verB = ok(repo, ['report', 'B-001', '--file', repB, '--verify']);
  assert.match(verB, /the initial merge was skipped/);
  assert.match(verB, /-> REVIEWING/);
  const conflict = ok(repo, ['review', 'B-001', '--file', reviewFile(scratch, 'B-001', 1), '--integrate']);
  assert.match(conflict, /CONFLICT \(merge aborted, nothing changed\): lib\/calc\.js/);
  assert.match(conflict, /-> CORRECTION_REQUIRED/);
  assert.equal(git(integ, 'rev-parse', 'HEAD'), tipAfterA, 'the integration branch is exactly as it was');
  assert.equal(git(integ, 'status', '--porcelain'), '', 'no half-merged files are left behind');
  assert.match(fs.readFileSync(path.join(repo, '.claude', 'fable-orchestrator', 'learning', 'observations.jsonl'), 'utf8'), /integration_conflict/);

  // the correction worker starts from the previous attempt, merges the integration tip and resolves the conflict
  ok(repo, ['correct', 'B-001', '--file', correctionFile(scratch, 'B-001', 'merge conflict in lib/calc.js', 'merge the integration branch and keep both changes')]);
  const sB2 = next(repo).specs[0];
  ok(repo, ['started', 'B-001']);
  const refs = [...sB2.prompt.matchAll(/git merge --no-edit ([0-9a-f]{40})/g)].map((m) => m[1]);
  assert.equal(refs.length, 2, 'a correction is told to merge the previous attempt and then the integration tip');
  const dir = path.join(scratch, 'B-001-d2');
  git(repo, 'worktree', 'add', '-b', 'wt-b-001-d2', dir, 'main');
  git(dir, 'merge', '--no-edit', refs[0]);
  assert.notEqual(spawnSync('git', ['merge', '--no-edit', refs[1]], { cwd: dir }).status, 0, 'the worker meets the same conflict in its own worktree');
  write(path.join(dir, 'lib', 'calc.js'), 'exports.add = (a, b) => b + a; // from A and B\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'B-001: resolve the conflict with A-001');
  const rep2 = path.join(scratch, 'B-001-d2.report.yaml');
  fs.writeFileSync(rep2, yaml.dump({
    task_id: 'B-001', status: 'implemented', summary: 'Merged the integration branch and resolved lib/calc.js', files_changed: ['lib/calc.js'],
    verification: { tests_run: true, tests_passed: true, build_passed: null }, known_issues: [], commit: git(dir, 'rev-parse', 'HEAD'), branch: 'wt-b-001-d2', worktree_path: dir,
  }));
  assert.match(ok(repo, ['report', 'B-001', '--file', rep2, '--verify']), /-> REVIEWING/);
  assert.match(ok(repo, ['review', 'B-001', '--file', reviewFile(scratch, 'B-001', 1), '--integrate']), /-> COMPLETED/);
  assert.match(git(integ, 'show', 'HEAD:lib/calc.js'), /from A and B/);
  assert.match(ok(repo, ['deliver']), /DELIVERY: delivered/);
  assert.match(fs.readFileSync(path.join(repo, 'lib', 'calc.js'), 'utf8'), /from A and B/);
});

test('shared workspace fallback: no git, overlapping scopes serialized, out-of-scope edits detected', () => {
  const dir = tmp('fo-plain-');
  write(path.join(dir, 'src', 'a.js'), 'module.exports = 1;\n');
  const run = start(dir, 'Change a and b');
  assert.match(run.out, /workspace: shared/);
  assert.match(run.out, /not a git repository/);
  putContract(run, contract('S-001', { file_scope: ['src/'], verification_commands: ['node -e "process.exit(0)"'] }));
  putContract(run, contract('S-002', { file_scope: ['src/a.js'], verification_commands: ['node -e "process.exit(0)"'] }));
  assert.match(ok(dir, ['plan']), /S-001 and S-002 share file scope and have no dependency/);
  const batch = next(dir);
  assert.deepEqual(batch.specs.map((s) => s.task_id), ['S-001']);
  assert.equal(batch.specs[0].agent.isolation, null);
  assert.match(batch.specs[0].prompt, /shared project directory/);
  assert.match(batch.deferred.find((d) => d.id === 'S-002').reason, /overlaps S-001/);
  ok(dir, ['started', 'S-001']);
  write(path.join(dir, 'src', 'a.js'), 'module.exports = 2;\n');
  write(path.join(dir, 'other.txt'), 'stray\n');
  const rep = path.join(dir, '..', `${path.basename(dir)}-report.yaml`);
  fs.writeFileSync(rep, yaml.dump({ task_id: 'S-001', status: 'implemented', summary: 'changed a', files_changed: ['src/a.js'], verification: { tests_run: true, tests_passed: true, build_passed: null }, known_issues: [] }));
  const ver = ok(dir, ['report', 'S-001', '--file', rep, '--verify']);
  assert.match(ver, /FAIL \[scope\] file scope - modified outside the authorized scope: other\.txt/);
  assert.match(ok(dir, ['deliver']), /DELIVERY: in_place/);
});

test('recovery: an unreadable state file is restored from the backup and the loss is reported', () => {
  const repo = mkRepo();
  const run = start(repo, 'Add a helper');
  putContract(run, contract('R-001', { file_scope: ['lib/helper.js'], verification_commands: ['node -e "process.exit(0)"'] }));
  ok(repo, ['plan']);
  ok(repo, ['decision', 'Assumed the helper is synchronous']);
  fs.writeFileSync(path.join(run.runDir, 'state.json'), '{"schema":1,"run_id":');
  assert.match(ok(repo, ['status']), /WARNING: state\.json was unreadable; showing state\.json\.bak/);
  const rec = ok(repo, ['recover']);
  assert.match(rec, /RECOVERED from state\.json\.bak/);
  assert.match(rec, /event\(s\) happened after that copy/);
  assert.match(rec, /decision/);
  assert.doesNotMatch(ok(repo, ['status']), /WARNING/);
  assert.equal(stateOf(run).tasks['R-001'].state, 'READY');
});

test('standard input: request, contracts, report, review and correction are all accepted without writing files', () => {
  const repo = mkRepo();
  const scratch = tmp('fo-wt-');
  const init = ok(repo, ['init', '--stdin'], '--mode fast --max-workers 4\nAdd double and triple helpers.\nKeep "quotes", $VARS and `backticks` intact.\n');
  assert.match(init, /mode fast/);
  assert.match(init, /Keep "quotes", \$VARS and `backticks` intact\./);
  const runDir = /run_dir: (.+)/.exec(init)[1].trim();
  const docs = [
    yaml.dump(contract('A-001', { file_scope: ['lib/double.js'], verification_commands: ['node checks/double.js'] })),
    yaml.dump(contract('B-001', { file_scope: ['lib/triple.js'], verification_commands: ['node checks/triple.js'] })),
  ].join('---\n');
  assert.match(ok(repo, ['plan', '--stdin'], docs), /level 0: A-001, B-001/);
  assert.ok(fs.existsSync(path.join(runDir, 'tasks', 'A-001.yaml')) && fs.existsSync(path.join(runDir, 'tasks', 'B-001.yaml')));
  const bad = fo(repo, ['plan', '--stdin'], 'task_id: nope\ntitle: x\n');
  assert.equal(bad.code, 2);
  assert.match(bad.err, /task_id "nope" must look like/);
  assert.equal(fo(repo, ['plan', '--stdin'], '').code, 1);

  // the inbox: a git-ignored drafts folder outside .claude, emptied at the start of each run
  const inbox = path.join(repo, '.fable-inbox');
  assert.match(init, /\.fable-inbox[\\/]contracts\.yaml/);
  assert.ok(fs.existsSync(path.join(inbox, '.gitignore')));
  assert.equal(git(repo, 'status', '--porcelain'), '', 'neither the inbox nor the run state shows up in git status');
  fs.writeFileSync(path.join(inbox, 'contracts.yaml'), docs);
  assert.match(ok(repo, ['plan', '--file', path.join(inbox, 'contracts.yaml')]), /level 0: A-001, B-001/);
  assert.match(ok(repo, ['decision', 'Assumed helpers are synchronous', 'Assumed CommonJS modules']), /2 decision\(s\) recorded/);
  assert.match(ok(repo, ['decision', 'one', 'unquoted', 'sentence']), /1 decision\(s\) recorded/);

  const specs = next(repo).specs;
  assert.equal(specs.length, 2);
  ok(repo, ['started', 'A-001', 'B-001']);
  const repA = fs.readFileSync(worker(repo, scratch, specs[0], (dir) => { write(path.join(dir, 'lib', 'double.js'), 'exports.double = (x) => x * 2;\n'); return ['lib/double.js']; }), 'utf8');
  assert.match(ok(repo, ['report', 'A-001', '--verify', '--stdin'], repA), /-> REVIEWING/);
  const missing = fo(repo, ['review', 'A-001', '--integrate']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /--stdin \(pipe or heredoc\) or --file/);
  const rv = yaml.dump({ task_id: 'A-001', reviewer: 'orchestrator', verdict: 'approve', criteria: [{ met: true, evidence: 'node checks/double.js exit 0; diff read' }], findings: [] });
  assert.match(ok(repo, ['review', 'A-001', '--integrate', '--stdin'], rv), /-> COMPLETED/);

  const repB = fs.readFileSync(worker(repo, scratch, specs[1], (dir) => { write(path.join(dir, 'lib', 'triple.js'), 'exports.triple = (x) => x + x;\n'); return ['lib/triple.js']; }), 'utf8');
  assert.match(ok(repo, ['report', 'B-001', '--verify', '--stdin'], repB), /-> CORRECTION_REQUIRED/);
  const corr = yaml.dump({ task_id: 'B-001', failure: 'triple(3) returns 6', evidence: 'evidence/B-001-c1-v1.log', expected_behavior: 'triple(3) is 9', required_change: 'multiply by 3', verification: ['node checks/triple.js'] });
  assert.match(ok(repo, ['correct', 'B-001', '--stdin'], corr), /correction round 1 of 3/);
  const amended = yaml.dump(contract('B-001', { file_scope: ['lib/triple.js', 'lib/util.js'], verification_commands: ['node checks/triple.js'] }));
  const notNow = fo(repo, ['amend', 'B-001', '--reason', 'needs a util file', '--stdin'], amended);
  assert.equal(notNow.code, 0, notNow.all);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')).tasks['B-001'].contract.file_scope, ['lib/triple.js', 'lib/util.js']);
});

test('self-check and installer: files land in .claude, unmanaged agent files are never overwritten', () => {
  const repo = mkRepo();
  assert.equal(fo(repo, ['self-check']).code, 0);
  const target = tmp('fo-install-');
  write(path.join(target, '.claude', 'agents', 'review-worker.md'), 'my own reviewer\n');
  const run = (args) => spawnSync(process.execPath, [INSTALL].concat(args), { encoding: 'utf8' });
  const first = run(['--project', target]);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(fs.existsSync(path.join(target, '.claude', 'skills', 'fable-orchestrator', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(target, '.claude', 'skills', 'fable-orchestrator', 'scripts', 'fo.cjs')));
  for (const a of ['opus-executor', 'implementation-worker', 'research-worker', 'test-worker', 'debug-worker', 'integration-worker', 'documentation-worker']) {
    assert.ok(fs.existsSync(path.join(target, '.claude', 'agents', `${a}.md`)), `${a} installed`);
  }
  assert.match(first.stdout, /review-worker\.md: SKIPPED/);
  assert.equal(fs.readFileSync(path.join(target, '.claude', 'agents', 'review-worker.md'), 'utf8'), 'my own reviewer\n');
  assert.match(run(['--project', target]).stdout, /agent opus-executor\.md: up to date/);
  assert.equal(run(['--project', target, '--force']).status, 0);
  assert.match(fs.readFileSync(path.join(target, '.claude', 'agents', 'review-worker.md'), 'utf8'), /managed-by: fable-orchestrator/);
  const installed = spawnSync(process.execPath, [path.join(target, '.claude', 'skills', 'fable-orchestrator', 'scripts', 'fo.cjs'), 'self-check', '--project', target], { encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.match(installed.stdout, /ok\s+agent definitions installed/);
  const un = run(['--project', target, '--uninstall']);
  assert.equal(un.status, 0);
  assert.ok(!fs.existsSync(path.join(target, '.claude', 'agents', 'opus-executor.md')));
});
