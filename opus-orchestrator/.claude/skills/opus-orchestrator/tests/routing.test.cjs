'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../scripts/lib/routing.cjs');

function cfg() {
  const role = (agent, writes) => ({ agent, writes, brief: 'test role' });
  return {
    execution: { mode: 'balanced', max_retries: 2, independent_verification: true },
    models: { orchestrator: 'opus', worker_default: 'haiku', escalation: 'opus', allowed: ['haiku', 'sonnet', 'opus'], relative_cost: { haiku: 1, sonnet: 3, opus: 5 } },
    routing: {
      adaptive: true, prefer_haiku: true, allow_opus_escalation: true, min_observations: 5,
      heuristic_expected_attempts: {
        haiku: { '1-2': 1.0, '3-4': 1.2, '5-6': 1.5, '7-8': 2.2, '9-10': 3.0 },
        sonnet: { '1-2': 1.0, '3-4': 1.1, '5-6': 1.3, '7-8': 1.7, '9-10': 2.2 },
        opus: { '1-2': 1.0, '3-4': 1.0, '5-6': 1.1, '7-8': 1.3, '9-10': 1.6 },
      },
      roles: {
        'research-worker': role('opus-researcher', false),
        'repository-worker': role('opus-researcher', false),
        'implementation-worker': role('opus-implementer', true),
        'documentation-worker': role('opus-implementer', true),
        'integration-worker': role('opus-implementer', true),
        'test-worker': role('opus-tester', true),
        'verification-worker': role('opus-tester', true),
        'review-worker': role('opus-reviewer', false),
        'security-worker': role('opus-reviewer', false),
        'debug-worker': role('opus-debugger', true),
      },
    },
    verification: {
      modes: {
        fast: { independent_review: { min_complexity: 11, risks: ['high'] } },
        balanced: { independent_review: { min_complexity: 5, risks: ['high'] } },
        thorough: { independent_review: { min_complexity: 3, risks: ['medium', 'high'] } },
        maximum: { independent_review: { min_complexity: 1, risks: ['low', 'medium', 'high'] } },
      },
    },
  };
}
const spec = (o) => Object.assign({ kind: 'implementation', complexity: 3, risk: 'low', assigned_model: 'auto', assigned_role: 'auto', security_sensitive: false }, o);
const obs = (model, complexity, attempts, n) =>
  Array.from({ length: n }, () => ({ category: 'worker_outcome', data: { model, complexity, attempts, first_pass: attempts === 1 } }));

test('band', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(R.band), ['1-2', '1-2', '3-4', '3-4', '5-6', '5-6', '7-8', '7-8', '9-10', '9-10']);
});

test('low complexity goes to haiku with a rule reason', () => {
  for (const c of [1, 2, 3, 4]) {
    const r = R.route(spec({ complexity: c }), cfg());
    assert.equal(r.model, 'haiku');
    assert.ok(r.reasons.some((s) => /default_floor/.test(s)));
  }
});

test('opus rules name the rule', () => {
  let r = R.route(spec({ complexity: 9, risk: 'high' }), cfg());
  assert.equal(r.model, 'opus');
  assert.ok(r.reasons.some((s) => /complexity_9_10/.test(s)));
  r = R.route(spec({ complexity: 10 }), cfg());
  assert.equal(r.model, 'opus');
  r = R.route(spec({ complexity: 3, risk: 'high', security_sensitive: true }), cfg());
  assert.equal(r.model, 'opus');
  assert.ok(r.reasons.some((s) => /high_risk_sensitive/.test(s)));
  r = R.route(spec({ complexity: 2, complexity_factors: { architectural_impact: 3 } }), cfg());
  assert.equal(r.model, 'opus');
  assert.ok(r.reasons.some((s) => /architectural_impact_3/.test(s)));
});

test('explicit assigned_model is a floor', () => {
  const r = R.route(spec({ complexity: 1, assigned_model: 'sonnet' }), cfg());
  assert.notEqual(r.model, 'haiku');
  assert.ok(['sonnet', 'opus'].includes(r.model));
  assert.ok(r.candidates.every((c) => c.model !== 'haiku'));
  assert.equal(R.route(spec({ complexity: 1, assigned_model: 'opus' }), cfg()).model, 'opus');
  const c = cfg(); c.routing.adaptive = false;
  assert.equal(R.route(spec({ complexity: 1, assigned_model: 'sonnet' }), c).model, 'sonnet');
});

