'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parse } = require('../scripts/lib/yaml.cjs');
const { DEFAULTS, loadConfig, validateConfig, effectiveLimits, contextTarget } = require('../scripts/lib/config.cjs');

const SKILL = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(SKILL, 'config');
const FILES = ['execution', 'models', 'routing', 'budgets', 'verification', 'compaction'];
const ROLES = {
  'research-worker': ['opus-researcher', false], 'repository-worker': ['opus-researcher', false],
  'implementation-worker': ['opus-implementer', true], 'documentation-worker': ['opus-implementer', true],
  'integration-worker': ['opus-implementer', true], 'test-worker': ['opus-tester', true],
  'verification-worker': ['opus-tester', true], 'review-worker': ['opus-reviewer', false],
  'security-worker': ['opus-reviewer', false], 'debug-worker': ['opus-debugger', true],
};

const clone = (v) => JSON.parse(JSON.stringify(v));
function good() { return loadConfig({ skillDir: SKILL }); }
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'oo-config-')); }

test('shipped files merge to DEFAULTS except routing.roles', () => {
  const merged = {};
  for (const f of FILES) {
    const doc = parse(fs.readFileSync(path.join(CONFIG_DIR, f + '.yaml'), 'utf8'));
    Object.assign(merged, doc);
  }
  const roles = merged.routing.roles;
  delete merged.routing.roles;
  const expected = clone(DEFAULTS);
  delete expected.routing.roles;
  assert.deepEqual(merged, expected);
  assert.deepEqual(Object.keys(roles).sort(), Object.keys(ROLES).sort());
  for (const [name, [agent, writes]] of Object.entries(ROLES)) {
    assert.equal(roles[name].agent, agent);
    assert.equal(roles[name].writes, writes);
    assert.ok(typeof roles[name].brief === 'string' && roles[name].brief.length > 20);
  }
});

test('independent-review thresholds: balanced 5 and thorough 3 in DEFAULTS and verification.yaml, risks unchanged', () => {
  const file = parse(fs.readFileSync(path.join(CONFIG_DIR, 'verification.yaml'), 'utf8')).verification.modes;
  for (const modes of [DEFAULTS.verification.modes, file]) {
    assert.deepEqual(modes.fast.independent_review, { min_complexity: 11, risks: ['high'] });
    assert.deepEqual(modes.balanced.independent_review, { min_complexity: 5, risks: ['high'] });
    assert.deepEqual(modes.thorough.independent_review, { min_complexity: 3, risks: ['medium', 'high'] });
    assert.deepEqual(modes.maximum.independent_review, { min_complexity: 1, risks: ['low', 'medium', 'high'] });
  }
});

test('config files document required statements', () => {
  const read = (f) => fs.readFileSync(path.join(CONFIG_DIR, f + '.yaml'), 'utf8');
  assert.match(read('models'), /unitless planning weights/);
  assert.match(read('models'), /NOT prices/);
  assert.match(read('models'), /haiku, sonnet and opus/);
  assert.match(read('routing'), /heuristics/);
  assert.match(read('routing'), /replaced by observed data/);
  assert.match(read('budgets'), /null limit means no limit/);
  for (const f of FILES) assert.match(read(f), /^#/m);
});

test('shipped configuration validates', () => {
  const r = validateConfig(good());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.ok, true);
});

