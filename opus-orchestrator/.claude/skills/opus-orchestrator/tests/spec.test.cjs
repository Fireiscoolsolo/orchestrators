'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const spec = require('../scripts/lib/spec.cjs');

const NOW = '2026-11-15T03:41:02.000Z';

function base(extra = {}) {
  return {
    task_id: 'AUTH-001',
    title: 'Implement refresh-token handling',
    objective: 'Refresh tokens are rotated on use.',
    complexity: 3,
    authorized_files: ['src/auth/', 'tests/auth/'],
    acceptance_criteria: ['expired refresh tokens are rejected'],
    ...extra,
  };
}

function without(key, extra = {}) {
  const raw = base(extra);
  delete raw[key];
  return raw;
}

function assertError(raw, re, opts) {
  const r = spec.validateSpec(raw, opts);
  assert.equal(r.ok, false, `expected an error matching ${re}`);
  assert.equal(r.spec, null);
  assert.ok(r.errors.some((e) => re.test(e)), `no error matches ${re}: ${JSON.stringify(r.errors)}`);
  return r;
}

// ---------------------------------------------------------------------------
// FACTORS and scoreComplexity
// ---------------------------------------------------------------------------

const ALL = (v) => Object.fromEntries(spec.FACTORS.map((f) => [f, v]));

test('FACTORS lists the eight factor names of DESIGN.md 3.1', () => {
  assert.deepEqual([...spec.FACTORS], [
    'technical_difficulty', 'components', 'architectural_impact', 'ambiguity',
    'security_sensitivity', 'dependency_complexity', 'regression_risk', 'debugging_difficulty',
  ]);
});

test('scoreComplexity: all zeros is 1, all threes is 10', () => {
  assert.equal(spec.scoreComplexity(ALL(0)), 1);
  assert.equal(spec.scoreComplexity(ALL(3)), 10);
});

test('scoreComplexity follows clamp(1, 10, round(1 + 9 * sum / 24)) for every sum', () => {
  for (let sum = 0; sum <= 24; sum++) {
    const factors = ALL(0);
    let left = sum;
    for (const f of spec.FACTORS) {
      const v = Math.min(3, left);
      factors[f] = v;
      left -= v;
    }
    const expected = Math.min(10, Math.max(1, Math.round(1 + (9 * sum) / 24)));
    assert.equal(spec.scoreComplexity(factors), expected, `sum ${sum}`);
  }
  // the example of DESIGN.md 3.1 (sum 12)
  assert.equal(spec.scoreComplexity({ technical_difficulty: 2, components: 2, architectural_impact: 1, ambiguity: 1, security_sensitivity: 2, dependency_complexity: 1, regression_risk: 2, debugging_difficulty: 1 }), 6);
});

test('scoreComplexity throws on unknown factor names', () => {
  assert.throws(() => spec.scoreComplexity({ ...ALL(1), cleverness: 2 }), (e) => e instanceof Error && e.code === 'BAD_FACTOR');
  assert.throws(() => spec.scoreComplexity({ difficulty: 1 }), (e) => e.code === 'BAD_FACTOR');
});

test('scoreComplexity throws on values outside 0 to 3', () => {
  for (const bad of [-1, 4, 1.5, '2', null, NaN]) {
    assert.throws(() => spec.scoreComplexity({ ...ALL(1), ambiguity: bad }), (e) => e instanceof Error && e.code === 'BAD_FACTOR_VALUE', String(bad));
  }
});

test('scoreComplexity throws when factors is not a mapping', () => {
  assert.throws(() => spec.scoreComplexity(null), (e) => e.code === 'BAD_FACTOR');
  assert.throws(() => spec.scoreComplexity([1, 2]), (e) => e.code === 'BAD_FACTOR');
});

// ---------------------------------------------------------------------------
// validateSpec: normalization
// ---------------------------------------------------------------------------

