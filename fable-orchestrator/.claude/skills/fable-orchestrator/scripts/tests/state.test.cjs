'use strict';
// State machine invariants, persistence, recovery and budget accounting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sm = require('../state_manager.cjs');
const V = require('../validate.cjs');
const R = require('../routing.cjs');
const yaml = require('../miniyaml.cjs');
const fo = require('../fo.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fo-state-'));
const cfg = fo.loadConfig(tmp());
const code = (c) => (e) => e instanceof sm.OrchError && e.code === c;

const contract = (id, o) => Object.assign({
  task_id: id, title: `Task ${id}`, objective: 'Deliver what the acceptance criteria describe', priority: 'medium',
  dependencies: [], complexity_score: 3, risk_level: 'low', file_scope: [`pkg/${id}/`],
  acceptance_criteria: ['the tests exit with code 0'], verification: ['run the tests'], verification_commands: ['npm test'],
}, o);

function mkState(contracts, opts) {
  const state = {
    schema: 1, run_id: 'test-run', created_at: sm.nowIso(), updated_at: sm.nowIso(), phase: 'PLANNED', request: 'a request',
    options: Object.assign({ mode: 'balanced', max_workers: 5, max_review_rounds: 3, max_task_retries: 2, plan_only: false }, opts),
    config: JSON.parse(JSON.stringify(cfg)), project: { root: '.', isolation: 'shared', git: null },
    tasks: {}, order: [], decisions: [], delivery: null, seq: 0, budget: { agent_calls: 0, tokens_reported: 0, extra_agent_calls: 0 },
  };
  for (const c of contracts) {
    const v = V.validateContract(c);
    assert.deepEqual(v.errors, []);
    state.tasks[c.task_id] = sm.newTask(v.contract, R.route(v.contract, state.config, state.options.mode, null));
    state.order.push(c.task_id);
  }
  sm.refresh(state);
  return state;
}

function dispatch(state, id) {
  const t = state.tasks[id];
  t.attempts.push({ n: t.attempts.length + 1, route: { tier: t.route.tier, role: t.route.role, model: t.route.model }, isolation: 'shared', report: null });
  sm.transition(state, id, 'DISPATCHED', { reason: 'test dispatch' });
  sm.transition(state, id, 'RUNNING', { reason: 'agent started' });
}
function implement(state, id) {
  dispatch(state, id);
  sm.lastAttempt(state.tasks[id]).report = { status: 'implemented', summary: 'done', known_issues: [] };
  sm.transition(state, id, 'IMPLEMENTED', { reason: 'report' });
}
function verify(state, id, passed) {
  const t = state.tasks[id];
  t.verify_cycle++;
  sm.transition(state, id, 'VERIFYING', {});
  t.checks.push({ cycle: t.verify_cycle, kind: 'command', name: 'npm test', passed });
}
function review(state, id, reviewer, verdict, perspective) {
  const t = state.tasks[id];
  t.reviews.push({ cycle: t.verify_cycle, reviewer, verdict, perspective: perspective || 'correctness', criteria: [], findings: [] });
}
function complete(state, id) {
  implement(state, id);
  verify(state, id, true);
  sm.transition(state, id, 'REVIEWING', {});
  review(state, id, 'orchestrator', 'approve');
  sm.transition(state, id, 'APPROVED', {});
  sm.transition(state, id, 'INTEGRATING', {});
  state.tasks[id].integration = { cycle: state.tasks[id].verify_cycle, passed: true, checks: [], conflict_files: [] };
  sm.transition(state, id, 'COMPLETED', {});
  sm.refresh(state);
}
function correct(state, id) {
  const t = state.tasks[id];
  t.review_round++;
  t.corrections.push({ round: t.review_round, failure: 'f', required_change: 'c' });
  sm.transition(state, id, 'READY', { reason: `correction round ${t.review_round}` });
}

test('a task cannot run before its dependencies are completed', () => {
  const s = mkState([contract('A-1'), contract('B-1', { dependencies: ['A-1'] })]);
  assert.equal(s.tasks['A-1'].state, 'READY');
  assert.equal(s.tasks['B-1'].state, 'PENDING');
  assert.throws(() => sm.transition(s, 'B-1', 'READY', {}), code('DEPENDENCIES_UNSATISFIED'));
  assert.throws(() => sm.transition(s, 'B-1', 'RUNNING', {}), code('ILLEGAL_TRANSITION'));
  complete(s, 'A-1');
  assert.equal(s.tasks['B-1'].state, 'READY', 'refresh promotes the dependent task');
});

