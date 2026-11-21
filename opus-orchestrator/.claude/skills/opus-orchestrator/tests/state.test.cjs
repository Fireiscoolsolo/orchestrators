'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sm = require('../scripts/lib/statemachine.cjs');

const NOW = '2026-01-01T00:00:00.000Z';
const LIMITS = { max_review_rounds: 3, max_retries: 2 };

const EXPECTED_STATES = ['PENDING', 'READY', 'DISPATCHED', 'RUNNING', 'IMPLEMENTED', 'VERIFYING', 'REVIEWING',
  'CORRECTION_REQUIRED', 'APPROVED', 'INTEGRATING', 'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'];
const EXPECTED_TABLE = {
  PENDING: 'READY BLOCKED FAILED CANCELLED',
  READY: 'DISPATCHED BLOCKED FAILED CANCELLED',
  DISPATCHED: 'RUNNING READY BLOCKED FAILED CANCELLED',
  RUNNING: 'IMPLEMENTED READY BLOCKED FAILED CANCELLED',
  IMPLEMENTED: 'VERIFYING BLOCKED FAILED CANCELLED',
  VERIFYING: 'REVIEWING CORRECTION_REQUIRED BLOCKED FAILED CANCELLED',
  REVIEWING: 'APPROVED CORRECTION_REQUIRED BLOCKED FAILED CANCELLED',
  CORRECTION_REQUIRED: 'READY BLOCKED FAILED CANCELLED',
  APPROVED: 'INTEGRATING BLOCKED FAILED CANCELLED',
  INTEGRATING: 'COMPLETED CORRECTION_REQUIRED BLOCKED FAILED CANCELLED',
  COMPLETED: 'PENDING',
  BLOCKED: 'PENDING READY FAILED CANCELLED',
  FAILED: 'READY CANCELLED',
  CANCELLED: 'PENDING',
};

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
function task(over) {
  return {
    task_id: 'T-001', status: 'PENDING', side_effects: 'none', review_round: 0, attempts: 0, retries: 0,
    history: [], correction: null, failure: null, block: null,
    evidence: { self_check: null, verification: null, reviews: [], integration: null },
    ...over,
  };
}
const passedVerification = { passed: true, run_at: NOW, commands: [], checks: [], scope: { ok: true, violations: [] } };
const approve = (reviewer, independent) => ({ reviewer, independent: !!independent, verdict: 'approve', criteria: [], findings: [], recorded_at: NOW });
const ctx = (over) => ({ now: NOW, reason: 'because', actor: 'test', limits: LIMITS, ...over });
function code(fn, c) {
  assert.throws(fn, (e) => e instanceof sm.TransitionError && e.code === c, `expected ${c}`);
}

test('STATES, groups and TRANSITIONS match the design', () => {
  assert.deepEqual(sm.STATES, EXPECTED_STATES);
  assert.deepEqual(sm.TERMINAL, ['COMPLETED', 'FAILED', 'CANCELLED']);
  assert.deepEqual(sm.IN_FLIGHT, ['DISPATCHED', 'RUNNING']);
  assert.deepEqual(sm.OWNS_WORK, ['DISPATCHED', 'RUNNING', 'IMPLEMENTED', 'VERIFYING', 'REVIEWING',
    'CORRECTION_REQUIRED', 'APPROVED', 'INTEGRATING']);
  const exp = {};
  for (const [k, v] of Object.entries(EXPECTED_TABLE)) exp[k] = v.split(' ');
  assert.deepEqual(sm.TRANSITIONS, exp);
  assert.equal(sm.isTerminal('FAILED'), true);
  assert.equal(sm.isTerminal('BLOCKED'), false);
  assert.match(sm.describe(), /CORRECTION_REQUIRED/);
});

test('every ordered pair outside the table throws INVALID_TRANSITION (196 pairs)', () => {
  let n = 0;
  for (const from of sm.STATES) {
    for (const to of sm.STATES) {
      if (from === to) continue;
      if (EXPECTED_TABLE[from].split(' ').includes(to)) {
        assert.equal(sm.canTransition(from, to), true);
        continue;
      }
      n++;
      assert.equal(sm.canTransition(from, to), false);
      // pass every authorization so only the table can refuse
      const t = task({ status: from, correction: { x: 1 }, evidence: { verification: passedVerification, reviews: [approve('orchestrator', true)], integration: { passed: true } } });
      code(() => sm.transition(t, to, ctx({ depsCompleted: true, userAuthorized: true, escalated: true, requiresIndependentReview: true })), 'INVALID_TRANSITION');
    }
  }
  // 14*14 = 196 ordered pairs including self-pairs; self-pairs are not in the table either
  for (const s of sm.STATES) {
    n++;
    assert.equal(sm.canTransition(s, s), false);
    code(() => sm.transition(task({ status: s }), s, ctx({ userAuthorized: true })), 'INVALID_TRANSITION');
  }
  const allowed = Object.values(EXPECTED_TABLE).reduce((a, v) => a + v.split(' ').length, 0);
  assert.equal(n, 196 - allowed);
});

