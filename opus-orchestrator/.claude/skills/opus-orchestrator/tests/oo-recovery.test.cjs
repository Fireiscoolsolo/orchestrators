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
  const p = H.project({ config: 'budget:\n  agent_call_limit: 2\n' });
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

test('simulated-agent: resume reconstructs the run from disk, restores a corrupted task file and requeues without consuming a retry', () => {
  const p = H.project({ config: 'execution:\n  max_retries: 0\n' });
  p.ok(['init', 'Recover from a lost session']);
  p.plan([H.spec('A-001'), H.spec('B-001'), H.spec('C-001'), H.spec('D-001', { dependencies: ['A-001'] })]);
  p.ok(['decision', 'Workers write one file each']);
  p.ok(['next']);
  p.ok(['started', 'A-001', 'B-001', 'C-001']);
  p.write('a-001.txt', 'A\n');
  p.ok(['result', 'A-001', '--stdin'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
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
  assert.match(out, /In flight: C-001\. If their agents are gone, run oo resume --requeue-running\./);
  assert.match(out, /NEXT: oo result C-001 --stdin/);
  const restored = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  assert.equal(restored.task_id, 'D-001', 'the corrupted file was rewritten from the backup');
  assert.equal(restored.status, 'PENDING');
  assert.equal(restored.spec_revision, 1, 'the backup is the version before the last save');

  out = p.ok(['resume', '--requeue-running']);
  assert.match(out, /REQUEUED: C-001 \(RUNNING -> READY\)/);
  const c = p.task('C-001');
  assert.equal(c.status, 'READY');
  assert.equal(c.retries, 0, 'requeue does not consume a retry');
  assert.equal(p.status('A-001'), 'IMPLEMENTED', 'tasks that are not in flight are untouched');
  out = p.ok(['next']);
  assert.match(out, /=== C-001 \(attempt 2\)/);
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

  const out = p.ok(['resume']);
  assert.match(out, /- A-001 VERIFYING/);
  assert.match(out, /oo verify A-001 \(verification was in progress/);
  assert.equal(fs.existsSync(path.join(p.paths.stateRoot, '.lock')), false, 'no lock is left behind');
  // a re-run completes the verification (the slow command now runs to the end)
  assert.match(p.ok(['verify', 'A-001']), /VERIFICATION PASSED: A-001 -> REVIEWING/);
});

test('simulated-agent: final-report lists outcomes and commands, reports PARTIAL, never calls an unverified task verified; deliver refuses', () => {
  const p = H.project({ config: 'execution:\n  max_retries: 0\n' });
  p.ok(['init', 'Partial run']);
  p.plan([H.spec('A-001'), H.spec('B-001'), H.spec('C-001'), H.spec('D-001', { verification_commands: [H.FAIL_CMD] })]);
  p.ok(['next']);
  p.write('a-001.txt', 'A\n');
  p.ok(['result', 'A-001', '--stdin', '--verify'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  p.ok(['review', 'A-001', '--stdin', '--integrate'], { input: H.review('A-001') });
  p.ok(['worker-failed', 'B-001', '--kind', 'tool', '--reason', 'the tool broke']);
  p.write('c-001.txt', 'C\n');
  p.ok(['result', 'C-001', '--stdin'], { input: H.report('C-001', { files: ['c-001.txt'] }) });
  p.write('d-001.txt', 'D\n');
  p.ok(['result', 'D-001', '--stdin'], { input: H.report('D-001', { files: ['d-001.txt'] }) });
  p.refused(['verify', 'D-001']);

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
  assert.match(out, /APPLIED: .*config\/routing\.yaml changed; backup history\/2\.0\.0\/config\/routing\.yaml; VERSION 2\.0\.0 -> 2\.0\.1/);
  assert.equal(yaml.parse(fs.readFileSync(routingFile, 'utf8')).routing.heuristic_expected_attempts.haiku['3-4'], 2);
  assert.equal(fs.readFileSync(path.join(skill, 'VERSION'), 'utf8').trim(), '2.0.1');
  p.ok(['proposals', 'rollback', id]);
  assert.ok(fs.readFileSync(routingFile).equals(original), 'rollback restores the file byte for byte');
  assert.match(p.ok(['proposals', 'list']), new RegExp(`${id} rolled_back`));
});