test('the full lifecycle requires a report, evidence, a review and an integration check', () => {
  const s = mkState([contract('A-1')]);
  dispatch(s, 'A-1');
  assert.throws(() => sm.transition(s, 'A-1', 'IMPLEMENTED', {}), code('REPORT_REQUIRED'));
  sm.lastAttempt(s.tasks['A-1']).report = { status: 'implemented', summary: 'x', known_issues: [] };
  sm.transition(s, 'A-1', 'IMPLEMENTED', {});
  assert.throws(() => sm.transition(s, 'A-1', 'APPROVED', {}), code('ILLEGAL_TRANSITION'));
  s.tasks['A-1'].verify_cycle++;
  sm.transition(s, 'A-1', 'VERIFYING', {});
  assert.throws(() => sm.transition(s, 'A-1', 'REVIEWING', {}), code('NO_VERIFICATION_EVIDENCE'));
  s.tasks['A-1'].checks.push({ cycle: 1, kind: 'scope', name: 'file scope', passed: true });
  assert.throws(() => sm.transition(s, 'A-1', 'REVIEWING', {}), code('NO_VERIFICATION_EVIDENCE'), 'the scope check alone is not evidence of behaviour');
  s.tasks['A-1'].checks.push({ cycle: 1, kind: 'command', name: 'npm test', passed: true });
  sm.transition(s, 'A-1', 'REVIEWING', {});
  assert.throws(() => sm.transition(s, 'A-1', 'APPROVED', {}), code('REVIEW_REQUIRED'));
  review(s, 'A-1', 'orchestrator', 'approve');
  sm.transition(s, 'A-1', 'APPROVED', {});
  assert.throws(() => sm.transition(s, 'A-1', 'COMPLETED', {}), code('ILLEGAL_TRANSITION'));
  sm.transition(s, 'A-1', 'INTEGRATING', {});
  assert.throws(() => sm.transition(s, 'A-1', 'COMPLETED', {}), code('INTEGRATION_CHECK_REQUIRED'));
  s.tasks['A-1'].integration = { cycle: 1, passed: false, checks: [], conflict_files: [] };
  assert.throws(() => sm.transition(s, 'A-1', 'COMPLETED', {}), code('INTEGRATION_CHECK_REQUIRED'));
  s.tasks['A-1'].integration.passed = true;
  sm.transition(s, 'A-1', 'COMPLETED', {});
  assert.equal(sm.summary(s).run_state, 'COMPLETE');
});

test('a failed verification can never be represented as success', () => {
  const s = mkState([contract('A-1')]);
  implement(s, 'A-1');
  verify(s, 'A-1', false);
  assert.throws(() => sm.transition(s, 'A-1', 'REVIEWING', {}), code('VERIFICATION_FAILED'));
  assert.throws(() => sm.transition(s, 'A-1', 'APPROVED', {}), code('ILLEGAL_TRANSITION'));
  sm.transition(s, 'A-1', 'CORRECTION_REQUIRED', { reason: 'tests failed' });
  assert.throws(() => sm.transition(s, 'A-1', 'APPROVED', {}), code('ILLEGAL_TRANSITION'));
  assert.throws(() => sm.transition(s, 'A-1', 'COMPLETED', {}), code('ILLEGAL_TRANSITION'));
});

test('a rejecting review or a missing independent review blocks approval', () => {
  const s = mkState([contract('A-1', { complexity_score: 7 })]);
  assert.equal(s.tasks['A-1'].route.review.independent, 1);
  implement(s, 'A-1');
  verify(s, 'A-1', true);
  sm.transition(s, 'A-1', 'REVIEWING', {});
  review(s, 'A-1', 'orchestrator', 'approve');
  assert.throws(() => sm.transition(s, 'A-1', 'APPROVED', {}), code('REVIEW_REQUIRED'));
  review(s, 'A-1', 'review-worker', 'reject');
  assert.throws(() => sm.transition(s, 'A-1', 'APPROVED', {}), code('REVIEW_REJECTED'));
  assert.equal(sm.reviewGate(s.tasks['A-1']).rejected, true);
  s.tasks['A-1'].reviews.pop();
  review(s, 'A-1', 'review-worker', 'approve');
  sm.transition(s, 'A-1', 'APPROVED', {});
});

