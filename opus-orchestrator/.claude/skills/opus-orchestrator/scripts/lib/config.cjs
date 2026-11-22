'use strict';
// Configuration loading, validation and derived limits. See DESIGN.md sections 2 and 4.3.
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('./yaml.cjs');

const MODES = ['fast', 'balanced', 'thorough', 'maximum'];
const MODELS = ['haiku', 'sonnet', 'opus'];
const CONTEXT_MODES = ['aggressive', 'balanced', 'custom'];

const DEFAULTS = {
  execution: {
    mode: 'balanced', max_workers: 5, max_review_rounds: 3, max_retries: 2,
    parallel_execution: true, persistent_checkpoints: true, independent_verification: true,
    isolation: 'auto', command_timeout_seconds: 600,
  },
  models: {
    orchestrator: 'opus', worker_default: 'haiku', escalation: 'opus',
    allowed: ['haiku', 'sonnet', 'opus'],
    relative_cost: { haiku: 1, sonnet: 3, opus: 5 },
  },
  routing: {
    adaptive: true, prefer_haiku: true, allow_opus_escalation: true, min_observations: 5,
    heuristic_expected_attempts: {
      haiku: { '1-2': 1.0, '3-4': 1.2, '5-6': 1.5, '7-8': 2.2, '9-10': 3.0 },
      sonnet: { '1-2': 1.0, '3-4': 1.1, '5-6': 1.3, '7-8': 1.7, '9-10': 2.2 },
      opus: { '1-2': 1.0, '3-4': 1.0, '5-6': 1.1, '7-8': 1.3, '9-10': 1.6 },
    },
    roles: {},
  },
  budget: {
    enabled: true, token_limit: null, cost_limit_usd: null, agent_call_limit: null,
    warning_threshold_percent: 80,
  },
  verification: {
    regression_command: null,
    // Commands run before verification, integration and the final audit commands in the same
    // place (for example installing dependencies in a clean checkout); a failure stops the run.
    setup_commands: [],
    // Paths a verification command may create or change without invalidating the evidence.
    // Files the project's .gitignore ignores count as generated in a git checkout as well.
    generated_artifacts: ['coverage/', '.nyc_output/', '.pytest_cache/', '**/__pycache__/', '**/*.pyc'],
    modes: {
      fast: { max_parallel: 3, independent_review: { min_complexity: 11, risks: ['high'] }, regression: 'never', final_audit: false, reviewers_high_risk: 1 },
      balanced: { max_parallel: null, independent_review: { min_complexity: 5, risks: ['high'] }, regression: 'risky', final_audit: false, reviewers_high_risk: 1 },
      thorough: { max_parallel: null, independent_review: { min_complexity: 3, risks: ['medium', 'high'] }, regression: 'always', final_audit: true, reviewers_high_risk: 1 },
      maximum: { max_parallel: null, independent_review: { min_complexity: 1, risks: ['low', 'medium', 'high'] }, regression: 'always', final_audit: true, reviewers_high_risk: 2 },
    },
  },
  context: {
    mode: 'balanced', target_utilization: 0.60, checkpoint_before_compaction: true,
    max_resume_lines: 120, utilization_max_age_seconds: 600,
  },
  improvement: { collect_observations: true, auto_modify_core_skill: false, min_samples: 5 },
  security: {
    extra_unsafe_patterns: [],
    protected_paths: ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', '*credentials*', '*secret*'],
    // Environment variable names a verification command may still see although they look like
    // credentials (by default such variables are removed from its environment).
    command_env_allow: [],
  },
};

const SECTIONS = Object.keys(DEFAULTS);
const ISOLATIONS = ['auto', 'worktree', 'none'];

function stringList(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');
}

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

// Deep merge: objects merge key by key, arrays and scalars are replaced.
function merge(base, over) {
  if (!isPlain(over)) return over === undefined ? clone(base) : clone(over);
  const out = isPlain(base) ? clone(base) : {};
  for (const k of Object.keys(over)) {
    if (over[k] === undefined) continue;
    out[k] = isPlain(over[k]) && isPlain(out[k]) ? merge(out[k], over[k]) : clone(over[k]);
  }
  return out;
}

function defaultSkillDir() {
  return path.resolve(__dirname, '..', '..');
}

function readYamlFile(file) {
  const v = parse(fs.readFileSync(file, 'utf8'));
  return isPlain(v) ? v : {};
}

function loadConfig({ skillDir, stateConfigFile, overrides } = {}) {
  let cfg = clone(DEFAULTS);
  const dir = path.join(skillDir || defaultSkillDir(), 'config');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const f of files) cfg = merge(cfg, readYamlFile(path.join(dir, f)));
  if (stateConfigFile && fs.existsSync(stateConfigFile)) cfg = merge(cfg, readYamlFile(stateConfigFile));
  if (overrides) cfg = merge(cfg, overrides);
  return cfg;
}