test('validateSpec normalizes the documented defaults', () => {
  const r = spec.validateSpec(base());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.spec, {
    task_id: 'AUTH-001',
    title: 'Implement refresh-token handling',
    objective: 'Refresh tokens are rotated on use.',
    kind: 'implementation',
    priority: 'medium',
    complexity: 3,
    complexity_factors: null,
    risk: 'low',
    dependencies: [],
    assigned_model: 'auto',
    assigned_role: 'auto',
    authorized_files: ['src/auth/', 'tests/auth/'],
    acceptance_criteria: ['expired refresh tokens are rejected'],
    deliverables: [],
    verification: [],
    verification_commands: [],
    context: '',
    constraints: [],
    tool_permissions: [],
    security_sensitive: false,
    side_effects: 'none',
    exclusive: false,
  });
});

test('validateSpec keeps explicit values', () => {
  const r = spec.validateSpec(base({
    kind: 'test', priority: 'critical', risk: 'high', dependencies: ['AUTH-000'], assigned_model: 'sonnet',
    assigned_role: 'test-worker', verification_commands: ['npm test'], side_effects: 'local', exclusive: true,
    context: 'see docs/auth.md', deliverables: ['tests/auth/refresh.test.js'],
  }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.spec.kind, 'test');
  assert.equal(r.spec.priority, 'critical');
  assert.equal(r.spec.risk, 'high');
  assert.deepEqual(r.spec.dependencies, ['AUTH-000']);
  assert.equal(r.spec.assigned_model, 'sonnet');
  assert.equal(r.spec.assigned_role, 'test-worker');
  assert.deepEqual(r.spec.verification_commands, ['npm test']);
  assert.equal(r.spec.side_effects, 'local');
  assert.equal(r.spec.exclusive, true);
  assert.equal(r.spec.context, 'see docs/auth.md');
});

test('validateSpec applies the default risk rule of DESIGN.md 3.1', () => {
  const risk = (extra) => spec.validateSpec(base(extra)).spec.risk;
  assert.equal(risk({ complexity: 1 }), 'low');
  assert.equal(risk({ complexity: 4 }), 'low');
  assert.equal(risk({ complexity: 5 }), 'medium');
  assert.equal(risk({ complexity: 7 }), 'medium');
  assert.equal(risk({ complexity: 8 }), 'high');
  assert.equal(risk({ complexity: 10 }), 'high');
  assert.equal(risk({ complexity: 2, security_sensitive: true }), 'high');
});

test('validateSpec computes complexity from complexity_factors', () => {
  const raw = without('complexity', { complexity_factors: { technical_difficulty: 2, components: 2, architectural_impact: 2, ambiguity: 2, security_sensitivity: 2, dependency_complexity: 2, regression_risk: 2, debugging_difficulty: 2 } });
  const r = spec.validateSpec(raw);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.spec.complexity, 7); // round(1 + 9 * 16 / 24)
  assert.equal(r.spec.risk, 'medium');
  // missing factors are filled with 0 in the normalized spec
  const partial = spec.validateSpec(without('complexity', { complexity_factors: { components: 3 } }));
  assert.equal(partial.ok, true);
  assert.equal(partial.spec.complexity, 2);
  assert.deepEqual(Object.keys(partial.spec.complexity_factors), [...spec.FACTORS]);
  assert.equal(partial.spec.complexity_factors.ambiguity, 0);
});