test('maximum mode asks for two distinct independent perspectives on high-risk work', () => {
  const s = mkState([contract('A-1', { risk_level: 'high' })], { mode: 'maximum' });
  assert.equal(s.tasks['A-1'].route.review.independent, 2);
  implement(s, 'A-1');
  verify(s, 'A-1', true);
  sm.transition(s, 'A-1', 'REVIEWING', {});
  review(s, 'A-1', 'orchestrator', 'approve');
  review(s, 'A-1', 'review-worker', 'approve', 'correctness');
  review(s, 'A-1', 'review-worker', 'approve', 'correctness');
  assert.throws(() => sm.transition(s, 'A-1', 'APPROVED', {}), code('REVIEW_REQUIRED'), 'two approvals from the same perspective count once');
  review(s, 'A-1', 'review-worker', 'approve', 'security');
  sm.transition(s, 'A-1', 'APPROVED', {});
});

test('correction loops are bounded and need a recorded correction request', () => {
  const s = mkState([contract('A-1')]);
  implement(s, 'A-1');
  verify(s, 'A-1', false);
  sm.transition(s, 'A-1', 'CORRECTION_REQUIRED', {});
  assert.throws(() => sm.transition(s, 'A-1', 'READY', {}), code('CORRECTION_REQUEST_REQUIRED'));
  for (let round = 1; round <= 3; round++) {
    correct(s, 'A-1');
    implement(s, 'A-1');
    verify(s, 'A-1', false);
    sm.transition(s, 'A-1', 'CORRECTION_REQUIRED', {});
  }
  assert.equal(s.tasks['A-1'].review_round, 3);
  s.tasks['A-1'].review_round++;
  s.tasks['A-1'].corrections.push({ round: 4, failure: 'f', required_change: 'c' });
  assert.throws(() => sm.transition(s, 'A-1', 'READY', {}), (e) => e.code === 'CORRECTION_LIMIT' && e.exit === 3);
  s.tasks['A-1'].extra_rounds = 1; // explicit, recorded user authorization
  sm.transition(s, 'A-1', 'READY', { reason: 'authorized extra round' });
});

test('retries are bounded; external side effects are never retried or dispatched without authorization', () => {
  const s = mkState([contract('A-1'), contract('E-1', { side_effects: 'external' })]);
  for (let i = 1; i <= 2; i++) {
    dispatch(s, 'A-1');
    s.tasks['A-1'].retries++;
    sm.transition(s, 'A-1', 'READY', { reason: `retry ${i}` });
  }
  dispatch(s, 'A-1');
  s.tasks['A-1'].retries++;
  assert.throws(() => sm.transition(s, 'A-1', 'READY', {}), (e) => e.code === 'RETRY_LIMIT' && e.exit === 3);
  sm.transition(s, 'A-1', 'BLOCKED', { kind: 'retries_exhausted', reason: 'no retries left' });

  assert.throws(() => sm.transition(s, 'E-1', 'DISPATCHED', {}), code('AUTHORIZATION_REQUIRED'));
  s.tasks['E-1'].authorized = true;
  dispatch(s, 'E-1');
  assert.throws(() => sm.transition(s, 'E-1', 'READY', {}), code('RETRY_UNSAFE'));
});

test('cancelled, completed and failed tasks do not restart on their own', () => {
  const s = mkState([contract('A-1'), contract('B-1'), contract('C-1')]);
  sm.transition(s, 'A-1', 'CANCELLED', { reason: 'user abort' });
  assert.throws(() => sm.transition(s, 'A-1', 'READY', {}), code('ILLEGAL_TRANSITION'));
  assert.throws(() => sm.transition(s, 'A-1', 'PENDING', { reason: 'again' }), code('CANCELLED_IS_TERMINAL'));
  sm.transition(s, 'A-1', 'PENDING', { reason: 'user asked to restart it', userAuthorized: true });

  complete(s, 'B-1');
  assert.throws(() => sm.transition(s, 'B-1', 'READY', {}), code('EXPLICIT_REASON_REQUIRED'));
  sm.transition(s, 'B-1', 'READY', { reason: 'acceptance criteria changed' });

  dispatch(s, 'C-1');
  sm.transition(s, 'C-1', 'FAILED', { reason: 'gave up' });
  assert.throws(() => sm.transition(s, 'C-1', 'READY', { reason: 'retry' }), code('STRATEGY_CHANGE_REQUIRED'));
  sm.transition(s, 'C-1', 'READY', { reason: 'escalated to opus', strategyChange: true });
});

