'use strict';

const fs = require('fs');
const yaml = require('./miniyaml.cjs');
const { MODES, MODEL_RANK, TIER_ORDER } = require('./routing.cjs');

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const has = (record, key) => Object.prototype.hasOwnProperty.call(record, key);
const isMapping = (value) => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function rule(expected, accepts) {
  return Object.assign(accepts, { expected });
}

function oneOf(values) {
  return rule(values.join(', '), (value) => values.includes(value));
}

function range(min, max, integer = false) {
  return rule(`${integer ? 'an integer' : 'a number'} from ${min} to ${max}`,
    (value) => (integer ? Number.isSafeInteger(value) : Number.isFinite(value))
      && value >= min && value <= max);
}

function nullable(check) {
  return rule(`${check.expected} or null`, (value) => value === null || check(value));
}

const boolean = rule('true or false', (value) => typeof value === 'boolean');
const count = range(0, Number.MAX_SAFE_INTEGER, true);
const nonnegative = rule('a finite nonnegative number', (value) => Number.isFinite(value) && value >= 0);
const command = nullable(rule('a nonempty command string without a NUL character',
  (value) => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')));
const models = Object.keys(MODEL_RANK);
const tier = {
  model: oneOf(models),
  effort: nullable(oneOf(['low', 'medium', 'high', 'xhigh', 'max'])),
};

const SCHEMA = {
  execution: {
    mode: oneOf(Object.keys(MODES)),
    max_workers: range(1, 20, true),
    max_review_rounds: range(0, 10, true),
    max_task_retries: range(0, 10, true),
  },
  budget: {
    enabled: boolean,
    token_limit: nullable(count),
    cost_limit_usd: nullable(nonnegative),
    agent_call_limit: nullable(count),
    warn_at_percent: range(0, 100),
  },
  routing: {
    adaptive: boolean,
    prefer_lower_cost_models: boolean,
    allow_escalation: boolean,
    min_samples: range(1, Number.MAX_SAFE_INTEGER, true),
    min_first_pass_rate: range(0, 1),
    tiers: Object.fromEntries(TIER_ORDER.map((name) => [name, tier])),
    cost_weights: Object.fromEntries(models.map((name) => [name, nonnegative])),
  },
  isolation: { strategy: oneOf(['auto', 'native', 'managed', 'shared']) },
  integration: { auto_deliver: boolean, regression_command: command, setup_command: command },
  verification: { command_timeout_seconds: range(1, 2_147_483, true) },
  learning: { enabled: boolean },
};

function validate(value, schema, source, prefix, partial) {
  if (!isMapping(value)) throw new ConfigError(`${source}: ${prefix || 'configuration'} must be a mapping`);
  for (const [key, setting] of Object.entries(value)) {
    if (!has(schema, key)) {
      const section = prefix ? ` in ${prefix}` : '';
      throw new ConfigError(`${source}: unknown field ${JSON.stringify(key.slice(0, 80))}${section}`);
    }
    const name = prefix ? `${prefix}.${key}` : key;
    const check = schema[key];
    if (typeof check !== 'function') validate(setting, check, source, name, partial);
    else if (!check(setting)) throw new ConfigError(`${source}: ${name} must be ${check.expected}`);
  }
  if (!partial) {
    for (const key of Object.keys(schema)) {
      if (!has(value, key)) throw new ConfigError(`${source}: missing required field ${prefix ? `${prefix}.` : ''}${key}`);
    }
  }
}

const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(base, override) {
  if (!isMapping(override)) return override === undefined ? base : override;
  const result = isMapping(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(override)) {
    if (unsafeKeys.has(key)) throw new ConfigError('configuration contains a reserved mapping key');
    result[key] = deepMerge(has(result, key) ? result[key] : undefined, value);
  }
  return result;
}

function readSettings(file, source, partial) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (partial && error.code === 'ENOENT') return {};
    throw new ConfigError(`${source}: could not read configuration`);
  }
  if (partial && text.split(/\r?\n/).every((line) => /^(?:#.*|---|\.\.\.)?$/.test(line.trim()))) return {};
  let settings;
  try {
    settings = yaml.parse(text);
  } catch (error) {
    const line = error.line ? ` at line ${error.line}` : '';
    throw new ConfigError(`${source}: invalid YAML or JSON${line}`);
  }
  validate(settings, SCHEMA, source, '', partial);
  return settings;
}

function readConfig(defaultFile, overrideFile) {
  const defaults = readSettings(defaultFile, 'default configuration', false);
  if (overrideFile === undefined) return defaults;
  return deepMerge(defaults, readSettings(overrideFile, 'project configuration', true));
}

module.exports = { ConfigError, readConfig, deepMerge };