test('validateSpec normalizes authorized file paths', () => {
  const r = spec.validateSpec(base({ authorized_files: ['./src\\auth\\', 'tests/auth/a.test.js'] }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.spec.authorized_files, ['src/auth/', 'tests/auth/a.test.js']);
});

test('validateSpec allows an empty authorized_files for non-writing kinds', () => {
  for (const kind of ['research', 'review', 'security', 'repository']) {
    const r = spec.validateSpec(base({ kind, authorized_files: [] }));
    assert.equal(r.ok, true, `${kind}: ${JSON.stringify(r.errors)}`);
  }
  const role = spec.validateSpec(base({ assigned_role: 'review-worker', authorized_files: [] }));
  assert.equal(role.ok, true, JSON.stringify(role.errors));
});

test('validateSpec does not mutate its input', () => {
  const raw = base({ authorized_files: ['./src/'] });
  const copy = structuredClone(raw);
  spec.validateSpec(raw);
  assert.deepEqual(raw, copy);
});

// ---------------------------------------------------------------------------
// validateSpec: one test per invalid case of DESIGN.md 4.5
// ---------------------------------------------------------------------------

test('validateSpec error: bad task id', () => {
  for (const id of ['auth-001', 'AUTH-01', 'AUTH-0001', 'AUTH001', '1AUTH-001', 'AUTH_001', '', undefined, 7]) {
    const raw = id === undefined ? without('task_id') : base({ task_id: id });
    assertError(raw, /task_id/);
  }
});

test('validateSpec error: missing title', () => {
  assertError(without('title'), /title/);
  assertError(base({ title: '   ' }), /title/);
});

test('validateSpec error: missing objective', () => {
  assertError(without('objective'), /objective/);
  assertError(base({ objective: '' }), /objective/);
});

test('validateSpec error: missing or empty acceptance_criteria', () => {
  assertError(without('acceptance_criteria'), /acceptance_criteria/);
  assertError(base({ acceptance_criteria: [] }), /acceptance_criteria/);
  assertError(base({ acceptance_criteria: 'one string' }), /acceptance_criteria/);
});

test('validateSpec error: unknown kind', () => {
  assertError(base({ kind: 'refactor' }), /kind/);
});

test('validateSpec error: unknown priority', () => {
  assertError(base({ priority: 'urgent' }), /priority/);
});

test('validateSpec error: unknown risk', () => {
  assertError(base({ risk: 'extreme' }), /risk/);
});

test('validateSpec error: unknown side_effects', () => {
  assertError(base({ side_effects: 'remote' }), /side_effects/);
});

test('validateSpec error: unknown assigned_model (no invented model names)', () => {
  assertError(base({ assigned_model: 'opus-5.5-extra' }), /assigned_model/);
  assertError(base({ assigned_model: 'gpt-5' }), /assigned_model/);
  // a model outside the configured allow-list
  assertError(base({ assigned_model: 'opus' }), /assigned_model/, { config: { models: { allowed: ['haiku', 'sonnet'] } } });
});

test('validateSpec error: unknown assigned_role', () => {
  assertError(base({ assigned_role: 'wizard-worker' }), /assigned_role/);
});

test('validateSpec error: complexity out of range', () => {
  for (const c of [0, 11, -3, 2.5, '5']) assertError(base({ complexity: c }), /complexity/);
});

test('validateSpec error: neither complexity nor complexity_factors given', () => {
  assertError(without('complexity'), /complexity/);
});

test('validateSpec error: invalid complexity_factors', () => {
  assertError(without('complexity', { complexity_factors: { cleverness: 2 } }), /unknown complexity factor/);
  assertError(without('complexity', { complexity_factors: { ambiguity: 4 } }), /ambiguity/);
});

test('validateSpec error: empty authorized_files for a writing kind or role', () => {
  for (const kind of ['implementation', 'test', 'debug', 'documentation', 'integration', 'verification']) {
    assertError(base({ kind, authorized_files: [] }), /authorized_files/);
  }
  assertError(without('authorized_files'), /authorized_files/);
  assertError(base({ kind: 'research', assigned_role: 'implementation-worker', authorized_files: [] }), /authorized_files/);
});

test('validateSpec error: unsafe verification command', () => {
  assertError(base({ verification_commands: ['npm test', 'git push origin main'] }), /unsafe verification command/);
  assertError(base({ verification_commands: ['npm test && rm -rf /'] }), /unsafe verification command/);
  // config extra_unsafe_patterns are applied as well
  assertError(base({ verification_commands: ['make deploy'] }), /unsafe verification command/, { config: { security: { extra_unsafe_patterns: ['make\\s+deploy'] } } });
});

test('validateSpec error: authorized file matching a protected path without security_sensitive', () => {
  assertError(base({ authorized_files: ['src/auth/', '.env'] }), /protected path/);
  assertError(base({ authorized_files: ['certs/server.pem'] }), /protected path/);
  assertError(base({ authorized_files: ['config/secrets/'] }), /protected path/);
  // configured protected paths replace the defaults
  assertError(base({ authorized_files: ['deploy/prod.yaml'] }), /protected path/, { config: { security: { protected_paths: ['deploy/'] } } });
  // allowed (with a warning) when the task is security_sensitive
  const ok = spec.validateSpec(base({ authorized_files: ['.env'], security_sensitive: true }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.ok(ok.warnings.some((w) => /protected path/.test(w)));
  assert.equal(ok.spec.risk, 'high');
});

test('validateSpec error: dependency on itself', () => {
  assertError(base({ dependencies: ['AUTH-001'] }), /depends on itself/);
});

test('validateSpec error: authorized file with path traversal or absolute path', () => {
  assertError(base({ authorized_files: ['src/../secrets.txt'] }), /traversal/);
  assertError(base({ authorized_files: ['/etc/'] }), /relative/);
});

test('validateSpec error: input that is not a mapping', () => {
  for (const raw of [null, 'text', [1, 2]]) {
    const r = spec.validateSpec(raw);
    assert.equal(r.ok, false);
    assert.equal(r.spec, null);
    assert.ok(r.errors.length > 0);
  }
});

test('validateSpec warns about unknown fields', () => {
  const r = spec.validateSpec(base({ colour: 'blue' }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /colour/.test(w)));
});

// ---------------------------------------------------------------------------
// validatePlan
// ---------------------------------------------------------------------------

function task(id, files, deps = []) {
  return { task_id: id, authorized_files: files, dependencies: deps };
}

test('validatePlan accepts a valid plan', () => {
  const r = spec.validatePlan([task('A-001', ['src/a/']), task('B-001', ['src/b/'], ['A-001'])]);
  assert.deepEqual(r, { ok: true, errors: [], warnings: [] });
});

test('validatePlan reports duplicate ids', () => {
  const r = spec.validatePlan([task('A-001', ['a/']), task('A-001', ['b/'])]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /duplicate/.test(e) && /A-001/.test(e)), JSON.stringify(r.errors));
});

test('validatePlan reports unknown dependencies', () => {
  const r = spec.validatePlan([task('A-001', ['a/'], ['Z-999'])]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown/.test(e) && /Z-999/.test(e)), JSON.stringify(r.errors));
});

test('validatePlan reports cycles', () => {
  const two = spec.validatePlan([task('A-001', ['a/'], ['B-001']), task('B-001', ['b/'], ['A-001'])]);
  assert.equal(two.ok, false);
  assert.equal(two.errors.filter((e) => /cycle/.test(e)).length, 1, JSON.stringify(two.errors));

  const three = spec.validatePlan([
    task('A-001', ['a/'], ['C-001']),
    task('B-001', ['b/'], ['A-001']),
    task('C-001', ['c/'], ['B-001']),
    task('D-001', ['d/'], ['A-001']),
  ]);
  assert.equal(three.ok, false);
  const cycles = three.errors.filter((e) => /cycle/.test(e));
  assert.equal(cycles.length, 1, JSON.stringify(three.errors));
  for (const id of ['A-001', 'B-001', 'C-001']) assert.match(cycles[0], new RegExp(id));
  assert.doesNotMatch(cycles[0], /D-001/);
});

test('validatePlan warns about overlapping scopes with no dependency path', () => {
  const r = spec.validatePlan([task('A-001', ['src/']), task('B-001', ['src/lib/x.js'])]);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /A-001/);
  assert.match(r.warnings[0], /B-001/);
});

