'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigError, readConfig, deepMerge } = require('../config.cjs');

const defaults = path.resolve(__dirname, '../../config.default.yaml');

function configFiles(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const override = path.join(dir, 'config.yaml');
  return {
    directory: dir,
    override,
    withText(text) {
      fs.writeFileSync(override, text);
      return readConfig(defaults, override);
    },
  };
}

test('config validates its defaults and permits absent and comment-only overrides', (t) => {
  const files = configFiles(t);
  const defaultConfig = readConfig(defaults);
  assert.equal(defaultConfig.execution.mode, 'balanced');
  assert.deepEqual(readConfig(defaults, files.override), defaultConfig);
  assert.deepEqual(files.withText('\uFEFF# no overrides\r\n'), defaultConfig);
  assert.throws(() => readConfig(files.override), { name: 'ConfigError', message: /default configuration: configuration must be a mapping/ });
  assert.throws(() => readConfig(defaults, files.directory), { name: 'ConfigError', message: /project configuration: could not read/ });
});

test('config merges known YAML and JSON overrides without losing sibling defaults', (t) => {
  const files = configFiles(t);
  const actual = files.withText([
    'execution:',
    '  max_workers: 20',
    '  max_review_rounds: 0',
    'budget: {token_limit: 0, agent_call_limit: 0, warn_at_percent: 25.5}',
    'routing:',
    '  tiers:',
    '    light: {model: sonnet, effort: null}',
    '  cost_weights: {sonnet: 2.5}',
    'integration:',
    '  setup_command: npm ci',
    '  regression_command: |',
    '    npm test',
    '    npm run check',
    'isolation: {strategy: managed}',
    'learning: {enabled: false}',
  ].join('\n'));
  assert.deepEqual(actual.execution, { mode: 'balanced', max_workers: 20, max_review_rounds: 0, max_task_retries: 2 });
  assert.equal(actual.budget.token_limit, 0);
  assert.equal(actual.budget.agent_call_limit, 0);
  assert.equal(actual.budget.warn_at_percent, 25.5);
  assert.deepEqual(actual.routing.tiers.light, { model: 'sonnet', effort: null });
  assert.deepEqual(actual.routing.tiers.lead, { model: 'opus', effort: 'high' });
  assert.equal(actual.routing.cost_weights.sonnet, 2.5);
  assert.equal(actual.routing.cost_weights.opus, 4);
  assert.equal(actual.integration.setup_command, 'npm ci');
  assert.equal(actual.integration.regression_command, 'npm test\nnpm run check');
  assert.equal(actual.learning.enabled, false);
  assert.equal(actual.isolation.strategy, 'managed');
  assert.equal(files.withText('{"execution":{"mode":"fast"}}').execution.mode, 'fast');
});

test('config rejects bad mappings, unknown keys, and default files with missing required fields', (t) => {
  const files = configFiles(t);
  const malformed = [
    ['null', /configuration must be a mapping/],
    ['[true]', /configuration must be a mapping/],
    ['budget: null', /budget must be a mapping/],
    ['routing: {tiers: {lead: []}}', /routing\.tiers\.lead must be a mapping/],
    ['integration:\n  delvier: true', /unknown field "delvier" in integration/],
    ['arbitrary: unknown', /unknown field "arbitrary"/],
  ];
  for (const [text, message] of malformed) assert.throws(() => files.withText(text), { name: 'ConfigError', message });
  fs.writeFileSync(files.override, 'execution: {mode: balanced}');
  assert.throws(() => readConfig(files.override), /default configuration: missing required field execution\.max_workers/);
  fs.writeFileSync(files.override, '');
  assert.throws(() => readConfig(files.override), /default configuration: configuration must be a mapping/);
});

test('config validates booleans, enums, ranges, and commands in every section', (t) => {
  const files = configFiles(t);
  const invalid = [
    ['execution: {mode: toString}', /execution\.mode must be/],
    ['execution: {max_workers: 0}', /execution\.max_workers must be/],
    ['execution: {max_review_rounds: 11}', /execution\.max_review_rounds must be/],
    ['execution: {max_task_retries: -1}', /execution\.max_task_retries must be/],
    ['budget: {enabled: "false"}', /budget\.enabled must be/],
    ['budget: {token_limit: 2.5}', /budget\.token_limit must be/],
    ['budget: {cost_limit_usd: -1}', /budget\.cost_limit_usd must be/],
    ['budget: {agent_call_limit: -1}', /budget\.agent_call_limit must be/],
    ['budget: {warn_at_percent: 101}', /budget\.warn_at_percent must be/],
    ['routing: {adaptive: null}', /routing\.adaptive must be/],
    ['routing: {prefer_lower_cost_models: 1}', /routing\.prefer_lower_cost_models must be/],
    ['routing: {allow_escalation: yes}', /routing\.allow_escalation must be/],
    ['routing: {min_samples: 0}', /routing\.min_samples must be/],
    ['routing: {min_first_pass_rate: 1.1}', /routing\.min_first_pass_rate must be/],
    ['routing: {tiers: {light: {model: toString}}}', /routing\.tiers\.light\.model must be/],
    ['routing: {tiers: {light: {effort: wrong}}}', /routing\.tiers\.light\.effort must be/],
    ['routing: {cost_weights: {fable: -1}}', /routing\.cost_weights\.fable must be/],
    ['{"routing":{"cost_weights":{"fable":1e309}}}', /routing\.cost_weights\.fable must be/],
    ['isolation: {strategy: default}', /isolation\.strategy must be/],
    ['integration: {auto_deliver: 1}', /integration\.auto_deliver must be/],
    ['integration: {setup_command: " "}', /integration\.setup_command must be/],
    [JSON.stringify({ integration: { regression_command: 'npm\0test' } }), /integration\.regression_command must be/],
    ['verification: {command_timeout_seconds: 2147484}', /verification\.command_timeout_seconds must be/],
    ['learning: {enabled: true-ish}', /learning\.enabled must be/],
  ];
  for (const [text, message] of invalid) assert.throws(() => files.withText(text), { name: 'ConfigError', message });
});

test('config rejects reserved prototype keys and reports parse errors without the offending line content', (t) => {
  const files = configFiles(t);
  assert.throws(() => files.withText('{"routing":{"__proto__":{"polluted":true}}}'), /unknown field "__proto__" in routing/);
  assert.throws(() => files.withText('{"constructor":{"prototype":{"polluted":true}}}'), /unknown field "constructor"/);
  assert.throws(() => files.withText('execution:\n\tprivate-value'), {
    name: 'ConfigError', message: 'project configuration: invalid YAML or JSON at line 2',
  });
  assert.throws(() => deepMerge({}, JSON.parse('{"new":{"__proto__":{"polluted":true}}}')), ConfigError);
  assert.equal({}.polluted, undefined);
});