test('a failed dependency blocks dependents; reopening it releases them', () => {
  const s = mkState([contract('A-1'), contract('B-1', { dependencies: ['A-1'] })]);
  dispatch(s, 'A-1');
  sm.transition(s, 'A-1', 'FAILED', { reason: 'unfixable' });
  sm.refresh(s);
  assert.equal(s.tasks['B-1'].state, 'BLOCKED');
  assert.equal(s.tasks['B-1'].block.kind, 'dependency');
  assert.equal(sm.summary(s).run_state, 'STALLED');
  sm.transition(s, 'A-1', 'READY', { reason: 'escalated', strategyChange: true });
  sm.refresh(s);
  assert.equal(s.tasks['B-1'].state, 'PENDING');
});

test('integrations run one at a time', () => {
  const s = mkState([contract('A-1'), contract('B-1')]);
  for (const id of ['A-1', 'B-1']) {
    implement(s, id);
    verify(s, id, true);
    sm.transition(s, id, 'REVIEWING', {});
    review(s, id, 'orchestrator', 'approve');
    sm.transition(s, id, 'APPROVED', {});
  }
  sm.transition(s, 'A-1', 'INTEGRATING', {});
  assert.throws(() => sm.transition(s, 'B-1', 'INTEGRATING', {}), code('INTEGRATION_BUSY'));
});

test('scheduler views: in-flight and half-finished work keeps its slot and file scope', () => {
  const s = mkState([contract('A-1'), contract('B-1'), contract('C-1')]);
  dispatch(s, 'A-1');
  implement(s, 'B-1');
  const v = Object.fromEntries(sm.schedulerViews(s).map((x) => [x.id, x]));
  assert.deepEqual([v['A-1'].usesSlot, v['A-1'].holdsScope], [true, true]);
  assert.deepEqual([v['B-1'].usesSlot, v['B-1'].holdsScope], [false, true]);
  assert.deepEqual([v['C-1'].usesSlot, v['C-1'].holdsScope], [false, false]);
});

test('budget: warns near the limit, stops at it, and only explicit authorization extends it', () => {
  const s = mkState([contract('A-1')]);
  assert.equal(sm.budgetStatus(s).exceeded, false);
  assert.equal(sm.budgetStatus(s).remaining_calls, Infinity, 'null limit means no user-set limit');
  s.config.budget.agent_call_limit = 5;
  s.budget.agent_calls = 3;
  assert.deepEqual(sm.budgetStatus(s).warnings, []);
  s.budget.agent_calls = 4;
  assert.match(sm.budgetStatus(s).warnings.join(' '), /80%/);
  s.budget.agent_calls = 5;
  assert.equal(sm.budgetStatus(s).exceeded, true);
  s.budget.extra_agent_calls = 2;
  assert.equal(sm.budgetStatus(s).exceeded, false);
  assert.equal(sm.budgetStatus(s).remaining_calls, 2);
  s.config.budget.cost_limit_usd = 10;
  assert.match(sm.budgetStatus(s).notes.join(' '), /not enforceable inside a session/);
  s.config.budget.token_limit = 1000;
  s.budget.tokens_reported = 1200;
  assert.equal(sm.budgetStatus(s).exceeded, true);
});