test('normal path PENDING to COMPLETED', () => {
  let t = task();
  t = sm.transition(t, 'READY', ctx({ depsCompleted: true }));
  t = sm.transition(t, 'DISPATCHED', ctx({ depsCompleted: true }));
  assert.equal(t.attempts, 1);
  t = sm.transition(t, 'RUNNING', ctx());
  t = sm.transition(t, 'IMPLEMENTED', ctx());
  t = sm.transition(t, 'VERIFYING', ctx());
  t = { ...t, evidence: { ...t.evidence, verification: passedVerification } };
  t = sm.transition(t, 'REVIEWING', ctx());
  t = { ...t, evidence: { ...t.evidence, reviews: [approve('orchestrator')] } };
  t = sm.transition(t, 'APPROVED', ctx());
  t = sm.transition(t, 'INTEGRATING', ctx());
  t = { ...t, evidence: { ...t.evidence, integration: { passed: true, run_at: NOW, commands: [], merged_commit: 'abc' } } };
  t = sm.transition(t, 'COMPLETED', ctx());
  assert.equal(t.status, 'COMPLETED');
  assert.equal(t.history.length, 9);
  assert.deepEqual(Object.keys(t.history[0]).sort(), ['actor', 'from', 'reason', 'to', 'ts']);
  assert.equal(t.history[0].from, 'PENDING');
  assert.equal(t.history[8].to, 'COMPLETED');
});

test('failed-review path REVIEWING to CORRECTION_REQUIRED to READY', () => {
  let t = task({ status: 'REVIEWING', evidence: { verification: passedVerification, reviews: [], integration: null } });
  t = sm.transition(t, 'CORRECTION_REQUIRED', ctx());
  assert.equal(t.status, 'CORRECTION_REQUIRED');
  assert.equal(t.review_round, 0);
  t = { ...t, correction: { items: ['fix it'] } };
  t = sm.transition(t, 'READY', ctx());
  assert.equal(t.status, 'READY');
  assert.equal(t.review_round, 1);
  assert.equal(t.history.at(-1).from, 'CORRECTION_REQUIRED');
});

test('dependencies guard: PENDING/BLOCKED->READY and READY->DISPATCHED', () => {
  for (const [from, to] of [['PENDING', 'READY'], ['BLOCKED', 'READY'], ['READY', 'DISPATCHED']]) {
    const t = task({ status: from });
    code(() => sm.transition(t, to, ctx()), 'DEPS_UNSATISFIED');
    code(() => sm.transition(t, to, ctx({ depsCompleted: 'yes' })), 'DEPS_UNSATISFIED');
    code(() => sm.transition(t, to, ctx({ depsCompleted: false })), 'DEPS_UNSATISFIED');
    assert.equal(sm.transition(t, to, ctx({ depsCompleted: true })).status, to);
  }
});

test('dispatch increments attempts only on READY->DISPATCHED', () => {
  const t = sm.transition(task({ status: 'READY', attempts: 4 }), 'DISPATCHED', ctx({ depsCompleted: true }));
  assert.equal(t.attempts, 5);
  assert.equal(sm.transition(t, 'RUNNING', ctx()).attempts, 5);
});

test('retry guards: limit, external side effects, success increments retries', () => {
  for (const from of ['DISPATCHED', 'RUNNING']) {
    const t = task({ status: from, retries: 1 });
    const ok = sm.transition(t, 'READY', ctx());
    assert.equal(ok.retries, 2);
    assert.equal(ok.status, 'READY');
    code(() => sm.transition(task({ status: from, retries: 2 }), 'READY', ctx()), 'RETRY_LIMIT');
    code(() => sm.transition(t, 'READY', ctx({ limits: undefined })), 'RETRY_LIMIT');
    code(() => sm.transition(task({ status: from, side_effects: 'external' }), 'READY', ctx()), 'UNSAFE_RETRY');
    assert.equal(sm.transition(task({ status: from, side_effects: 'local' }), 'READY', ctx()).retries, 1);
  }
});