test('loadConfig merges defaults < skill < state < overrides, arrays replace', () => {
  const d = tmpDir();
  try {
    const sf = path.join(d, 'config.yaml');
    fs.writeFileSync(sf, 'execution:\n  max_workers: 7\n  max_retries: 4\nsecurity:\n  extra_unsafe_patterns: [foo]\n');
    const c = loadConfig({ skillDir: SKILL, stateConfigFile: sf, overrides: { execution: { max_workers: 9 } } });
    assert.equal(c.execution.max_workers, 9);
    assert.equal(c.execution.max_retries, 4);
    assert.equal(c.execution.mode, 'balanced');
    assert.deepEqual(c.security.extra_unsafe_patterns, ['foo']);
    fs.writeFileSync(sf, 'models:\n  allowed: [opus]\n');
    assert.deepEqual(loadConfig({ skillDir: SKILL, stateConfigFile: sf }).models.allowed, ['opus']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('loadConfig ignores a missing state config and works without skillDir', () => {
  const c = loadConfig({ stateConfigFile: path.join(os.tmpdir(), 'oo-does-not-exist.yaml') });
  assert.equal(c.execution.mode, 'balanced');
  assert.equal(Object.keys(c.routing.roles).length, 10);
});

test('loadConfig skill files override defaults', () => {
  const d = tmpDir();
  try {
    fs.mkdirSync(path.join(d, 'config'));
    fs.writeFileSync(path.join(d, 'config', 'x.yaml'), 'execution:\n  max_workers: 2\n');
    assert.equal(loadConfig({ skillDir: d }).execution.max_workers, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

function expectError(mutate, pattern) {
  const c = good();
  mutate(c);
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => pattern.test(e)), `no error matching ${pattern}: ${r.errors.join('; ')}`);
}

test('invalid mode', () => expectError((c) => { c.execution.mode = 'turbo'; }, /execution\.mode/));
test('max_workers out of range', () => {
  expectError((c) => { c.execution.max_workers = 0; }, /max_workers/);
  expectError((c) => { c.execution.max_workers = 21; }, /max_workers/);
  expectError((c) => { c.execution.max_workers = 2.5; }, /max_workers/);
});
test('max_review_rounds out of range', () => expectError((c) => { c.execution.max_review_rounds = 11; }, /max_review_rounds/));
test('max_retries out of range', () => expectError((c) => { c.execution.max_retries = -1; }, /max_retries/));
test('invented model name opus-5.5-extra rejected', () => {
  expectError((c) => { c.models.orchestrator = 'opus-5.5-extra'; }, /models\.orchestrator/);
  expectError((c) => { c.models.worker_default = 'Haiku 5.5'; }, /models\.worker_default/);
  expectError((c) => { c.models.escalation = 'claude-opus-9'; }, /models\.escalation/);
  expectError((c) => { c.models.allowed.push('opus-5.5-extra'); }, /models\.allowed/);
  expectError((c) => { c.models.relative_cost['opus-5.5-extra'] = 9; }, /relative_cost/);
});
test('relative_cost must be > 0', () => expectError((c) => { c.models.relative_cost.haiku = 0; }, /relative_cost\.haiku/));
test('budget limits null or > 0', () => {
  expectError((c) => { c.budget.token_limit = 0; }, /token_limit/);
  expectError((c) => { c.budget.cost_limit_usd = -1; }, /cost_limit_usd/);
  expectError((c) => { c.budget.agent_call_limit = 'many'; }, /agent_call_limit/);
  const c = good();
  c.budget.token_limit = 1000;
  assert.equal(validateConfig(c).ok, true);
});
test('warning_threshold_percent 1-100', () => {
  expectError((c) => { c.budget.warning_threshold_percent = 0; }, /warning_threshold_percent/);
  expectError((c) => { c.budget.warning_threshold_percent = 101; }, /warning_threshold_percent/);
});
test('target_utilization in (0,1)', () => {
  expectError((c) => { c.context.target_utilization = 0; }, /target_utilization/);
  expectError((c) => { c.context.target_utilization = 1; }, /target_utilization/);
});
test('auto_modify_core_skill true is an error', () => expectError((c) => { c.improvement.auto_modify_core_skill = true; }, /auto_modify_core_skill/));
test('role entries need agent and boolean writes', () => {
  expectError((c) => { delete c.routing.roles['test-worker'].agent; }, /test-worker\.agent/);
  expectError((c) => { c.routing.roles['test-worker'].writes = 'yes'; }, /test-worker\.writes/);
});
test('unknown top-level section is a warning', () => {
  const c = good();
  c.mystery = { a: 1 };
  const r = validateConfig(c);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /mystery/.test(w)));
});

test('effectiveLimits caps fast mode at 3 and leaves others', () => {
  const c = good();
  c.execution.max_workers = 8;
  c.execution.mode = 'fast';
  assert.equal(effectiveLimits(c).max_workers, 3);
  c.execution.max_workers = 2;
  assert.equal(effectiveLimits(c).max_workers, 2);
  for (const m of ['balanced', 'thorough', 'maximum']) {
    c.execution.mode = m;
    c.execution.max_workers = 8;
    assert.deepEqual(effectiveLimits(c), { max_workers: 8, max_review_rounds: 3, max_retries: 2, mode: m });
  }
});

test('contextTarget by mode', () => {
  const c = good();
  c.context.mode = 'aggressive';
  assert.equal(contextTarget(c), 0.40);
  c.context.mode = 'balanced';
  c.context.target_utilization = 0.5;
  assert.equal(contextTarget(c), 0.60);
  c.context.mode = 'custom';
  assert.equal(contextTarget(c), 0.5);
});

test('validate_config.cli: OK for shipped config, exit 1 for invalid override', () => {
  const script = path.join(SKILL, 'scripts', 'validate_config.cjs');
  const ok = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /CONFIG OK/);
  const d = tmpDir();
  try {
    const f = path.join(d, 'bad.yaml');
    fs.writeFileSync(f, 'models:\n  orchestrator: opus-5.5-extra\nimprovement:\n  auto_modify_core_skill: true\n');
    const bad = spawnSync(process.execPath, [script, '--state-config', f], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /models\.orchestrator/);
    assert.match(bad.stdout, /auto_modify_core_skill/);
    assert.doesNotMatch(bad.stdout, /CONFIG OK/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