test('observed statistics override heuristics; fewer than min use heuristic', () => {
  const s = R.performanceStats([...obs('haiku', 5, 5, 5)]);
  const r = R.route(spec({ complexity: 5 }), cfg(), s);
  assert.equal(r.model, 'sonnet'); // haiku 1*5 = 5 > sonnet 3*1.3 = 3.9
  const h = r.candidates.find((c) => c.model === 'haiku');
  assert.equal(h.basis, 'observed');
  assert.equal(h.expected_attempts, 5);
  assert.equal(r.candidates.find((c) => c.model === 'sonnet').basis, 'heuristic');
  assert.equal(r.decision_basis, 'heuristic');

  const few = R.performanceStats(obs('haiku', 5, 5, 4));
  const r2 = R.route(spec({ complexity: 5 }), cfg(), few);
  assert.equal(r2.model, 'haiku');
  assert.equal(r2.decision_basis, 'heuristic');

  const good = R.performanceStats(obs('haiku', 5, 1, 5));
  const r3 = R.route(spec({ complexity: 5 }), cfg(), good);
  assert.equal(r3.model, 'haiku');
  assert.equal(r3.decision_basis, 'observed');
});

test('config switches change the outcome', () => {
  let c = cfg(); c.routing.prefer_haiku = false;
  assert.notEqual(R.route(spec({ complexity: 1 }), c).model, 'haiku');
  assert.ok(R.route(spec({ complexity: 1 }), c).reasons.some((s) => /prefer_haiku_false/.test(s)));

  const s = R.performanceStats(obs('haiku', 5, 8, 5).concat(obs('sonnet', 5, 5, 5)));
  assert.equal(R.route(spec({ complexity: 5 }), cfg(), s).model, 'opus');
  c = cfg(); c.routing.allow_opus_escalation = false;
  assert.equal(R.route(spec({ complexity: 5 }), c, R.performanceStats(obs('haiku', 5, 8, 5))).model, 'sonnet');
  // opus kept when it is the floor
  assert.equal(R.route(spec({ complexity: 10 }), c).model, 'opus');

  c = cfg(); c.routing.adaptive = false;
  const bad = R.performanceStats(obs('haiku', 5, 5, 5));
  assert.equal(R.route(spec({ complexity: 5 }), c, bad).model, 'haiku');
  assert.equal(R.route(spec({ complexity: 5 }), cfg(), bad).model, 'sonnet');
});

test('tier', () => {
  const t = [1, 3, 5, 7, 9].map((c) => R.route(spec({ complexity: c }), cfg()).tier);
  assert.deepEqual(t, ['direct', 'targeted', 'reviewed', 'oversight', 'opus_led']);
});

test('independent_review follows mode table', () => {
  const ir = (o, mode) => R.route(spec(o), cfg(), null, mode).independent_review;
  assert.equal(ir({ complexity: 5, risk: 'medium' }, 'fast'), false);
  // balanced min_complexity 5: complexity 5-6 work is reviewed, 4 is not
  assert.equal(ir({ complexity: 5, risk: 'medium' }, 'balanced'), true);
  assert.equal(ir({ complexity: 4, risk: 'medium' }, 'balanced'), false);
  // thorough min_complexity 3
  assert.equal(ir({ complexity: 3, risk: 'low' }, 'thorough'), true);
  assert.equal(ir({ complexity: 2, risk: 'low' }, 'thorough'), false);
  assert.equal(ir({ complexity: 2, risk: 'medium' }, 'thorough'), true);
  assert.equal(ir({ complexity: 1, risk: 'low' }, 'maximum'), true);
  assert.equal(ir({ complexity: 7, risk: 'low' }, 'balanced'), true);
  assert.equal(ir({ complexity: 3, risk: 'high' }, 'fast'), true);
  assert.equal(ir({ complexity: 1, risk: 'low', security_sensitive: true }, 'fast'), true);
  const c = cfg(); c.execution.independent_verification = false;
  assert.equal(R.route(spec({ complexity: 1, risk: 'low' }), c, null, 'maximum').independent_review, false);
});

