'use strict';
// Budget enforcement, recovery after a killed process, the final report and the improvement
// flow (observe, learn, proposals) through the oo CLI.
// SIMULATED AGENTS: "workers" are test code feeding YAML reports to oo; no model runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const H = require('./oo-harness.cjs');
const yaml = require('../scripts/lib/yaml.cjs');

test.after(H.cleanup);

test('simulated-agent: agent_call_limit 2 refuses the third dispatch until the user authorizes more', () => {
  // worktree strategy: writers may be dispatched together (a shared workspace serializes them)
  const p = H.project({ git: true, config: 'budget:\n  agent_call_limit: 2\n' });
  p.ok(['init', 'Budget']);
  p.plan([H.spec('A-001'), H.spec('B-001'), H.spec('C-001')]);
  let out = p.ok(['next']);
  assert.match(out, /DISPATCH 2 task\(s\)/);
  assert.match(out, /C-001: budget: the agent call budget has no calls left for it/);
  assert.equal(p.status('C-001'), 'READY');

  out = p.refused(['next']);
  assert.match(out, /REFUSED: nothing dispatched: the budget is exceeded/);
  assert.match(out, /agent_call_limit exceeded: 2 of 2/);
  assert.match(out, /--by user/);
  assert.equal(p.status('C-001'), 'READY');

  assert.match(p.refused(['authorize', '--limit', 'agent_call_limit', '--value', '3', '--by', 'orchestrator', '--reason', 'I need it']), /REFUSED: authorization refused[\s\S]*NOT_USER/);
  assert.match(p.refused(['authorize', '--limit', 'agent_call_limit', '--value', '3', '--by', 'User', '--reason', 'close enough']), /NOT_USER/);
  assert.match(p.usage(['authorize', '--limit', 'agent_call_limit', '--value', '3', '--by', 'user']), /--reason/);
  assert.match(p.usage(['authorize', '--limit', 'agent_call_limit', '--value', '3', '--reason', 'x']), /--by is required/);
  assert.match(p.usage(['authorize', '--limit', 'wallet', '--value', '3', '--by', 'user', '--reason', 'x']), /--limit must be one of/);
  assert.match(p.refused(['next']), /budget is exceeded/);

  out = p.ok(['authorize', '--limit', 'agent_call_limit', '--value', '3', '--by', 'user', '--reason', 'the user approved one more call']);
  assert.match(out, /AUTHORIZED: agent_call_limit raised to 3/);
  out = p.ok(['next']);
  assert.match(out, /=== C-001 /);
  assert.equal(p.runRecord().usage.agent_calls, 3);
  const auth = p.runRecord().authorizations;
  assert.equal(auth.length, 1);
  assert.equal(auth[0].by, 'user');

  // cost is "not measured" until a measured cost is recorded; tokens can be recorded afterwards
  out = p.ok(['status']);
  assert.match(out, /agent calls: 3 of 3 \(100%, exceeded\)/);
  assert.match(out, /cost: not measured/);
  assert.match(out, /tokens: not measured/);
  assert.doesNotMatch(out, /\$/);
  assert.match(p.ok(['final-report']), /- Cost: not measured/);

  out = p.ok(['usage', '--tokens', '1234', '--task', 'A-001']);
  assert.match(out, /tokens 1234 \(measured\); cost not measured/);
  const usage = p.runRecord().usage;
  assert.equal(usage.tokens.total, 1234);
  assert.equal(usage.by_task['A-001'].tokens, 1234);
  assert.match(p.ok(['status']), /tokens: 1234 measured/);
  assert.match(p.refused(['usage', '--tokens', '5', '--task', 'Z-999']), /no task Z-999/);
  assert.match(p.usage(['usage', '--tokens', 'lots']), /--tokens must be a non-negative integer/);

  p.ok(['usage', '--cost', '0.42']);
  assert.match(p.ok(['status']), /cost: \$0\.42 \(measured\)/);
  assert.match(p.ok(['final-report']), /- Cost: \$0\.42 \(measured\)/);
});