function isInt(v, lo, hi) {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function validateConfig(config) {
  const errors = [];
  const warnings = [];
  const c = isPlain(config) ? config : {};
  const sec = (n) => (isPlain(c[n]) ? c[n] : {});

  for (const k of Object.keys(c)) {
    if (!SECTIONS.includes(k)) warnings.push(`unknown top-level section: ${k}`);
  }

  const ex = sec('execution');
  if (!MODES.includes(ex.mode)) errors.push(`execution.mode must be one of ${MODES.join(', ')} (got ${JSON.stringify(ex.mode)})`);
  if (!isInt(ex.max_workers, 1, 20)) errors.push('execution.max_workers must be an integer 1-20');
  if (!isInt(ex.max_review_rounds, 0, 10)) errors.push('execution.max_review_rounds must be an integer 0-10');
  if (!isInt(ex.max_retries, 0, 10)) errors.push('execution.max_retries must be an integer 0-10');
  if (!ISOLATIONS.includes(ex.isolation)) errors.push(`execution.isolation must be one of ${ISOLATIONS.join(', ')} (got ${JSON.stringify(ex.isolation)})`);
  if (!isInt(ex.command_timeout_seconds, 1, 86400)) errors.push('execution.command_timeout_seconds must be an integer from 1 to 86400');

  const ver = sec('verification');
  if (ver.regression_command !== null && ver.regression_command !== undefined && !(typeof ver.regression_command === 'string' && ver.regression_command.trim())) {
    errors.push('verification.regression_command must be null or a non-empty command string');
  }
  if (ver.setup_commands !== undefined && !stringList(ver.setup_commands)) errors.push('verification.setup_commands must be a list of non-empty command strings');
  if (ver.generated_artifacts !== undefined && !stringList(ver.generated_artifacts)) errors.push('verification.generated_artifacts must be a list of non-empty paths or globs');
  if (stringList(ver.generated_artifacts) && ver.generated_artifacts.some((g) => /^(\*\*\/?|\*|\.\/?|\/)$/.test(g.trim()))) {
    errors.push('verification.generated_artifacts must not cover the whole project (that would accept any change a command makes)');
  }

  const secu = sec('security');
  for (const k of ['extra_unsafe_patterns', 'protected_paths', 'command_env_allow']) {
    if (secu[k] !== undefined && !stringList(secu[k])) errors.push(`security.${k} must be a list of non-empty strings`);
  }

  const m = sec('models');
  for (const key of ['orchestrator', 'worker_default', 'escalation']) {
    if (!MODELS.includes(m[key])) errors.push(`models.${key} must be one of ${MODELS.join(', ')} (got ${JSON.stringify(m[key])})`);
  }
  if (!Array.isArray(m.allowed)) {
    errors.push('models.allowed must be a list');
  } else {
    for (const a of m.allowed) {
      if (!MODELS.includes(a)) errors.push(`models.allowed contains unknown model ${JSON.stringify(a)}; only ${MODELS.join(', ')} are accepted`);
    }
  }
  if (!isPlain(m.relative_cost)) {
    errors.push('models.relative_cost must be a mapping');
  } else {
    for (const [k, v] of Object.entries(m.relative_cost)) {
      if (!MODELS.includes(k)) errors.push(`models.relative_cost has unknown model ${JSON.stringify(k)}; only ${MODELS.join(', ')} are accepted`);
      if (!isNum(v) || !(v > 0)) errors.push(`models.relative_cost.${k} must be a number > 0`);
    }
  }

  const b = sec('budget');
  for (const k of ['token_limit', 'cost_limit_usd', 'agent_call_limit']) {
    if (b[k] !== null && b[k] !== undefined && !(isNum(b[k]) && b[k] > 0)) errors.push(`budget.${k} must be null or a number > 0`);
  }
  if (!(isNum(b.warning_threshold_percent) && b.warning_threshold_percent >= 1 && b.warning_threshold_percent <= 100)) {
    errors.push('budget.warning_threshold_percent must be a number from 1 to 100');
  }

  const cx = sec('context');
  if (!CONTEXT_MODES.includes(cx.mode)) errors.push(`context.mode must be one of ${CONTEXT_MODES.join(', ')}`);
  if (!(isNum(cx.target_utilization) && cx.target_utilization > 0 && cx.target_utilization < 1)) {
    errors.push('context.target_utilization must be a number between 0 and 1 (exclusive)');
  }

  if (sec('improvement').auto_modify_core_skill !== false) {
    errors.push('improvement.auto_modify_core_skill must be false; automatic modification of the core skill is not allowed');
  }

  const roles = sec('routing').roles;
  if (roles !== undefined) {
    if (!isPlain(roles)) {
      errors.push('routing.roles must be a mapping');
    } else {
      for (const [name, r] of Object.entries(roles)) {
        if (!isPlain(r) || typeof r.agent !== 'string' || r.agent === '') errors.push(`routing.roles.${name}.agent must be a non-empty string`);
        if (!isPlain(r) || typeof r.writes !== 'boolean') errors.push(`routing.roles.${name}.writes must be a boolean`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function effectiveLimits(config) {
  const ex = (config && config.execution) || {};
  const mode = ex.mode;
  let maxWorkers = ex.max_workers;
  const modes = (config && config.verification && config.verification.modes) || {};
  const cap = modes[mode] && modes[mode].max_parallel;
  if (typeof cap === 'number' && cap > 0) maxWorkers = Math.min(maxWorkers, cap);
  return { max_workers: maxWorkers, max_review_rounds: ex.max_review_rounds, max_retries: ex.max_retries, mode };
}

function contextTarget(config) {
  const cx = (config && config.context) || {};
  if (cx.mode === 'aggressive') return 0.40;
  if (cx.mode === 'balanced') return 0.60;
  return cx.target_utilization;
}

module.exports = { DEFAULTS, loadConfig, validateConfig, effectiveLimits, contextTarget };
