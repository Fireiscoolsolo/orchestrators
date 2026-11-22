'use strict';
// Complete task lifecycles through the oo CLI in a shared workspace.
// SIMULATED AGENTS: the "workers" are test code that writes files and feeds YAML reports to
// oo result; no model or real agent is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./oo-harness.cjs');
const store = require('../scripts/lib/store.cjs');

test.after(H.cleanup);

/** Runs a state-changing command and asserts that checkpoint.yaml was rewritten. */
function stepper(p) {
  return (args, o = {}, code = 0) => {
    const before = p.checkpoint().written_at;
    const out = p.expect(code, args, o);
    const after = p.checkpoint().written_at;
    assert.ok(after > before, `checkpoint.yaml rewritten after oo ${args.join(' ')} (${before} -> ${after})`);
    return out;
  };
}

test('simulated-agent: two independent tasks and one dependent task reach COMPLETED; the dependent waits for both', () => {
  const p = H.project();
  p.ok(['init', 'Three files, one depending on the other two']);
  const step = stepper(p);
  p.plan([
    H.spec('A-001', { title: 'Write A' }),
    H.spec('B-001', { title: 'Write B' }),
    H.spec('C-001', { title: 'Write C', dependencies: ['A-001', 'B-001'] }),
  ]);

  // wave 1: in a shared workspace the writers run one at a time (their changes could not be
  // attributed otherwise); C waits for its dependencies
  let out = step(['next']);
  assert.match(out, /=== A-001 /);
  assert.doesNotMatch(out, /=== B-001 /);
  assert.match(out, /B-001: shared_serial: shared workspace/);
  assert.doesNotMatch(out, /=== C-001 /);
  assert.equal(p.status('C-001'), 'PENDING');
  assert.equal(p.status('B-001'), 'READY');
  step(['started', 'A-001']);
  assert.equal(p.status('A-001'), 'RUNNING');

  // simulated worker A finishes
  p.write('a-001.txt', 'A\n');
  out = step(['result', 'A-001', '--stdin', '--tokens', '500'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  assert.match(out, /RESULT ACCEPTED: A-001 -> IMPLEMENTED/);
  assert.match(out, /NEXT: oo verify A-001/);

  out = step(['next']);
  assert.match(out, /NOTHING DISPATCHED: waiting_on_running/);
  assert.equal(p.status('B-001'), 'READY', 'B still waits while A is being verified in the same directory');
  assert.equal(p.status('C-001'), 'PENDING');

  out = step(['verify', 'A-001']);
  assert.match(out, /VERIFICATION PASSED: A-001 -> REVIEWING/);
  assert.match(out, /Changed files: a-001\.txt/);
  out = step(['review', 'A-001', '--stdin'], { input: H.review('A-001') });
  assert.match(out, /APPROVED: A-001 -> APPROVED/);
  out = step(['integrate', 'A-001']);
  assert.match(out, /INTEGRATED: A-001 -> COMPLETED/);

  // A is COMPLETED but B is not: B is dispatched now, C must still wait
  out = step(['next']);
  assert.match(out, /=== B-001 /);
  assert.doesNotMatch(out, /=== C-001 /);
  assert.equal(p.status('C-001'), 'PENDING');
  step(['started', 'B-001']);

  // simulated worker B finishes; result --verify and review --integrate chain the steps
  p.write('b-001.txt', 'B\n');
  out = step(['result', 'B-001', '--stdin', '--verify'], { input: H.report('B-001', { files: ['b-001.txt'] }) });
  assert.match(out, /RESULT ACCEPTED: B-001[\s\S]*VERIFICATION PASSED: B-001/);
  out = step(['review', 'B-001', '--stdin', '--integrate'], { input: H.review('B-001') });
  assert.match(out, /APPROVED: B-001[\s\S]*INTEGRATED: B-001 -> COMPLETED/);

  // both dependencies COMPLETED: C is dispatched with their summaries in its package
  out = step(['next']);
  assert.match(out, /=== C-001 /);
  assert.equal(p.status('C-001'), 'DISPATCHED');
  const pkg = fs.readFileSync(path.join(p.runDir(), 'packages', 'C-001-d1.md'), 'utf8');
  assert.match(pkg, /## Dependencies\n- A-001 \(Write A\) completed: simulated worker finished A-001\n- B-001 \(Write B\) completed: simulated worker finished B-001/);

  const cHistory = p.task('C-001').history.map((h) => h.to);
  assert.deepEqual(cHistory, ['PENDING', 'READY', 'DISPATCHED']);
  const aDone = p.task('A-001').history.find((h) => h.to === 'COMPLETED').ts;
  const bDone = p.task('B-001').history.find((h) => h.to === 'COMPLETED').ts;
  const cDispatched = p.task('C-001').history.find((h) => h.to === 'DISPATCHED').ts;
  assert.ok(cDispatched >= aDone && cDispatched >= bDone, 'C dispatched only after both dependencies completed');

  step(['started', 'C-001']);
  p.write('c-001.txt', 'C\n');
  step(['result', 'C-001', '--stdin', '--verify'], { input: H.report('C-001', { files: ['c-001.txt'] }) });
  step(['review', 'C-001', '--stdin', '--integrate'], { input: H.review('C-001') });
  for (const id of ['A-001', 'B-001', 'C-001']) assert.equal(p.status(id), 'COMPLETED');

  out = p.ok(['next']);
  assert.match(out, /NOTHING DISPATCHED: all_done/);
  assert.match(out, /NEXT: oo final-report, then oo deliver/);

  const cp = p.checkpoint();
  assert.deepEqual(cp.task_statuses, { 'A-001': 'COMPLETED', 'B-001': 'COMPLETED', 'C-001': 'COMPLETED' });
  assert.equal(cp.phase, 'finished');

  out = p.ok(['final-report']);
  assert.match(out, /Overall status: COMPLETE/);
  assert.match(out, /### COMPLETED \(3\)/);
  assert.match(out, /- A-001 Write A: verified \(1 command\(s\)/);
  assert.match(out, /\| A-001 \| verification \| 0 \| `node -e .*a-001\.txt.*` \| 0 \|/);
  assert.match(out, /Tokens: 500 \(measured\)/);
  assert.match(out, /Cost: not measured/);
  assert.ok(fs.existsSync(path.join(p.runDir(), 'final-report.md')));

  out = step(['deliver']);
  assert.match(out, /DELIVERED: shared workspace/);
  assert.equal(p.runRecord().delivered, true);

  const events = store.readEvents(p.paths, p.runId());
  const transitions = events.filter((e) => e.type === 'transition');
  assert.ok(transitions.length >= 21, `every transition is in events.jsonl (${transitions.length})`);
  assert.ok(transitions.every((e) => e.ts && e.task_id && e.from && e.to));
  const usage = p.runRecord().usage;
  assert.equal(usage.worker_calls, 3);
  assert.equal(usage.verification_runs, 3);
});

test('checkpoint.yaml is rewritten after every other state-changing command', () => {
  const p = H.project();
  p.ok(['init', 'Checkpoint coverage']);
  const step = stepper(p);
  step(['plan', '--file', p.write('.opus-inbox/s.yaml', require('../scripts/lib/yaml.cjs').stringify([H.spec('A-001', { verification_commands: [] }), H.spec('B-001')]))]);
  step(['decision', 'Use plain text files', 'Keep it small']);
  assert.deepEqual(p.runRecord().decisions.map((d) => d.text), ['Use plain text files', 'Keep it small']);
  step(['next']);
  step(['usage', '--tokens', '42', '--task', 'A-001']);
  step(['block', 'B-001', '--reason', 'waiting for the user']);
  assert.equal(p.status('B-001'), 'BLOCKED');
  step(['unblock', 'B-001', '--reason', 'user answered']);
  assert.equal(p.status('B-001'), 'READY');
  step(['result', 'A-001', '--stdin'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  let out = p.refused(['verify', 'A-001']);
  assert.match(out, /no verification_commands and no manual check/);
  step(['check', 'A-001', '--name', 'file present', '--result', 'pass', '--note', 'looked at it']);
  p.write('a-001.txt', 'A\n');
  out = step(['verify', 'A-001']);
  assert.match(out, /VERIFICATION PASSED: A-001 -> REVIEWING\n {2}1 manual check\(s\) recorded, none failed/);
  assert.equal(p.task('A-001').evidence.verification.checks[0].name, 'file present');
  step(['checkpoint']);
  step(['context', '--utilization', '0.7']);
  out = p.ok(['context']);
  assert.match(out, /CONTEXT: over_target \(70% used, target 60%/);
  step(['cancel', '--all', '--reason', 'stopping the run']);
  assert.ok(p.status('A-001') === 'CANCELLED' && p.status('B-001') === 'CANCELLED');
  step(['resume']);
  out = p.ok(['final-report']);
  assert.match(out, /Overall status: FAILED/);
});

test('simulated-agent: checkpoint.yaml is rewritten after failure, authorization, amendment, review and correction commands', () => {
  const p = H.project();
  p.ok(['init', 'Checkpoint coverage two']);
  const step = stepper(p);
  p.plan([H.spec('A-001'), H.spec('B-001'), H.spec('C-001', { complexity: 5, priority: 'high' })]);
  // shared workspace: one writer at a time, highest priority first
  assert.match(step(['next']), /=== C-001 [\s\S]*A-001: shared_serial/);
  p.write('c-001.txt', 'C\n');
  step(['result', 'C-001', '--stdin', '--verify'], { input: H.report('C-001', { files: ['c-001.txt'] }) });
  assert.match(step(['next']), /=== A-001 [\s\S]*B-001: shared_serial/);
  step(['worker-failed', 'A-001', '--kind', 'crash', '--reason', 'agent died']);
  step(['authorize', '--limit', 'max_retries', '--value', '4', '--by', 'user', '--reason', 'the user allows more retries']);
  step(['fail', 'B-001', '--reason', 'wrong approach']);
  step(['reopen', 'B-001', '--reason', 'the user wants another try', '--user-authorized']);
  assert.equal(p.status('B-001'), 'READY');
  const f = p.write('.opus-inbox/b.yaml', require('../scripts/lib/yaml.cjs').stringify(H.spec('B-001', { title: 'Amended B' })));
  step(['amend', 'B-001', '--file', f, '--reason', 'clearer title']);
  step(['review-package', 'C-001']);
  step(['review', 'C-001', '--stdin'], { input: H.review('C-001', { reviewer: 'opus-reviewer', verdict: 'request_changes' }) });
  step(['correct', 'C-001', '--stdin'], { input: H.correction('C-001') });
  // a refused command changes nothing, so the checkpoint stays as it was
  const before = p.checkpointText();
  assert.match(p.refused(['escalate', 'A-001', '--model', 'sonnet', '--reason', 'not failed']), /escalate applies to FAILED or BLOCKED tasks/);
  assert.equal(p.checkpointText(), before);
});