test('VERIFYING->REVIEWING needs passed verification', () => {
  const ev = (v) => ({ verification: v, reviews: [], integration: null });
  code(() => sm.transition(task({ status: 'VERIFYING' }), 'REVIEWING', ctx()), 'VERIFICATION_FAILED');
  code(() => sm.transition(task({ status: 'VERIFYING', evidence: ev({ passed: false }) }), 'REVIEWING', ctx()), 'VERIFICATION_FAILED');
  code(() => sm.transition(task({ status: 'VERIFYING', evidence: ev({ passed: 'true' }) }), 'REVIEWING', ctx()), 'VERIFICATION_FAILED');
  assert.equal(sm.transition(task({ status: 'VERIFYING', evidence: ev(passedVerification) }), 'REVIEWING', ctx()).status, 'REVIEWING');
  // failed verification may go to correction
  assert.equal(sm.transition(task({ status: 'VERIFYING', evidence: ev({ passed: false }) }), 'CORRECTION_REQUIRED', ctx()).status, 'CORRECTION_REQUIRED');
});

test('REVIEWING->APPROVED guards', () => {
  const mk = (verification, reviews) => task({ status: 'REVIEWING', evidence: { verification, reviews, integration: null } });
  code(() => sm.transition(mk(null, [approve('orchestrator')]), 'APPROVED', ctx()), 'UNVERIFIED');
  code(() => sm.transition(mk({ passed: false }, [approve('orchestrator')]), 'APPROVED', ctx()), 'UNVERIFIED');
  code(() => sm.transition(mk(passedVerification, []), 'APPROVED', ctx()), 'NO_APPROVAL');
  code(() => sm.transition(mk(passedVerification, [approve('someone-else', true)]), 'APPROVED', ctx()), 'NO_APPROVAL');
  // latest orchestrator review wins
  const reject = { ...approve('orchestrator'), verdict: 'reject' };
  code(() => sm.transition(mk(passedVerification, [approve('orchestrator'), reject]), 'APPROVED', ctx()), 'NO_APPROVAL');
  assert.equal(sm.transition(mk(passedVerification, [reject, approve('orchestrator')]), 'APPROVED', ctx()).status, 'APPROVED');
  // independent review
  const req = ctx({ requiresIndependentReview: true });
  code(() => sm.transition(mk(passedVerification, [approve('orchestrator')]), 'APPROVED', req), 'NO_INDEPENDENT_REVIEW');
  const indepReject = { ...approve('rev', true), verdict: 'reject' };
  code(() => sm.transition(mk(passedVerification, [approve('orchestrator'), indepReject]), 'APPROVED', req), 'NO_INDEPENDENT_REVIEW');
  code(() => sm.transition(mk(passedVerification, [approve('orchestrator'), approve('rev', false)]), 'APPROVED', req), 'NO_INDEPENDENT_REVIEW');
  assert.equal(sm.transition(mk(passedVerification, [approve('rev', true), approve('orchestrator')]), 'APPROVED', req).status, 'APPROVED');
});

test('CORRECTION_REQUIRED->READY guards', () => {
  code(() => sm.transition(task({ status: 'CORRECTION_REQUIRED' }), 'READY', ctx()), 'NO_CORRECTION');
  const t = task({ status: 'CORRECTION_REQUIRED', correction: { a: 1 }, review_round: 3 });
  code(() => sm.transition(t, 'READY', ctx()), 'CORRECTION_LIMIT');
  code(() => sm.transition({ ...t, review_round: 0 }, 'READY', ctx({ limits: {} })), 'CORRECTION_LIMIT');
  const ok = sm.transition({ ...t, review_round: 2 }, 'READY', ctx());
  assert.equal(ok.review_round, 3);
});

test('INTEGRATING->COMPLETED needs passed integration; failed integration may correct', () => {
  const mk = (integration) => task({ status: 'INTEGRATING', evidence: { verification: null, reviews: [], integration } });
  code(() => sm.transition(mk(null), 'COMPLETED', ctx()), 'INTEGRATION_FAILED');
  code(() => sm.transition(mk({ passed: false }), 'COMPLETED', ctx()), 'INTEGRATION_FAILED');
  assert.equal(sm.transition(mk({ passed: true }), 'COMPLETED', ctx()).status, 'COMPLETED');
  assert.equal(sm.transition(mk({ passed: false }), 'CORRECTION_REQUIRED', ctx()).status, 'CORRECTION_REQUIRED');
});

test('FAILED->READY needs authorization and dependencies', () => {
  const t = task({ status: 'FAILED', failure: { kind: 'x', reason: 'r', ts: NOW } });
  code(() => sm.transition(t, 'READY', ctx({ depsCompleted: true })), 'NOT_AUTHORIZED');
  code(() => sm.transition(t, 'READY', ctx({ depsCompleted: true, userAuthorized: 'yes' })), 'NOT_AUTHORIZED');
  code(() => sm.transition(t, 'READY', ctx({ userAuthorized: true })), 'DEPS_UNSATISFIED');
  code(() => sm.transition(t, 'READY', ctx({ escalated: true })), 'DEPS_UNSATISFIED');
  assert.equal(sm.transition(t, 'READY', ctx({ userAuthorized: true, depsCompleted: true })).status, 'READY');
  const e = sm.transition(t, 'READY', ctx({ escalated: true, depsCompleted: true }));
  assert.equal(e.status, 'READY');
  assert.equal(e.failure, null);
});

