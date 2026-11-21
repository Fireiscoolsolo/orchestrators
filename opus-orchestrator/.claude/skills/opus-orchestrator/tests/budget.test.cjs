'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../scripts/lib/budget.cjs');

const cfg = (o) => Object.assign({ enabled: true, token_limit: null, cost_limit_usd: null, agent_call_limit: null, warning_threshold_percent: 80 }, o);
const lim = (res, name) => res.limits.find((l) => l.name === name);

test('newUsage shape', () => {
  const u = B.newUsage();
  assert.equal(u.agent_calls, 0);
  assert.equal(u.tokens_measured, false);
  assert.equal(u.cost_usd, null);
  assert.deepEqual(u.tokens, { input: 0, output: 0, cached: 0, total: 0 });
});

test('record functions do not mutate and count calls', () => {
  const u0 = B.newUsage();
  const snap = JSON.stringify(u0);
  let u = B.recordCall(u0, { task_id: 'A-001', kind: 'worker' });
  assert.equal(JSON.stringify(u0), snap);
  u = B.recordCall(u, { task_id: 'A-001', kind: 'review' });
  u = B.recordCall(u, { task_id: 'A-001', kind: 'retry' });
  u = B.recordCall(u, { task_id: 'A-001', kind: 'correction' });
  assert.equal(u.agent_calls, 4);
  assert.equal(u.review_calls, 1);
  assert.equal(u.retries, 1);
  assert.equal(u.corrections, 1);
  assert.equal(u.worker_calls, 3);
  assert.equal(u.by_task['A-001'].calls, 4);
  const u2 = B.recordVerification(u, 'A-001');
  assert.equal(u.verification_runs, 0);
  assert.equal(u2.verification_runs, 1);
  const u3 = B.recordTokens(u2, { task_id: 'A-001', input: 10, output: 5, cached: 2 });
  assert.equal(u2.tokens_measured, false);
  assert.equal(u3.tokens_measured, true);
  assert.equal(u3.tokens.total, 15);
  const u4 = B.recordCost(u3, 0.5);
  assert.equal(u3.cost_measured, false);
  assert.equal(u4.cost_measured, true);
  assert.equal(u4.cost_usd, 0.5);
});

test('agent_call_limit ok, warning, exceeded', () => {
  let u = B.newUsage();
  const c = cfg({ agent_call_limit: 10 });
  for (let i = 0; i < 7; i++) u = B.recordCall(u, { task_id: 'A-001', kind: 'worker' });
  assert.equal(B.check(u, c).state, 'ok');
  u = B.recordCall(u, { task_id: 'A-001', kind: 'worker' });
  assert.equal(B.check(u, c).state, 'warning');
  u = B.recordCall(u, {});
  assert.equal(B.check(u, c).state, 'warning');
  u = B.recordCall(u, {});
  const r = B.check(u, c);
  assert.equal(r.state, 'exceeded');
  assert.equal(lim(r, 'agent_call_limit').percent, 100);
  assert.ok(r.messages.length > 0);
});

test('token limit only enforced when measured', () => {
  const c = cfg({ token_limit: 100 });
  let r = B.check(B.newUsage(), c);
  assert.equal(lim(r, 'token_limit').enforceable, false);
  assert.equal(r.state, 'ok');
  const u = B.recordTokens(B.newUsage(), { total: 150 });
  r = B.check(u, c);
  assert.equal(lim(r, 'token_limit').enforceable, true);
  assert.equal(r.state, 'exceeded');
});

test('cost limit not enforceable until measured', () => {
  const c = cfg({ cost_limit_usd: 1 });
  let r = B.check(B.newUsage(), c);
  const l = lim(r, 'cost_limit_usd');
  assert.equal(l.enforceable, false);
  assert.equal(l.note, 'cost is not measurable in-session');
  assert.equal(r.state, 'ok');
  r = B.check(B.recordCost(B.newUsage(), 2), c);
  assert.equal(r.state, 'exceeded');
});

test('null limits report no limit set; disabled state', () => {
  const r = B.check(B.newUsage(), cfg());
  for (const l of r.limits) assert.equal(l.note, 'no limit set');
  assert.equal(r.state, 'ok');
  assert.equal(B.check(B.newUsage(), cfg({ enabled: false, agent_call_limit: 1 })).state, 'disabled');
});

test('authorize raises limits only for the user with a reason', () => {
  assert.throws(() => B.authorize([], { limit: 'agent_call_limit', value: 20, by: 'orchestrator', reason: 'x', now: 't' }),
    (e) => e instanceof B.BudgetError && e.code === 'NOT_USER');
  assert.throws(() => B.authorize([], { limit: 'agent_call_limit', value: 20, by: 'user', reason: '  ', now: 't' }),
    (e) => e.code === 'NOT_USER');
  const orig = [];
  const auths = B.authorize(orig, { limit: 'agent_call_limit', value: 20, by: 'user', reason: 'bigger job', now: '2026-01-01T00:00:00.000Z' });
  assert.equal(orig.length, 0);
  assert.deepEqual(auths[0], { limit: 'agent_call_limit', value: 20, by: 'user', reason: 'bigger job', ts: '2026-01-01T00:00:00.000Z' });
  let u = B.newUsage();
  for (let i = 0; i < 10; i++) u = B.recordCall(u, {});
  const c = cfg({ agent_call_limit: 10 });
  assert.equal(B.check(u, c).state, 'exceeded');
  const r = B.check(u, c, auths);
  assert.equal(r.state, 'ok');
  assert.equal(lim(r, 'agent_call_limit').limit, 20);
});

test('remainingCalls', () => {
  let u = B.newUsage();
  assert.equal(B.remainingCalls(u, cfg(), []), Infinity);
  u = B.recordCall(B.recordCall(u, {}), {});
  assert.equal(B.remainingCalls(u, cfg({ agent_call_limit: 5 }), []), 3);
  const a = B.authorize([], { limit: 'agent_call_limit', value: 9, by: 'user', reason: 'r', now: 't' });
  assert.equal(B.remainingCalls(u, cfg({ agent_call_limit: 5 }), a), 7);
  assert.equal(B.remainingCalls(u, cfg({ agent_call_limit: 1 }), []), 0);
});