test('validatePlan does not warn when a dependency path exists or scopes are disjoint', () => {
  const direct = spec.validatePlan([task('A-001', ['src/']), task('B-001', ['src/x.js'], ['A-001'])]);
  assert.deepEqual(direct.warnings, []);
  const transitive = spec.validatePlan([
    task('A-001', ['src/']),
    task('B-001', ['docs/'], ['A-001']),
    task('C-001', ['src/*.js'], ['B-001']),
  ]);
  assert.deepEqual(transitive.warnings, []);
  const disjoint = spec.validatePlan([task('A-001', ['src/']), task('B-001', ['tests/'])]);
  assert.deepEqual(disjoint.warnings, []);
  const empty = spec.validatePlan([task('A-001', []), task('B-001', ['src/'])]);
  assert.deepEqual(empty.warnings, []);
});

test('validatePlan rejects input that is not a list', () => {
  assert.equal(spec.validatePlan(null).ok, false);
  assert.equal(spec.validatePlan([{ title: 'no id' }]).ok, false);
});

// ---------------------------------------------------------------------------
// newTaskRecord
// ---------------------------------------------------------------------------

test('newTaskRecord returns a PENDING record with every extra field of DESIGN.md 3.2', () => {
  const s = spec.validateSpec(base()).spec;
  const routing = { role: 'implementation-worker', agent: 'opus-implementer', model: 'haiku', tier: 'worker', independent_review: false, verification_layers: ['commands'], reasons: ['complexity 3'], decision_basis: 'heuristic', candidates: [] };
  const t = spec.newTaskRecord(s, routing, NOW);
  assert.equal(t.status, 'PENDING');
  assert.equal(t.review_round, 0);
  assert.equal(t.attempts, 0);
  assert.equal(t.retries, 0);
  assert.equal(t.spec_revision, 1);
  assert.deepEqual(t.routing, routing);
  assert.notEqual(t.routing, routing); // a copy
  assert.ok(Array.isArray(t.history));
  for (const h of t.history) assert.deepEqual(Object.keys(h).sort(), ['actor', 'from', 'reason', 'to', 'ts']);
  assert.ok(t.history.every((h) => h.ts === NOW));
  assert.deepEqual(t.evidence, { self_check: null, verification: null, reviews: [], integration: null });
  assert.equal(t.result, null);
  assert.equal(t.correction, null);
  assert.deepEqual(t.corrections, []);
  assert.equal(t.failure, null);
  assert.equal(t.block, null);
  // the normalized spec fields are carried over
  for (const [k, v] of Object.entries(s)) assert.deepEqual(t[k], v, k);
});

test('newTaskRecord does not mutate the spec and requires now', () => {
  const s = spec.validateSpec(base()).spec;
  const copy = structuredClone(s);
  const t = spec.newTaskRecord(s, null, NOW);
  t.authorized_files.push('other/');
  assert.deepEqual(s, copy);
  assert.equal(t.routing, null);
  assert.throws(() => spec.newTaskRecord(s, null), (e) => e.code === 'NOW_REQUIRED');
  assert.throws(() => spec.newTaskRecord(null, null, NOW), (e) => e.code === 'BAD_SPEC');
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

test('spec.cjs is pure: no I/O, clock, randomness or process access', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'spec.cjs'), 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['./security.cjs']);
  assert.doesNotMatch(src, /Date\.now|new Date\(|Math\.random|process\.|console\./);
  // same input, same output
  assert.deepEqual(spec.validateSpec(base()), spec.validateSpec(base()));
  const s = spec.validateSpec(base()).spec;
  assert.deepEqual(spec.newTaskRecord(s, null, NOW), spec.newTaskRecord(s, null, NOW));
});
