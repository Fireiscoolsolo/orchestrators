'use strict';
// Failure paths of the oo CLI: invalid reports, worker failures, failed verification, review
// guards, shared-workspace scope attribution, the bounded correction loop, cancellation and
// external side effects.
// SIMULATED AGENTS: "workers" and "reviewers" are test code feeding YAML to oo; no model runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./oo-harness.cjs');

test.after(H.cleanup);

function taskJson(p, id) {
  return fs.readFileSync(path.join(p.runDir(), 'tasks', `${id}.json`), 'utf8');
}

test('simulated-agent: result rejects a malformed or mismatched report with exit 1 and leaves the task unchanged', () => {
  const p = H.project();
  p.ok(['init', 'Bad reports']);
  p.plan([H.spec('A-001', { acceptance_criteria: ['first', 'second'] })]);
  p.ok(['next']);
  p.ok(['started', 'A-001']);
  const before = taskJson(p, 'A-001');
  const bad = [
    ['no report block', 'I did the work, trust me.', /no report block found/],
    ['invalid yaml', '```yaml\ntask_id: A-001\n  status: : completed\n- x\n```\n', /not valid YAML/],
    ['wrong task id', H.report('B-001', { criteria: 2 }), /task_id "B-001" does not match the task "A-001"/],
    ['self_check count', H.report('A-001', { criteria: 1 }), /self_check has 1 entries but the task has 2 acceptance criteria/],
    ['bad status', H.report('A-001', { criteria: 2 }).replace('status: completed', 'status: done'), /status must be one of/],
  ];
  for (const [name, input, re] of bad) {
    const out = p.refused(['result', 'A-001', '--stdin'], { input });
    assert.match(out, re, name);
    assert.match(out, /task state unchanged/, name);
    assert.match(out, /oo worker-failed A-001 --kind invalid_output/, name);
    assert.equal(taskJson(p, 'A-001'), before, `${name}: task file unchanged`);
  }
  assert.equal(p.status('A-001'), 'RUNNING');
  assert.match(p.ok(['result', 'A-001', '--stdin'], { input: H.report('A-001', { criteria: 2 }) }), /IMPLEMENTED/);
  assert.match(p.refused(['result', 'A-001', '--stdin'], { input: H.report('A-001', { criteria: 2 }) }), /A-001 is IMPLEMENTED; a worker result is accepted only while the task is DISPATCHED or RUNNING/);
});

test('simulated-agent: worker-failed retries up to max_retries then FAILED; permission and budget block without retry', () => {
  const p = H.project({ config: 'execution:\n  max_retries: 2\n' });
  p.ok(['init', 'Retries']);
  p.plan([H.spec('A-001'), H.spec('B-001'), H.spec('C-001'), H.spec('D-001')]);
  p.ok(['next']);
  p.ok(['started', 'A-001', 'B-001', 'C-001', 'D-001']);

  let out = p.ok(['worker-failed', 'A-001', '--kind', 'crash', '--reason', 'agent process died']);
  assert.match(out, /A-001 -> READY for retry 1 of 2/);
  assert.match(out, /Escalation advice: /);
  assert.equal(p.task('A-001').retries, 1);
  p.ok(['next']);
  out = p.ok(['result', 'A-001', '--stdin'], { input: H.report('A-001', { status: 'failed', summary: 'could not finish' }) });
  assert.match(out, /reported failed[\s\S]*A-001 -> READY for retry 2 of 2/);
  p.ok(['next']);
  assert.equal(p.task('A-001').attempts, 3);
  out = p.ok(['worker-failed', 'A-001', '--kind', 'timeout', '--reason', 'took too long']);
  assert.match(out, /A-001 -> FAILED \(retry limit 2 reached\)/);
  const a = p.task('A-001');
  assert.equal(a.status, 'FAILED');
  assert.equal(a.failure.kind, 'timeout');
  assert.equal(a.retries, 2);
  assert.equal(a.failures.length, 3);

  out = p.ok(['worker-failed', 'B-001', '--kind', 'permission', '--reason', 'Bash was denied']);
  assert.match(out, /B-001 -> BLOCKED \(permission; never retried automatically\)/);
  assert.equal(p.task('B-001').retries, 0);
  assert.equal(p.task('B-001').block.kind, 'permission');
  out = p.ok(['worker-failed', 'C-001', '--kind', 'budget', '--reason', 'usage limit hit']);
  assert.match(out, /C-001 -> BLOCKED/);
  assert.equal(p.task('C-001').retries, 0);
  out = p.ok(['result', 'D-001', '--stdin'], { input: H.report('D-001', { status: 'blocked', summary: 'needs a decision', issues: ['which format?'] }) });
  assert.equal(p.status('D-001'), 'BLOCKED');
  assert.equal(p.task('D-001').retries, 0);

  p.ok(['unblock', 'D-001', '--reason', 'the user chose a format']);
  p.ok(['next']);
  out = p.ok(['result', 'D-001', '--stdin'], { input: H.report('D-001', { status: 'needs_decomposition', summary: 'too big', proposed_subtasks: [{ title: 'part one' }, { title: 'part two' }] }) });
  assert.match(out, /Proposed subtasks:\n {2}- title: part one\n {2}- title: part two/);
  assert.equal(p.task('D-001').block.kind, 'needs_decomposition');

  assert.match(p.usage(['worker-failed', 'A-001', '--kind', 'meteor', '--reason', 'x']), /--kind must be one of/);
  assert.match(p.usage(['worker-failed', 'A-001', '--kind', 'crash']), /--reason <text> is required/);
  assert.match(p.refused(['worker-failed', 'A-001', '--kind', 'crash', '--reason', 'again']), /A-001 is FAILED; worker failures apply to DISPATCHED or RUNNING/);
});