test('persistence: atomic writes, event log, checkpoint, and no write when a transaction throws', () => {
  const dir = tmp();
  const store = new sm.Store(dir);
  store.create(mkState([contract('A-1'), contract('B-1', { dependencies: ['A-1'] })]));
  store.transact((s) => { implement(s, 'A-1'); s.decisions.push({ at: sm.nowIso(), text: 'assumed X' }); });
  assert.throws(() => store.transact((s) => { s.phase = 'BROKEN'; sm.transition(s, 'B-1', 'RUNNING', {}); }), code('ILLEGAL_TRANSITION'));
  const s = store.read();
  assert.equal(s.phase, 'PLANNED', 'the failed transaction left no trace');
  assert.equal(s.tasks['A-1'].state, 'IMPLEMENTED');
  assert.ok(!fs.existsSync(store.lockPath), 'the lock is released even after a failure');
  assert.ok(fs.readdirSync(dir).every((f) => !f.includes('.tmp-')), 'no temp files are left behind');
  const events = fs.readFileSync(store.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.type === 'transition' && e.task === 'A-1' && e.to === 'IMPLEMENTED'));
  assert.deepEqual(events.map((e) => e.seq), [...events.map((e) => e.seq)].sort((a, b) => a - b));
  const cp = yaml.parse(fs.readFileSync(path.join(dir, 'checkpoint.yaml'), 'utf8'));
  assert.equal(cp.run_id, 'test-run');
  assert.equal(cp.tasks.find((t) => t.id === 'A-1').state, 'IMPLEMENTED');
  assert.deepEqual(cp.decisions, ['assumed X']);
  assert.ok(cp.next_actions.some((a) => /A-1: IMPLEMENTED/.test(a)));
});

test('recovery: corrupted state falls back to the backup, then to a snapshot, and reports what was lost', () => {
  const dir = tmp();
  const store = new sm.Store(dir);
  store.create(mkState([contract('A-1')]));
  store.transact((s) => { s.decisions.push({ at: sm.nowIso(), text: 'one' }); sm.emit(s, { type: 'decision' }); });
  store.transact((s) => { s.decisions.push({ at: sm.nowIso(), text: 'two' }); sm.emit(s, { type: 'decision' }); });
  fs.writeFileSync(store.statePath, '{ "schema": 1, "run_id": "test-run", "tasks": {');
  const s1 = store.read();
  assert.equal(store.recovered.from, 'state.json.bak');
  assert.deepEqual(s1.decisions.map((d) => d.text), ['one'], 'the backup is one transaction behind');
  store.transact(() => {});
  assert.ok(store.recovered.lost_events.length >= 1, 'events newer than the backup are listed for reconciliation');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-')), 'the unreadable file is preserved as evidence');
  store.read();
  assert.equal(store.recovered, null, 'state.json is valid again');

  store.transact((s) => { for (let i = 0; i < 12; i++) sm.emit(s, { type: 'tick' }); });
  assert.ok(store.snapshotFiles().length >= 1);
  fs.writeFileSync(store.statePath, 'garbage');
  fs.writeFileSync(`${store.statePath}.bak`, 'garbage');
  store.read();
  assert.match(store.recovered.from, /^state-\d+\.json$/);

  for (const f of store.snapshotFiles()) fs.writeFileSync(f, 'garbage');
  assert.throws(() => store.read(), (e) => e.code === 'STATE_UNRECOVERABLE' && e.exit === 1);
});

test('locking: a stale lock is taken over, a live one is released after use', () => {
  const dir = tmp();
  const store = new sm.Store(dir);
  store.create(mkState([contract('A-1')]));
  fs.writeFileSync(store.lockPath, 'dead-process');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(store.lockPath, old, old);
  store.transact((s) => { s.decisions.push({ at: sm.nowIso(), text: 'after stale lock' }); });
  assert.equal(store.read().decisions.length, 1);
  assert.ok(!fs.existsSync(store.lockPath));
});

test('views: next actions, summary states and the final report reflect recorded state only', () => {
  const s = mkState([contract('A-1'), contract('B-1', { dependencies: ['A-1'] }), contract('C-1')]);
  complete(s, 'A-1');
  implement(s, 'C-1');
  verify(s, 'C-1', false);
  sm.transition(s, 'C-1', 'CORRECTION_REQUIRED', { reason: 'verification failed: npm test' });
  assert.equal(sm.summary(s).run_state, 'IN_PROGRESS');
  const actions = sm.nextActions(s).join('\n');
  assert.match(actions, /B-1: READY/);
  assert.match(actions, /C-1: CORRECTION_REQUIRED \(verification failed: npm test\)/);
  const md = sm.finalReport(s, '/run/dir');
  assert.match(md, /\*\*IN_PROGRESS\*\* \(1 of 3 tasks completed\)/);
  assert.match(md, /FAIL \[command\] npm test/);
  assert.match(md, /C-1 is CORRECTION_REQUIRED/);
  assert.match(md, /Token usage: not reported/);
  assert.doesNotMatch(md, /Every task completed/);
});