test('simulated-agent: resume reconstructs the run from disk, restores a corrupted task file, and requeues only an attempt reconciled explicitly', () => {
  // worktree strategy so that three writers are in flight at once
  const p = H.project({ git: true, config: 'execution:\n  max_retries: 0\n' });
  p.ok(['init', 'Recover from a lost session']);
  p.plan([H.spec('A-001'), H.spec('B-001'), H.spec('C-001'), H.spec('D-001', { dependencies: ['A-001'] })]);
  p.ok(['decision', 'Workers write one file each']);
  p.ok(['next']);
  p.ok(['started', 'A-001', 'B-001', 'C-001']);
  p.ok(['result', 'A-001', '--stdin'], { input: H.report('A-001', { files: [] }) });
  assert.equal(p.task('A-001').candidate.kind, 'no_change');
  p.ok(['worker-failed', 'B-001', '--kind', 'crash', '--reason', 'agent process died']);
  assert.equal(p.status('B-001'), 'FAILED', 'max_retries 0: no retry');

  // amend D-001 so its file has been written twice (the .bak holds the previous version)
  const amended = p.write('.opus-inbox/d.yaml', yaml.stringify(H.spec('D-001', { dependencies: ['A-001'], title: 'Amended D' })));
  assert.match(p.ok(['amend', 'D-001', '--file', amended, '--reason', 'clearer title']), /AMENDED: D-001 spec revision 2/);

  // the orchestrator session dies here; every later command is a fresh process reading the disk
  const taskFile = path.join(p.runDir(), 'tasks', 'D-001.json');
  assert.ok(fs.existsSync(`${taskFile}.bak`));
  fs.writeFileSync(taskFile, '{"task_id": "D-001", "status": tru');

  let out = p.ok(['resume']);
  assert.match(out, /restored from backup: tasks\/D-001\.json/);
  assert.match(out, /Objective: Recover from a lost session/);
  assert.match(out, /- Workers write one file each/);
  assert.match(out, /- A-001 IMPLEMENTED/);
  assert.match(out, /- B-001 FAILED/);
  assert.match(out, /- C-001 RUNNING/);
  assert.match(out, /Known failures:\n- B-001 \[crash\]: agent process died/);
  assert.match(out, /oo verify A-001 \(run independent verification/);
  const attempt1 = p.task('C-001').dispatch.attempt_id;
  assert.match(out, new RegExp(`In flight \\(their agents may still be working[^\\n]*\\n {2}C-001 RUNNING attempt ${attempt1} dispatched`));
  assert.match(out, /oo reconcile <ID> --attempt <attempt id> --agent-gone --reason <text>/);
  assert.match(out, /NEXT: oo result C-001 --stdin/);
  const restored = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  assert.equal(restored.task_id, 'D-001', 'the corrupted file was rewritten from the backup');
  assert.equal(restored.status, 'PENDING');
  assert.equal(restored.spec_revision, 1, 'the backup is the version before the last save');

  // regression: liveness of an agent is unknown, so nothing is requeued on a guess
  out = p.refused(['resume', '--requeue-running']);
  assert.match(out, /REFUSED: nothing requeued/);
  assert.match(out, new RegExp(`C-001 attempt ${attempt1} is RUNNING; oo cannot tell whether its agent still runs`));
  assert.equal(p.status('C-001'), 'RUNNING');

  // explicit reconciliation of exactly that attempt
  assert.match(p.usage(['reconcile', 'C-001', '--attempt', attempt1, '--reason', 'x']), /--agent-gone/);
  assert.match(p.refused(['reconcile', 'C-001', '--attempt', 'C-001-a1-000000', '--agent-gone', '--reason', 'x']), /only the current in-flight attempt can be reconciled/);
  assert.match(p.refused(['reconcile', 'A-001', '--attempt', p.task('A-001').dispatch.attempt_id, '--agent-gone', '--reason', 'x']), /A-001 is IMPLEMENTED[\s\S]*a finished result is kept/);
  out = p.ok(['reconcile', 'C-001', '--attempt', attempt1, '--agent-gone', '--reason', 'the session that launched it ended']);
  assert.match(out, new RegExp(`RECONCILED: C-001 attempt ${attempt1} abandoned -> READY \\(no retry used\\)`));
  const c = p.task('C-001');
  assert.equal(c.status, 'READY');
  assert.equal(c.retries, 0, 'reconciliation does not consume a retry');
  assert.equal(c.attempt_log.find((e) => e.attempt_id === attempt1).outcome, 'abandoned');
  assert.equal(p.status('A-001'), 'IMPLEMENTED', 'tasks that are not in flight are untouched');
  // a second reconcile of the same attempt (another session resuming concurrently) changes nothing
  assert.match(p.refused(['reconcile', 'C-001', '--attempt', attempt1, '--agent-gone', '--reason', 'again']), /C-001 is READY/);
  out = p.ok(['next']);
  assert.match(out, /=== C-001 \(attempt 2/);
  const attempt2 = p.task('C-001').dispatch.attempt_id;
  assert.notEqual(attempt2, attempt1);

  // the late report of the abandoned attempt is refused; the superseding attempt's report is accepted once
  const before = JSON.stringify(p.task('C-001'));
  out = p.refused(['result', 'C-001', '--stdin'], { input: H.report('C-001', { attempt: attempt1 }) });
  assert.match(out, new RegExp(`attempt ${attempt1} was abandoned at .*a late report of an abandoned attempt is never applied`));
  assert.equal(JSON.stringify(p.task('C-001')), before, 'state unchanged');
  assert.match(p.refused(['result', 'C-001', '--stdin'], { input: H.report('C-001', { attempt: 'C-001-a9-ffffff' }) }), /attempt C-001-a9-ffffff was never dispatched for C-001/);
  p.ok(['result', 'C-001', '--stdin'], { input: H.report('C-001', { attempt: attempt2 }) });
  assert.equal(p.status('C-001'), 'IMPLEMENTED');
  assert.match(p.refused(['result', 'C-001', '--stdin'], { input: H.report('C-001', { attempt: attempt2 }) }), /C-001 is IMPLEMENTED/);
});

test('simulated-agent: an oo process killed during verification leaves state that resume and a re-run recover', async () => {
  const p = H.project();
  p.ok(['init', 'Killed mid-command']);
  const slow = 'node -e "setTimeout(function(){}, 4000)"';
  p.plan([H.spec('A-001', { verification_commands: [slow] })]);
  p.ok(['next']);
  p.write('a-001.txt', 'A\n');
  p.ok(['result', 'A-001', '--stdin'], { input: H.report('A-001', { files: ['a-001.txt'] }) });

  const child = spawn(process.execPath, [H.OO, 'verify', 'A-001'], { cwd: p.dir, env: p.env, stdio: 'ignore', windowsHide: true });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const deadline = Date.now() + 15000;
  while (p.status('A-001') !== 'VERIFYING' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(p.status('A-001'), 'VERIFYING');
  child.kill();
  await exited;

  const op = p.task('A-001').pending_op;
  assert.ok(op && op.kind === 'verify' && op.pid === child.pid, 'the interrupted verification is recorded with its owner');
  const out = p.ok(['resume']);
  assert.match(out, /- A-001 VERIFYING/);
  assert.match(out, /oo verify A-001 \(verification was in progress/);
  assert.match(out, new RegExp(`Operation verify of A-001 \\(${op.id}\\): interrupted \\(process ${child.pid} is gone\\); repeat oo verify A-001 to take it over`));
  assert.equal(fs.existsSync(path.join(p.paths.stateRoot, '.lock')), false, 'no lock is left behind');
  // a re-run takes the dead operation over and completes the verification
  assert.match(p.ok(['verify', 'A-001']), /VERIFICATION PASSED: A-001 -> REVIEWING/);
  const t = p.task('A-001');
  assert.equal(t.pending_op, null);
  assert.ok(t.history.some((h) => h.reason && h.reason.includes(`took over the interrupted verify ${op.id}`)));
});

test('simulated-agent: a verification result of a superseded operation is discarded and a live operation blocks a second one', async () => {
  const p = H.project();
  p.ok(['init', 'Superseded verification']);
  const slow = 'node -e "setTimeout(function(){}, 3000)"';
  p.plan([H.spec('A-001', { verification_commands: [slow] })]);
  p.ok(['next']);
  p.write('a-001.txt', 'A\n');
  p.ok(['result', 'A-001', '--stdin'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  const child = spawn(process.execPath, [H.OO, 'verify', 'A-001'], { cwd: p.dir, env: p.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let childOut = '';
  child.stdout.on('data', (d) => { childOut += d; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const deadline = Date.now() + 15000;
  while (!(p.task('A-001').pending_op) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  // while the first verification runs, a second one is refused (its owner is alive)
  assert.match(p.refused(['verify', 'A-001']), /verify [0-9a-f-]{36} is already running in process \d+ on this host/);
  // the task moves on meanwhile (here: the user blocks it); the running verification's result must not land
  p.ok(['block', 'A-001', '--reason', 'the user stopped it']);
  const code = await exited;
  assert.equal(code, 1);
  assert.match(childOut, /verification result for A-001 discarded[\s\S]*is no longer current/);
  assert.equal(p.status('A-001'), 'BLOCKED');
  assert.equal(p.task('A-001').evidence.verification, null, 'no verification evidence was applied');
});

test('simulated-agent: final-report lists outcomes and commands, reports PARTIAL, never calls an unverified task verified; deliver refuses', () => {
  const p = H.project({ config: 'execution:\n  max_retries: 0\n' });
  p.ok(['init', 'Partial run']);
  p.plan([H.spec('A-001', { priority: 'critical' }), H.spec('B-001', { priority: 'high' }), H.spec('C-001'), H.spec('D-001', { priority: 'high', verification_commands: [H.FAIL_CMD] })]);
  // shared workspace: one writer at a time, in priority order
  assert.match(p.ok(['next']), /=== A-001 /);
  p.write('a-001.txt', 'A\n');
  p.ok(['result', 'A-001', '--stdin', '--verify'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  p.ok(['review', 'A-001', '--stdin', '--integrate'], { input: H.review('A-001') });
  assert.match(p.ok(['next']), /=== B-001 /);
  p.ok(['worker-failed', 'B-001', '--kind', 'tool', '--reason', 'the tool broke']);
  assert.match(p.ok(['next']), /=== D-001 /);
  p.write('d-001.txt', 'D\n');
  p.ok(['result', 'D-001', '--stdin'], { input: H.report('D-001', { files: ['d-001.txt'] }) });
  p.refused(['verify', 'D-001']);
  assert.match(p.ok(['next']), /=== C-001 /);
  p.write('c-001.txt', 'C\n');
  p.ok(['result', 'C-001', '--stdin'], { input: H.report('C-001', { files: ['c-001.txt'] }) });

  const out = p.ok(['final-report']);
  assert.match(out, /Overall status: PARTIAL/);
  assert.match(out, /### COMPLETED \(1\)\n\n- A-001 Task A-001: verified/);
  assert.match(out, /### FAILED \(1\)\n\n- B-001 Task B-001: not verified; not integrated; .*failure tool: the tool broke/);
  assert.match(out, /### IMPLEMENTED \(1\)\n\n- C-001 Task C-001: not verified/);
  assert.match(out, /### CORRECTION_REQUIRED \(1\)\n\n- D-001 Task D-001: verification FAILED/);
  assert.match(out, /## Verified tasks\n\n- A-001\n\nNot verified: B-001, C-001, D-001/);
  assert.match(out, /\| A-001 \| verification \| 0 \| `.*a-001\.txt.*` \| 0 \|/);
  assert.match(out, /\| A-001 \| integration \| 0 \| `.*a-001\.txt.*` \| 0 \|/);
  assert.match(out, /\| D-001 \| verification \| 0 \| `node -e .*process\.exit\(3\).*` \| 3 \|/);
  assert.match(out, /- c-001\.txt \(C-001, reported by the worker\)/);
  assert.match(out, /- a-001\.txt \(A-001, observed by verification\)/);
  assert.doesNotMatch(out.split('## Verified tasks')[1].split('## Files modified')[0], /C-001\n/);
  const file = fs.readFileSync(path.join(p.runDir(), 'final-report.md'), 'utf8');
  assert.match(file, /Overall status: PARTIAL/);

  const d = p.refused(['deliver']);
  assert.match(d, /REFUSED: nothing delivered/);
  assert.match(d, /B-001 is FAILED/);
  assert.match(d, /C-001 is IMPLEMENTED/);
  // CANCELLED counts as done for deliver, but the report stays PARTIAL
  p.ok(['cancel', '--all', '--reason', 'the user accepts the partial result']);
  assert.equal(p.status('B-001'), 'FAILED', 'cancel --all leaves terminal tasks alone');
  assert.match(p.refused(['deliver']), /B-001 is FAILED/);
  p.ok(['cancel', 'B-001', '--reason', 'the user drops it']);
  assert.match(p.ok(['deliver']), /DELIVERED: shared workspace/);
  assert.match(p.ok(['final-report']), /Overall status: PARTIAL/);
});

test('observe, learn and proposals work end to end; a proposal is applied only after approval by the user', () => {
  const skill = H.skillCopy();
  const p = H.project({ skill, config: 'improvement:\n  min_samples: 1\n' });
  p.ok(['init', 'Learn from one task']);
  p.plan([H.spec('A-001', { complexity: 3 })]);
  // simulated worker: first attempt crashes, the retry succeeds -> not a first pass
  p.ok(['next']);
  p.ok(['worker-failed', 'A-001', '--kind', 'crash', '--reason', 'agent died']);
  p.ok(['next']);
  p.write('a-001.txt', 'A\n');
  p.ok(['result', 'A-001', '--stdin', '--verify'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  p.ok(['review', 'A-001', '--stdin', '--integrate'], { input: H.review('A-001') });

  assert.match(p.ok(['observe', '--category', 'user_correction', '--text', 'the user wanted shorter files']), /OBSERVATION RECORDED: user_correction/);
  assert.match(p.usage(['observe', '--category', 'gossip', '--text', 'x']), /--category must be one of/);

  let out = p.ok(['learn']);
  assert.match(out, /LEARN: 2 observation\(s\) collected/);
  const m = out.match(/PROPOSAL (IMP-\d{8}-\d{3}) \[routing_heuristics, config_set\]/);
  assert.ok(m, out);
  const id = m[1];
  const obs = fs.readFileSync(p.paths.observationsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(obs.some((o) => o.category === 'user_correction'));
  assert.ok(obs.some((o) => o.category === 'worker_outcome' && o.data.first_pass === false && o.data.attempts === 2));

  assert.match(p.ok(['proposals', 'list']), new RegExp(`${id} proposed \\[routing_heuristics\\]`));
  assert.match(p.ok(['proposals', 'show', id]), /key: routing\.heuristic_expected_attempts\.haiku\.3-4/);
  const routingFile = path.join(skill, 'config', 'routing.yaml');
  const original = fs.readFileSync(routingFile);
  assert.match(p.refused(['proposals', 'apply', id]), /NOT_APPROVED/);
  assert.match(p.refused(['proposals', 'approve', id, '--by', 'orchestrator']), /NOT_USER/);
  assert.match(p.usage(['proposals', 'approve', id]), /--by user/);
  assert.ok(fs.readFileSync(routingFile).equals(original), 'nothing applied before approval');

  p.ok(['proposals', 'approve', id, '--by', 'user']);
  out = p.ok(['proposals', 'apply', id]);
  assert.match(out, /APPLIED: .*config\/routing\.yaml changed; backup history\/1\.1\.0\/config\/routing\.yaml; VERSION 1\.1\.0 -> 1\.1\.1/);
  assert.equal(yaml.parse(fs.readFileSync(routingFile, 'utf8')).routing.heuristic_expected_attempts.haiku['3-4'], 2);
  assert.equal(fs.readFileSync(path.join(skill, 'VERSION'), 'utf8').trim(), '1.1.1');
  p.ok(['proposals', 'rollback', id]);
  assert.ok(fs.readFileSync(routingFile).equals(original), 'rollback restores the file byte for byte');
  assert.match(p.ok(['proposals', 'list']), new RegExp(`${id} rolled_back`));
});
