'use strict';

// spec.cjs (pure): task specification validation (DESIGN.md 3.1), plan
// validation, complexity scoring and initial task records (DESIGN.md 3.2).
// No I/O and no clock: timestamps come in through arguments.

const security = require('./security.cjs');

class SpecError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SpecError';
    this.code = code;
  }
}

const FACTORS = Object.freeze([
  'technical_difficulty',
  'components',
  'architectural_impact',
  'ambiguity',
  'security_sensitivity',
  'dependency_complexity',
  'regression_risk',
  'debugging_difficulty',
]);

const ID_RE = /^[A-Z][A-Z0-9]*-\d{3}$/;
const KINDS = ['implementation', 'research', 'test', 'verification', 'review', 'debug', 'documentation', 'integration', 'security', 'repository'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const RISKS = ['low', 'medium', 'high'];
const MODELS = ['haiku', 'sonnet', 'opus'];
const SIDE_EFFECTS = ['none', 'local', 'external'];

// kind -> logical role (same mapping as routing.roleFor in DESIGN.md 4.6)
const KIND_ROLE = {
  implementation: 'implementation-worker',
  research: 'research-worker',
  test: 'test-worker',
  verification: 'verification-worker',
  review: 'review-worker',
  debug: 'debug-worker',
  documentation: 'documentation-worker',
  integration: 'integration-worker',
  security: 'security-worker',
  repository: 'repository-worker',
};

// Logical roles of DESIGN.md section 2 and whether they write files. Used when
// the config does not provide routing.roles.
const DEFAULT_ROLE_WRITES = {
  'research-worker': false,
  'repository-worker': false,
  'implementation-worker': true,
  'documentation-worker': true,
  'integration-worker': true,
  'test-worker': true,
  'verification-worker': true,
  'review-worker': false,
  'security-worker': false,
  'debug-worker': true,
};

const DEFAULT_PROTECTED = ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', '*credentials*', '*secret*'];

const KNOWN_KEYS = new Set([
  'task_id', 'title', 'objective', 'kind', 'priority', 'complexity', 'complexity_factors', 'risk', 'dependencies',
  'assigned_model', 'assigned_role', 'authorized_files', 'acceptance_criteria', 'deliverables', 'verification',
  'verification_commands', 'context', 'constraints', 'tool_permissions', 'security_sensitive', 'side_effects', 'exclusive',
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * clamp(1, 10, round(1 + 9 * sum / 24)). Missing factors count as 0.
 * Throws SpecError BAD_FACTOR for unknown names, BAD_FACTOR_VALUE for values
 * that are not integers 0-3.
 */
function scoreComplexity(factors) {
  if (!isPlainObject(factors)) throw new SpecError('BAD_FACTOR', 'complexity_factors must be a mapping');
  let sum = 0;
  for (const [name, value] of Object.entries(factors)) {
    if (!FACTORS.includes(name)) throw new SpecError('BAD_FACTOR', `unknown complexity factor: ${name}`);
    if (!Number.isInteger(value) || value < 0 || value > 3) {
      throw new SpecError('BAD_FACTOR_VALUE', `complexity factor ${name} must be an integer 0-3 (got ${JSON.stringify(value)})`);
    }
    sum += value;
  }
  return Math.min(10, Math.max(1, Math.round(1 + (9 * sum) / 24)));
}

function stringList(raw, key, errors, { required = false } = {}) {
  const v = raw[key];
  if (v === undefined || v === null) {
    if (required) errors.push(`${key} must be a non-empty list`);
    return [];
  }
  if (!Array.isArray(v)) {
    errors.push(`${key} must be a list`);
    return [];
  }
  const out = [];
  v.forEach((item, i) => {
    if (!nonEmptyString(item)) errors.push(`${key}[${i}] must be a non-empty string`);
    else out.push(item);
  });
  if (required && v.length === 0) errors.push(`${key} must be a non-empty list`);
  return out;
}

function enumField(raw, key, allowed, def, errors) {
  const v = raw[key];
  if (v === undefined || v === null || v === '') return def;
  if (!allowed.includes(v)) {
    errors.push(`${key} must be one of ${allowed.join('|')} (got ${JSON.stringify(v)})`);
    return def;
  }
  return v;
}

function boolField(raw, key, errors) {
  const v = raw[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') {
    errors.push(`${key} must be true or false`);
    return false;
  }
  return v;
}

function defaultRisk(complexity, securitySensitive) {
  if (complexity >= 8 || securitySensitive) return 'high';
  if (complexity >= 5) return 'medium';
  return 'low';
}

/**
 * Validates a parsed task specification and normalizes the defaults of
 * DESIGN.md 3.1. Returns spec: null when there are errors.
 */
function validateSpec(raw, { config } = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['task specification must be a mapping'], warnings, spec: null };
  }
  const cfg = isPlainObject(config) ? config : {};
  const cfgRoles = cfg.routing && isPlainObject(cfg.routing.roles) ? cfg.routing.roles : null;
  const allowedModels = cfg.models && Array.isArray(cfg.models.allowed) ? cfg.models.allowed : null;
  const extraUnsafe = cfg.security && Array.isArray(cfg.security.extra_unsafe_patterns) ? cfg.security.extra_unsafe_patterns : [];
  const protectedPaths = cfg.security && Array.isArray(cfg.security.protected_paths) ? cfg.security.protected_paths : DEFAULT_PROTECTED;

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`unknown field ignored: ${key}`);
  }

  // identity
  const taskId = raw.task_id;
  if (typeof taskId !== 'string' || !ID_RE.test(taskId)) {
    errors.push(`task_id must match ${ID_RE.source} (got ${JSON.stringify(taskId)})`);
  }
  if (!nonEmptyString(raw.title)) errors.push('title is required');
  if (!nonEmptyString(raw.objective)) errors.push('objective is required');

  // enums
  const kind = enumField(raw, 'kind', KINDS, 'implementation', errors);
  const priority = enumField(raw, 'priority', PRIORITIES, 'medium', errors);
  const sideEffects = enumField(raw, 'side_effects', SIDE_EFFECTS, 'none', errors);
  const securitySensitive = boolField(raw, 'security_sensitive', errors);
  const exclusive = boolField(raw, 'exclusive', errors);

  // complexity
  let complexity = null;
  let factors = null;
  const hasComplexity = raw.complexity !== undefined && raw.complexity !== null;
  const hasFactors = raw.complexity_factors !== undefined && raw.complexity_factors !== null;
  if (hasFactors) {
    try {
      const computed = scoreComplexity(raw.complexity_factors);
      factors = {};
      for (const f of FACTORS) factors[f] = raw.complexity_factors[f] === undefined ? 0 : raw.complexity_factors[f];
      if (!hasComplexity) complexity = computed;
      else if (Number.isInteger(raw.complexity) && raw.complexity !== computed) {
        warnings.push(`complexity ${raw.complexity} differs from the value computed from complexity_factors (${computed}); using ${raw.complexity}`);
      }
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (hasComplexity) {
    if (!Number.isInteger(raw.complexity) || raw.complexity < 1 || raw.complexity > 10) {
      errors.push(`complexity must be an integer 1-10 (got ${JSON.stringify(raw.complexity)})`);
    } else {
      complexity = raw.complexity;
    }
  }
  if (!hasComplexity && !hasFactors) errors.push('either complexity or complexity_factors is required');

  // risk (default rule of DESIGN.md 3.1)
  let risk;
  if (raw.risk === undefined || raw.risk === null || raw.risk === '') {
    risk = complexity === null ? null : defaultRisk(complexity, securitySensitive);
  } else {
    risk = enumField(raw, 'risk', RISKS, null, errors);
    if (risk && risk !== 'high' && securitySensitive) warnings.push(`risk is ${risk} although security_sensitive is true`);
  }

  // dependencies
  const dependencies = stringList(raw, 'dependencies', errors);
  for (const d of dependencies) {
    if (!ID_RE.test(d)) errors.push(`dependency ${JSON.stringify(d)} is not a valid task id`);
    if (d === taskId) errors.push(`task ${taskId} depends on itself`);
  }

  // model and role
  let assignedModel = 'auto';
  if (raw.assigned_model !== undefined && raw.assigned_model !== null && raw.assigned_model !== '') {
    if (raw.assigned_model === 'auto' || MODELS.includes(raw.assigned_model)) {
      assignedModel = raw.assigned_model;
      if (assignedModel !== 'auto' && allowedModels && !allowedModels.includes(assignedModel)) {
        errors.push(`assigned_model ${assignedModel} is not in models.allowed`);
      }
    } else {
      errors.push(`assigned_model must be one of auto|${MODELS.join('|')} (got ${JSON.stringify(raw.assigned_model)})`);
    }
  }
  const knownRoles = cfgRoles ? Object.keys(cfgRoles) : Object.keys(DEFAULT_ROLE_WRITES);
  let assignedRole = 'auto';
  if (raw.assigned_role !== undefined && raw.assigned_role !== null && raw.assigned_role !== '') {
    if (raw.assigned_role === 'auto' || raw.assigned_role === 'orchestrator' || knownRoles.includes(raw.assigned_role)) {
      assignedRole = raw.assigned_role;
    } else {
      errors.push(`assigned_role must be auto, orchestrator or one of ${knownRoles.join('|')} (got ${JSON.stringify(raw.assigned_role)})`);
    }
  }
  const effectiveRole = assignedRole === 'auto' || assignedRole === 'orchestrator' ? KIND_ROLE[kind] : assignedRole;
  let writes;
  if (cfgRoles && cfgRoles[effectiveRole] && typeof cfgRoles[effectiveRole].writes === 'boolean') writes = cfgRoles[effectiveRole].writes;
  else writes = DEFAULT_ROLE_WRITES[effectiveRole] !== false;

  // scope
  const authorizedRaw = stringList(raw, 'authorized_files', errors);
  const authorizedFiles = authorizedRaw.map(security.normalizePath).filter(Boolean);
  for (const f of authorizedFiles) {
    if (f.split('/').includes('..')) errors.push(`authorized file ${f} contains a path traversal (..)`);
    else if (f.startsWith('/') || /^[A-Za-z]:/.test(f)) errors.push(`authorized file ${f} must be relative to the project root`);
    if (security.isProtectedPath(f, protectedPaths)) {
      if (securitySensitive) warnings.push(`authorized file ${f} matches a protected path (allowed because security_sensitive is true)`);
      else errors.push(`authorized file ${f} matches a protected path; set security_sensitive: true if this is intended`);
    }
  }
  if (writes && authorizedFiles.length === 0) {
    errors.push(`authorized_files may be empty only for non-writing roles (role ${effectiveRole} writes)`);
  }

  // criteria and lists
  const acceptanceCriteria = stringList(raw, 'acceptance_criteria', errors, { required: true });
  const deliverables = stringList(raw, 'deliverables', errors);
  const verification = stringList(raw, 'verification', errors);
  const verificationCommands = stringList(raw, 'verification_commands', errors);
  for (const cmd of verificationCommands) {
    const res = security.checkCommandSafety(cmd, extraUnsafe);
    if (!res.safe) errors.push(`unsafe verification command ${JSON.stringify(cmd)}: ${res.reason}`);
  }
  const constraints = stringList(raw, 'constraints', errors);
  const toolPermissions = stringList(raw, 'tool_permissions', errors);
  let context = '';
  if (raw.context !== undefined && raw.context !== null) {
    if (typeof raw.context !== 'string') errors.push('context must be text');
    else context = raw.context;
  }

  if (errors.length > 0) return { ok: false, errors, warnings, spec: null };

  const spec = {
    task_id: taskId,
    title: raw.title,
    objective: raw.objective,
    kind,
    priority,
    complexity,
    complexity_factors: factors,
    risk,
    dependencies,
    assigned_model: assignedModel,
    assigned_role: assignedRole,
    authorized_files: authorizedFiles,
    acceptance_criteria: acceptanceCriteria,
    deliverables,
    verification,
    verification_commands: verificationCommands,
    context,
    constraints,
    tool_permissions: toolPermissions,
    security_sensitive: securitySensitive,
    side_effects: sideEffects,
    exclusive,
  };
  return { ok: true, errors, warnings, spec };
}

/**
 * Validates a set of (normalized) specs together: duplicate ids, unknown
 * dependencies, cycles (own DFS) and a warning for overlapping scopes
 * between tasks with no dependency path between them.
 */
function validatePlan(specs) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(specs)) return { ok: false, errors: ['plan must be a list of task specifications'], warnings };

  const byId = new Map();
  specs.forEach((s, i) => {
    if (!isPlainObject(s) || typeof s.task_id !== 'string') {
      errors.push(`specification at index ${i} has no task_id`);
      return;
    }
    if (byId.has(s.task_id)) errors.push(`duplicate task_id ${s.task_id}`);
    else byId.set(s.task_id, s);
  });

  const deps = new Map();
  for (const [id, s] of byId) {
    const list = Array.isArray(s.dependencies) ? s.dependencies.filter((d) => typeof d === 'string') : [];
    for (const d of list) {
      if (!byId.has(d)) errors.push(`task ${id} depends on unknown task ${d}`);
    }
    deps.set(id, list.filter((d) => byId.has(d)));
  }

  // cycle detection: white (absent) / gray (1) / black (2)
  const color = new Map();
  const stack = [];
  const seenCycles = new Set();
  function visit(id) {
    color.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id)) {
      const c = color.get(d);
      if (c === 1) {
        const cycle = stack.slice(stack.indexOf(d)).concat(d);
        const key = cycle.slice(0, -1).slice().sort().join(',');
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
        }
      } else if (c === undefined) {
        visit(d);
      }
    }
    stack.pop();
    color.set(id, 2);
  }
  for (const id of [...byId.keys()].sort()) if (!color.has(id)) visit(id);

  // transitive dependency closure (cycle-safe)
  const ancestors = new Map();
  function closure(id) {
    if (ancestors.has(id)) return ancestors.get(id);
    const out = new Set();
    const todo = [...deps.get(id)];
    while (todo.length) {
      const d = todo.pop();
      if (out.has(d)) continue;
      out.add(d);
      todo.push(...deps.get(d));
    }
    ancestors.set(id, out);
    return out;
  }

  const ids = [...byId.keys()].sort();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = byId.get(ids[i]);
      const b = byId.get(ids[j]);
      if (!security.scopesOverlap(a.authorized_files || [], b.authorized_files || [])) continue;
      if (closure(ids[i]).has(ids[j]) || closure(ids[j]).has(ids[i])) continue;
      warnings.push(`tasks ${ids[i]} and ${ids[j]} have overlapping authorized_files and no dependency path between them; they will not run in parallel`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Initial task record (DESIGN.md 3.2) for a normalized spec. `now` is the ISO
 * timestamp of creation (required; this module never reads the clock).
 */
function newTaskRecord(spec, routing, now) {
  if (!isPlainObject(spec) || typeof spec.task_id !== 'string') throw new SpecError('BAD_SPEC', 'newTaskRecord needs a normalized spec');
  if (!nonEmptyString(now)) throw new SpecError('NOW_REQUIRED', 'newTaskRecord needs the current time as an ISO string');
  const task = structuredClone(spec);
  task.status = 'PENDING';
  task.review_round = 0;
  task.attempts = 0;
  task.retries = 0;
  task.spec_revision = 1;
  task.routing = routing == null ? null : structuredClone(routing);
  task.history = [{ ts: now, from: null, to: 'PENDING', reason: 'task planned', actor: 'orchestrator' }];
  task.evidence = { self_check: null, verification: null, reviews: [], integration: null };
  task.result = null;
  task.correction = null;
  task.corrections = [];
  task.failure = null;
  task.block = null;
  task.created_at = now;
  return task;
}

module.exports = {
  FACTORS,
  scoreComplexity,
  validateSpec,
  validatePlan,
  newTaskRecord,
  SpecError,
  KIND_ROLE,
  DEFAULT_PROTECTED,
};