test('CANCELLED and COMPLETED reopen need userAuthorized', () => {
  for (const from of ['CANCELLED', 'COMPLETED']) {
    const t = task({ status: from });
    code(() => sm.transition(t, 'PENDING', ctx()), 'NOT_AUTHORIZED');
    code(() => sm.transition(t, 'PENDING', ctx({ escalated: true, depsCompleted: true })), 'NOT_AUTHORIZED');
    code(() => sm.transition(t, 'PENDING', ctx({ userAuthorized: 1 })), 'NOT_AUTHORIZED');
    assert.equal(sm.transition(t, 'PENDING', ctx({ userAuthorized: true })).status, 'PENDING');
  }
});

test('BLOCKED/FAILED/CANCELLED require a reason from every state that allows them', () => {
  for (const to of ['BLOCKED', 'FAILED', 'CANCELLED']) {
    for (const from of sm.STATES) {
      if (!sm.canTransition(from, to)) continue;
      const t = task({ status: from });
      code(() => sm.transition(t, to, ctx({ reason: undefined })), 'REASON_REQUIRED');
      code(() => sm.transition(t, to, ctx({ reason: '' })), 'REASON_REQUIRED');
      code(() => sm.transition(t, to, ctx({ reason: '   ' })), 'REASON_REQUIRED');
      const ok = sm.transition(t, to, ctx({ reason: 'why' }));
      assert.equal(ok.status, to);
      assert.equal(ok.history.at(-1).reason, 'why');
    }
  }
});

test('BLOCKED and FAILED record block/failure; leaving BLOCKED clears block', () => {
  let t = sm.transition(task({ status: 'READY' }), 'BLOCKED', ctx({ reason: 'need input' }));
  assert.deepEqual(t.block, { kind: 'manual', reason: 'need input', ts: NOW });
  const t2 = sm.transition(task({ status: 'READY' }), 'BLOCKED', ctx({ reason: 'r', kind: 'budget' }));
  assert.equal(t2.block.kind, 'budget');
  t = sm.transition(t, 'READY', ctx({ depsCompleted: true }));
  assert.equal(t.block, null);
  const f = sm.transition(task({ status: 'RUNNING' }), 'FAILED', ctx({ reason: 'boom', kind: 'worker' }));
  assert.deepEqual(f.failure, { kind: 'worker', reason: 'boom', ts: NOW });
});

test('history entry fields and counters', () => {
  const t = sm.transition(task({ status: 'PENDING' }), 'READY', ctx({ depsCompleted: true, reason: 'go', actor: 'sched' }));
  assert.deepEqual(t.history, [{ ts: NOW, from: 'PENDING', to: 'READY', reason: 'go', actor: 'sched' }]);
});

test('transition never mutates its input and requires ctx.now', () => {
  const t = deepFreeze(task({ status: 'READY', history: [{ ts: NOW, from: 'PENDING', to: 'READY', reason: null, actor: 'x' }] }));
  const out = sm.transition(t, 'DISPATCHED', ctx({ depsCompleted: true }));
  assert.equal(t.status, 'READY');
  assert.equal(t.attempts, 0);
  assert.equal(t.history.length, 1);
  assert.equal(out.history.length, 2);
  assert.notEqual(out, t);
  assert.notEqual(out.history, t.history);
  const f = deepFreeze(task({ status: 'RUNNING' }));
  assert.equal(sm.transition(f, 'READY', ctx()).retries, 1);
  assert.equal(f.retries, 0);
  for (const bad of [undefined, null, '', 'not a date', 5]) {
    code(() => sm.transition(task({ status: 'PENDING' }), 'READY', { depsCompleted: true, now: bad }), 'NOW_REQUIRED');
  }
  code(() => sm.transition(task({ status: 'PENDING' }), 'READY', undefined), 'NOW_REQUIRED');
});

test('module is pure: no fs, child_process or Date.now', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'statemachine.cjs'), 'utf8');
  assert.doesNotMatch(src, /require\(\s*['"](node:)?(fs|child_process|os|path)/);
  assert.doesNotMatch(src, /Date\.now|new Date\(\)/);
  assert.doesNotMatch(src, /process\.(exit|stdout|stderr)|console\./);
});