test('simulated-agent: a failing verification command moves the task to CORRECTION_REQUIRED with the command and its output tail', () => {
  const p = H.project();
  p.ok(['init', 'Failing check']);
  p.plan([H.spec('A-001', { verification_commands: [H.existsCmd('a-001.txt'), H.FAIL_CMD] })]);
  p.ok(['next']);
  p.write('a-001.txt', 'A\n');
  p.ok(['result', 'A-001', '--stdin'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  const out = p.refused(['verify', 'A-001']);
  assert.match(out, /VERIFICATION FAILED: A-001 -> CORRECTION_REQUIRED/);
  assert.match(out, /Failing command: node -e "console\.log\('line one of the failure'\)/);
  assert.match(out, /Exit code: 3/);
  assert.match(out, /Output tail:\n[\s\S]*line one of the failure[\s\S]*boom: expected 2 got 3/);
  assert.match(out, /NEXT: oo correct A-001 --stdin/);
  const t = p.task('A-001');
  assert.equal(t.status, 'CORRECTION_REQUIRED');
  assert.equal(t.evidence.verification.passed, false);
  assert.deepEqual(t.evidence.verification.commands.map((c) => c.exit_code), [0, 3]);
  assert.ok(fs.existsSync(path.join(p.dir, t.evidence.verification.evidence_file)));
});

test('simulated-agent: review approve is refused while verification has not passed or a required independent review is missing', () => {
  const p = H.project();
  p.ok(['init', 'Review guards']);
  p.plan([
    H.spec('A-001'),
    H.spec('B-001', { verification_commands: [H.FAIL_CMD] }),
    H.spec('C-001', { complexity: 5 }),
  ]);
  p.ok(['next']);
  for (const id of ['A-001', 'B-001', 'C-001']) {
    p.write(`${id.toLowerCase()}.txt`, `${id}\n`);
    p.ok(['result', id, '--stdin'], { input: H.report(id, { files: [`${id.toLowerCase()}.txt`] }) });
  }

  // A: verification not run yet
  let out = p.refused(['review', 'A-001', '--stdin'], { input: H.review('A-001') });
  assert.match(out, /verification of A-001 has not passed yet/);
  assert.equal(p.status('A-001'), 'IMPLEMENTED');
  assert.deepEqual(p.task('A-001').evidence.reviews, []);

  // B: verification failed
  p.refused(['verify', 'B-001']);
  out = p.refused(['review', 'B-001', '--stdin'], { input: H.review('B-001') });
  assert.match(out, /B-001 needs a correction/);
  assert.equal(p.status('B-001'), 'CORRECTION_REQUIRED');

  // C: complexity 5 in balanced mode requires an independent review
  p.ok(['verify', 'C-001']);
  out = p.refused(['review', 'C-001', '--stdin'], { input: H.review('C-001') });
  assert.match(out, /NO_INDEPENDENT_REVIEW/);
  assert.match(out, /NEXT: oo review-package C-001/);
  assert.equal(p.status('C-001'), 'REVIEWING');
  assert.deepEqual(p.task('C-001').evidence.reviews, [], 'the refused approval was not stored');

  // regression: a non-orchestrator review without a review package in this round is refused
  const before = taskJson(p, 'C-001');
  const cpBefore = p.checkpointText();
  out = p.refused(['review', 'C-001', '--stdin'], { input: H.review('C-001', { reviewer: 'opus-reviewer' }) });
  assert.match(out, /REFUSED: review of C-001 refused; task state unchanged/);
  assert.match(out, /no review package was issued for C-001 in the current round \(round 0\)/);
  assert.match(out, /NEXT: oo review-package C-001/);
  assert.equal(taskJson(p, 'C-001'), before, 'task file unchanged');
  assert.equal(p.checkpointText(), cpBefore, 'checkpoint unchanged');
  assert.match(p.refused(['review', 'C-001', '--stdin'], { input: H.review('C-001', { reviewer: 'someone-else', verdict: 'request_changes' }) }), /no review package was issued/);
  assert.equal(p.status('C-001'), 'REVIEWING');

  out = p.ok(['review-package', 'C-001']);
  assert.match(out, /Agent call: subagent_type=general-purpose \| model=haiku \| description="C-001 review Task C-001"/);
  const pkg = path.join(p.runDir(), 'packages', 'C-001-review-1.md');
  assert.ok(out.includes(pkg));
  const text = fs.readFileSync(pkg, 'utf8');
  assert.match(text, /^REVIEW TASK C-001/);
  assert.match(text, /## Acceptance criteria\n1\. c-001\.txt exists/);
  assert.match(text, /Changed files observed by the orchestrator:\n- c-001\.txt/);
  assert.match(text, /C-001-verify-1\.txt/);
  assert.match(text, /reviewer: opus-reviewer/);
  assert.equal(p.runRecord().usage.review_calls, 1);

  out = p.ok(['review', 'C-001', '--stdin'], { input: H.review('C-001', { reviewer: 'opus-reviewer' }) });
  assert.match(out, /INDEPENDENT REVIEW RECORDED: C-001 approved by opus-reviewer; C-001 stays REVIEWING/);
  assert.equal(p.status('C-001'), 'REVIEWING');
  out = p.ok(['review', 'C-001', '--stdin'], { input: H.review('C-001') });
  assert.match(out, /APPROVED: C-001 -> APPROVED/);
});

test('simulated-agent: shared-workspace scope: a file outside the scope fails, files of another in-flight task and the state and inbox do not', () => {
  const p = H.project();
  p.ok(['init', 'Scope attribution']);
  p.plan([H.spec('A-001'), H.spec('B-001')]);
  p.ok(['next']);
  p.ok(['started', 'A-001', 'B-001']);
  // both simulated workers write in the same checkout; the orchestrator drafts in the inbox
  p.write('a-001.txt', 'A\n');
  p.write('b-001.txt', 'B partial\n');
  p.write('.opus-inbox/notes.md', 'orchestrator draft\n');
  p.write('.claude/opus-orchestrator/scratch.txt', 'state-directory file\n');
  p.ok(['result', 'A-001', '--stdin'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  let out = p.ok(['verify', 'A-001']);
  assert.match(out, /VERIFICATION PASSED: A-001/);
  assert.match(out, /Changed files: a-001\.txt\n/);
  assert.match(out, /Ignored: b-001\.txt \(inside the scope of B-001, which owned work since this dispatch\)/);
  assert.doesNotMatch(out, /notes\.md|scratch\.txt/);

  // simulated worker B strays outside its scope
  p.write('b-001.txt', 'B final\n');
  p.write('stray.txt', 'not authorized\n');
  p.ok(['result', 'B-001', '--stdin'], { input: H.report('B-001', { files: ['b-001.txt', 'stray.txt'] }) });
  out = p.refused(['verify', 'B-001']);
  assert.match(out, /VERIFICATION FAILED: B-001 -> CORRECTION_REQUIRED/);
  assert.match(out, /files changed outside the authorized scope: stray\.txt/);
  assert.match(out, /Scope violations \(changed outside the authorized files\): stray\.txt/);
  assert.match(out, /Ignored: a-001\.txt \(inside the scope of A-001\)/);
  const v = p.task('B-001').evidence.verification;
  assert.deepEqual(v.scope.violations, ['stray.txt']);
  assert.equal(v.passed, false);
});

test('simulated-agent: the correction loop is bounded and stale verification and reviews do not count', () => {
  const p = H.project();
  p.ok(['init', '--review-rounds', '2', 'Bounded corrections']);
  const check = 'node -e "process.exit(require(\'fs\').readFileSync(\'t-001.txt\',\'utf8\').trim()===\'good\'?0:1)"';
  p.plan([H.spec('T-001', { complexity: 5, verification_commands: [check] })]);
  const work = (content) => {
    p.ok(['next']);
    p.ok(['started', 'T-001']);
    p.write('t-001.txt', content);
    p.ok(['result', 'T-001', '--stdin'], { input: H.report('T-001', { files: ['t-001.txt'] }) });
  };

  // round 0: verified, independently approved, then the orchestrator requests changes
  work('good\n');
  p.ok(['verify', 'T-001']);
  p.ok(['review-package', 'T-001']);
  p.ok(['review', 'T-001', '--stdin'], { input: H.review('T-001', { reviewer: 'opus-reviewer' }) });
  p.ok(['review', 'T-001', '--stdin'], { input: H.review('T-001', { verdict: 'request_changes' }) });
  assert.equal(p.status('T-001'), 'CORRECTION_REQUIRED');
  let out = p.ok(['correct', 'T-001', '--stdin'], { input: H.correction('T-001') });
  assert.match(out, /CORRECTION RECORDED: T-001 round 1 of 2 -> READY/);
  let t = p.task('T-001');
  assert.equal(t.review_round, 1);
  assert.equal(t.evidence.verification, null);
  assert.deepEqual(t.evidence.reviews, []);
  assert.equal(t.evidence.rounds.length, 1);
  assert.equal(t.evidence.rounds[0].reviews.length, 2);
  assert.equal(t.evidence.rounds[0].verification.passed, true);
  assert.equal(t.evidence.rounds[0].review_packages.length, 1, 'the round-0 review package was archived');
  assert.deepEqual(t.evidence.review_packages, []);

  // round 1: the package carries the correction; the archived independent approval no longer counts
  work('good \n');
  const pkg = fs.readFileSync(path.join(p.runDir(), 'packages', 'T-001-d2.md'), 'utf8');
  assert.match(pkg, /## Correction request \(round 1\)\n[\s\S]*Required change: make the check pass/);
  assert.equal(p.task('T-001').correction, null, 'the correction is answered by the new result');
  p.ok(['verify', 'T-001']);
  out = p.refused(['review', 'T-001', '--stdin'], { input: H.review('T-001') });
  assert.match(out, /NO_INDEPENDENT_REVIEW/);
  // regression: the round-0 review package does not cover round 1; a new package is needed
  out = p.refused(['review', 'T-001', '--stdin'], { input: H.review('T-001', { reviewer: 'opus-reviewer' }) });
  assert.match(out, /no review package was issued for T-001 in the current round \(round 1\)/);
  assert.deepEqual(p.task('T-001').evidence.reviews, []);
  p.ok(['review-package', 'T-001']);
  assert.match(p.ok(['review', 'T-001', '--stdin'], { input: H.review('T-001', { reviewer: 'opus-reviewer' }) }), /INDEPENDENT REVIEW RECORDED/);
  p.ok(['review', 'T-001', '--stdin'], { input: H.review('T-001', { verdict: 'request_changes' }) });

  // round 2 needs strategy_change
  out = p.refused(['correct', 'T-001', '--stdin'], { input: H.correction('T-001') });
  assert.match(out, /strategy_change is required from the second correction round on/);
  assert.equal(p.status('T-001'), 'CORRECTION_REQUIRED');
  p.ok(['correct', 'T-001', '--stdin'], { input: H.correction('T-001', { strategy_change: 'rewrite the file from scratch' }) });
  t = p.task('T-001');
  assert.equal(t.review_round, 2);
  assert.equal(t.evidence.rounds.length, 2);

  // round 2 fails verification; a third correction exceeds max_review_rounds 2
  work('bad\n');
  p.refused(['verify', 'T-001']);
  out = p.refused(['correct', 'T-001', '--stdin'], { input: H.correction('T-001', { strategy_change: 'try again' }) });
  assert.match(out, /the correction round limit is reached: 2 of 2 rounds used/);
  assert.match(out, /NEXT: diagnose the failure yourself, then either oo fail T-001/);
  assert.equal(p.status('T-001'), 'CORRECTION_REQUIRED');
  assert.equal(p.task('T-001').review_round, 2);

  // escalation is refused when it repeats the strategy, accepted with a stronger model
  p.ok(['fail', 'T-001', '--reason', 'three rounds did not converge']);
  assert.match(p.refused(['escalate', 'T-001', '--model', 'haiku', '--reason', 'again']), /would repeat the unchanged strategy/);
  out = p.ok(['escalate', 'T-001', '--model', 'opus', '--reason', 'needs a stronger model']);
  assert.match(out, /ESCALATED: T-001 -> READY: role implementation-worker -> implementation-worker, model haiku -> opus/);
  assert.equal(p.task('T-001').routing.model, 'opus');
});

test('simulated-agent: a cancelled task is never dispatched again and its late result is refused', () => {
  const p = H.project();
  p.ok(['init', 'Cancel']);
  p.plan([H.spec('A-001')]);
  p.ok(['next']);
  p.ok(['started', 'A-001']);
  const out = p.ok(['cancel', 'A-001', '--reason', 'the user changed their mind']);
  assert.match(out, /Agents may still be running for A-001; a late result for a cancelled task is refused/);
  p.write('a-001.txt', 'late\n');
  assert.match(p.refused(['result', 'A-001', '--stdin'], { input: H.report('A-001', { files: ['a-001.txt'] }) }), /A-001 was cancelled; a late result for a cancelled task is never applied/);
  assert.match(p.ok(['next']), /NOTHING DISPATCHED: all_done/);
  assert.equal(p.status('A-001'), 'CANCELLED');
  assert.equal(p.task('A-001').attempts, 1);
  assert.match(p.refused(['reopen', 'A-001', '--reason', 'try again']), /needs the user's authorization/);
  assert.match(p.usage(['cancel', 'A-001']), /--reason <text> is required/);
});

test('simulated-agent: an external-side-effect task is not dispatched without a user authorization and is never retried', () => {
  const p = H.project();
  p.ok(['init', 'External effects']);
  p.plan([H.spec('X-001', { side_effects: 'external', title: 'Publish the page' })]);
  let out = p.ok(['next']);
  assert.match(out, /NOTHING DISPATCHED: held for user authorization: X-001/);
  assert.match(out, /X-001: ask the user; only with their consent run oo authorize --task X-001 --side-effects --by user/);
  assert.equal(p.status('X-001'), 'READY');

  assert.match(p.refused(['authorize', '--task', 'X-001', '--side-effects', '--by', 'orchestrator', '--reason', 'seems fine']), /only the user can authorize an external side effect/);
  assert.match(p.usage(['authorize', '--task', 'X-001', '--side-effects', '--by', 'user']), /--reason/);
  p.ok(['authorize', '--task', 'X-001', '--side-effects', '--by', 'user', '--reason', 'the user said publish it']);
  out = p.ok(['next']);
  assert.match(out, /=== X-001 /);
  p.ok(['started', 'X-001']);

  out = p.ok(['worker-failed', 'X-001', '--kind', 'crash', '--reason', 'connection dropped']);
  assert.match(out, /X-001 -> FAILED \(external side effects; never retried automatically\)/);
  assert.equal(p.task('X-001').retries, 0);

  // the authorization covered one dispatch: after a user-authorized reopen it is held again
  p.ok(['reopen', 'X-001', '--reason', 'the user asked to try once more', '--user-authorized']);
  assert.equal(p.status('X-001'), 'READY');
  assert.match(p.ok(['next']), /held for user authorization: X-001/);
});