test('verification layers', () => {
  let r = R.route(spec({ complexity: 3 }), cfg());
  assert.deepEqual(r.verification_layers, ['self_check', 'opus_gate', 'integration']);
  r = R.route(spec({ complexity: 8, risk: 'high', verification_commands: ['npm test'] }), cfg());
  assert.deepEqual(r.verification_layers, ['self_check', 'automated', 'independent_review', 'opus_gate', 'integration']);
});

test('roleFor and agent type', () => {
  const expect = {
    implementation: ['implementation-worker', 'opus-implementer'], research: ['research-worker', 'opus-researcher'],
    test: ['test-worker', 'opus-tester'], verification: ['verification-worker', 'opus-tester'],
    review: ['review-worker', 'opus-reviewer'], debug: ['debug-worker', 'opus-debugger'],
    documentation: ['documentation-worker', 'opus-implementer'], integration: ['integration-worker', 'opus-implementer'],
    security: ['security-worker', 'opus-reviewer'], repository: ['repository-worker', 'opus-researcher'],
  };
  for (const [kind, [role, agent]] of Object.entries(expect)) {
    assert.equal(R.roleFor({ kind, assigned_role: 'auto' }, cfg()), role);
    const r = R.route(spec({ kind }), cfg());
    assert.equal(r.role, role);
    assert.equal(r.agent, agent);
  }
  assert.equal(R.roleFor({ kind: 'research', assigned_role: 'debug-worker' }, cfg()), 'debug-worker');
});

test('escalation actions', () => {
  const c = cfg();
  const t = (o) => Object.assign({ attempts: 1, retries: 0, routing: { model: 'haiku' } }, o);
  assert.equal(R.escalation(t(), c, { failure_kind: 'needs_decomposition' }).action, 'decompose');
  assert.equal(R.escalation(t(), c, { failure_kind: 'permission' }).action, 'ask_user');
  assert.equal(R.escalation(t(), c, { failure_kind: 'budget' }).action, 'ask_user');
  for (const k of ['rate_limit', 'timeout', 'crash']) assert.equal(R.escalation(t(), c, { failure_kind: k }).action, 'retry_same');
  assert.equal(R.escalation(t({ retries: 2 }), c, { failure_kind: 'crash' }).action, 'targeted_correction');
  assert.equal(R.escalation(t(), c, { failure_kind: 'wrong_output' }).action, 'targeted_correction');
  const e = R.escalation(t({ attempts: 2 }), c, { failure_kind: 'wrong_output' });
  assert.equal(e.action, 'escalate_model');
  assert.equal(e.model, 'opus');
  assert.equal(R.escalation(t({ attempts: 2, routing: { model: 'opus' } }), c, { failure_kind: 'wrong_output' }).action, 'ask_user');
  const off = cfg(); off.routing.allow_opus_escalation = false;
  assert.equal(R.escalation(t({ attempts: 3 }), off, { failure_kind: 'wrong_output' }).action, 'ask_user');
  for (const attempts of [2, 3, 5]) for (const k of ['rate_limit', 'timeout', 'crash', 'wrong_output', 'x']) for (const m of ['haiku', 'sonnet', 'opus']) {
    const a = R.escalation(t({ attempts, routing: { model: m } }), c, { failure_kind: k }).action;
    assert.ok(a !== 'retry_same' && a !== 'targeted_correction');
  }
});

test('performanceStats', () => {
  const s = R.performanceStats([
    ...obs('haiku', 5, 1, 1), ...obs('haiku', 6, 3, 1), { category: 'other', data: { model: 'haiku', complexity: 5, attempts: 9 } },
    ...obs('opus', 9, 2, 2),
  ]);
  assert.deepEqual(s.haiku['5-6'], { tasks: 2, first_pass: 1, attempts_total: 4, mean_attempts: 2 });
  assert.deepEqual(s.opus['9-10'], { tasks: 2, first_pass: 0, attempts_total: 4, mean_attempts: 2 });
  assert.deepEqual(R.performanceStats([]), {});
});

test('route is pure and prints no price or probability', () => {
  const c = cfg(); const sp = spec({ complexity: 6 });
  const before = JSON.stringify([c, sp]);
  const r = R.route(sp, c);
  assert.equal(JSON.stringify([c, sp]), before);
  assert.ok(!/\$|usd|probabilit|%/i.test(r.reasons.join(' ')));
});
