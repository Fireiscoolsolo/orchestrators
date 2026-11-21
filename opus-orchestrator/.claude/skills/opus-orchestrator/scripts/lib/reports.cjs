'use strict';

// reports.cjs (pure): validation of worker results (DESIGN.md 3.4), review
// reports (3.5) and correction requests (3.6) against the task they belong to.
// No I/O and no clock. Every returned object is a deep copy whose string
// values have been passed through security.redactSecrets; error messages are
// redacted as well because they may quote input values.

const security = require('./security.cjs');

const RESULT_STATUSES = ['completed', 'failed', 'blocked', 'needs_decomposition'];
const VERDICTS = ['approve', 'request_changes', 'reject'];
const SEVERITIES = ['blocker', 'major', 'minor', 'note'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/** Deep copy of a JSON-like value with every string redacted. */
function redactDeep(v) {
  if (typeof v === 'string') return security.redactSecrets(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = redactDeep(val);
    return out;
  }
  return v;
}

function criteriaOf(task) {
  return task && Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria : [];
}

function finish(errors, key, value) {
  const errs = errors.map((e) => security.redactSecrets(e));
  return { ok: errs.length === 0, errors: errs, [key]: errs.length === 0 ? value : null };
}

function checkTaskId(obj, task, errors) {
  const expected = task && typeof task.task_id === 'string' ? task.task_id : null;
  if (!nonEmptyString(obj.task_id)) {
    errors.push('task_id is required');
  } else if (expected !== null && obj.task_id !== expected) {
    errors.push(`task_id ${JSON.stringify(obj.task_id)} does not match the task ${JSON.stringify(expected)}`);
  }
}

/**
 * Checks a list of {met, evidence} entries: exactly one per acceptance
 * criterion, boolean met, non-empty evidence string.
 */
function checkCriteriaList(list, field, criteria, errors) {
  if (!Array.isArray(list)) {
    errors.push(`${field} must be a list with one entry per acceptance criterion (${criteria.length})`);
    return false;
  }
  let ok = true;
  if (list.length !== criteria.length) {
    errors.push(`${field} has ${list.length} entries but the task has ${criteria.length} acceptance criteria; give exactly one entry per criterion, in order`);
    ok = false;
  }
  list.forEach((entry, i) => {
    if (!isPlainObject(entry)) {
      errors.push(`${field}[${i}] must be a mapping with met and evidence`);
      ok = false;
      return;
    }
    if (typeof entry.met !== 'boolean') {
      errors.push(`${field}[${i}].met must be true or false`);
      ok = false;
    }
    if (!nonEmptyString(entry.evidence)) {
      errors.push(`${field}[${i}].evidence must be a non-empty string`);
      ok = false;
    }
  });
  return ok;
}

function stringListField(obj, key, errors) {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    errors.push(`${key} must be a list of strings`);
    return [];
  }
  v.forEach((item, i) => {
    if (!nonEmptyString(item)) errors.push(`${key}[${i}] must be a non-empty string`);
  });
  return v.filter(nonEmptyString);
}

function optionalString(obj, key, errors) {
  const v = obj[key];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') {
    errors.push(`${key} must be a string or null`);
    return null;
  }
  return v;
}

/**
 * Validates a worker's agent result (DESIGN.md 3.4) for the given task.
 * @returns {{ok: boolean, errors: string[], result: object|null}}
 */
function validateAgentResult(obj, task) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return finish(['agent result must be a mapping (the YAML block of DESIGN.md 3.4)'], 'result', null);
  }
  checkTaskId(obj, task, errors);

  if (!RESULT_STATUSES.includes(obj.status)) {
    errors.push(`status must be one of ${RESULT_STATUSES.join('|')} (got ${JSON.stringify(obj.status)})`);
  }
  if (!nonEmptyString(obj.summary)) errors.push('summary must be a non-empty string');

  const filesChanged = stringListField(obj, 'files_changed', errors).map(security.normalizePath);

  const criteria = criteriaOf(task);
  let selfCheck = null;
  if (obj.status === 'completed') {
    if (checkCriteriaList(obj.self_check, 'self_check', criteria, errors)) selfCheck = obj.self_check;
  } else if (Array.isArray(obj.self_check)) {
    selfCheck = obj.self_check;
  }

  let commandsRun = [];
  if (obj.commands_run !== undefined && obj.commands_run !== null) {
    if (!Array.isArray(obj.commands_run)) {
      errors.push('commands_run must be a list of {command, exit_code}');
    } else {
      obj.commands_run.forEach((c, i) => {
        if (!isPlainObject(c) || !nonEmptyString(c.command)) {
          errors.push(`commands_run[${i}] must be a mapping with a non-empty command`);
        } else if (c.exit_code !== undefined && c.exit_code !== null && !Number.isInteger(c.exit_code)) {
          errors.push(`commands_run[${i}].exit_code must be an integer or null`);
        }
      });
      commandsRun = obj.commands_run;
    }
  }

  const commit = optionalString(obj, 'commit', errors);
  const branch = optionalString(obj, 'branch', errors);

  let issues = [];
  if (obj.issues !== undefined && obj.issues !== null) {
    if (!Array.isArray(obj.issues)) errors.push('issues must be a list');
    else issues = obj.issues;
  }

  let proposed = [];
  if (obj.proposed_subtasks !== undefined && obj.proposed_subtasks !== null) {
    if (!Array.isArray(obj.proposed_subtasks)) errors.push('proposed_subtasks must be a list');
    else proposed = obj.proposed_subtasks;
  }
  if (obj.status === 'needs_decomposition' && proposed.length === 0) {
    errors.push('status needs_decomposition requires a non-empty proposed_subtasks list');
  }

  const result = redactDeep({
    ...obj,
    files_changed: filesChanged,
    self_check: selfCheck,
    commands_run: commandsRun,
    commit,
    branch,
    issues,
    proposed_subtasks: proposed,
  });
  return finish(errors, 'result', result);
}

/**
 * Validates a review report (DESIGN.md 3.5) for the given task.
 * @returns {{ok: boolean, errors: string[], review: object|null}}
 */
function validateReview(obj, task) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return finish(['review report must be a mapping (DESIGN.md 3.5)'], 'review', null);
  }
  checkTaskId(obj, task, errors);
  if (!nonEmptyString(obj.reviewer)) errors.push('reviewer must be a non-empty string');
  const verdictOk = VERDICTS.includes(obj.verdict);
  if (!verdictOk) errors.push(`verdict must be one of ${VERDICTS.join('|')} (got ${JSON.stringify(obj.verdict)})`);

  const criteria = criteriaOf(task);
  checkCriteriaList(obj.criteria, 'criteria', criteria, errors);
  if (obj.verdict === 'approve' && Array.isArray(obj.criteria)) {
    const unmet = [];
    obj.criteria.forEach((c, i) => {
      if (!isPlainObject(c) || c.met !== true) unmet.push(i + 1);
    });
    if (unmet.length > 0) errors.push(`verdict approve requires every criterion met; unmet: ${unmet.join(', ')}`);
  }

  let findings = [];
  if (obj.findings !== undefined && obj.findings !== null) {
    if (!Array.isArray(obj.findings)) {
      errors.push('findings must be a list');
    } else {
      findings = obj.findings;
      findings.forEach((f, i) => {
        if (!isPlainObject(f)) {
          errors.push(`findings[${i}] must be a mapping with severity and description`);
          return;
        }
        if (!SEVERITIES.includes(f.severity)) {
          errors.push(`findings[${i}].severity must be one of ${SEVERITIES.join('|')} (got ${JSON.stringify(f.severity)})`);
        }
        if (!nonEmptyString(f.description)) errors.push(`findings[${i}].description must be a non-empty string`);
        if (f.file !== undefined && f.file !== null && typeof f.file !== 'string') errors.push(`findings[${i}].file must be a string`);
      });
    }
  }
  if (verdictOk && obj.verdict !== 'approve' && findings.length === 0) {
    errors.push(`verdict ${obj.verdict} requires a non-empty findings list`);
  }

  let checks = {};
  if (obj.checks !== undefined && obj.checks !== null) {
    if (!isPlainObject(obj.checks)) errors.push('checks must be a mapping');
    else checks = obj.checks;
  }

  const review = redactDeep({ ...obj, findings, checks });
  return finish(errors, 'review', review);
}

/**
 * Validates a correction request (DESIGN.md 3.6) for the given task. The optional
 * verification_commands are extra shell commands that oo verify runs in the correction round.
 * opts.round: the correction round this request starts (1 for the first).
 * opts.extraUnsafe: extra unsafe command patterns (config security.extra_unsafe_patterns).
 * @returns {{ok: boolean, errors: string[], correction: object|null}}
 */
function validateCorrection(obj, task, { round = 1, extraUnsafe = [] } = {}) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return finish(['correction request must be a mapping (DESIGN.md 3.6)'], 'correction', null);
  }
  const expectedId = task && typeof task.task_id === 'string' ? task.task_id : null;
  if (obj.task_id !== undefined && obj.task_id !== null && expectedId !== null && obj.task_id !== expectedId) {
    errors.push(`task_id ${JSON.stringify(obj.task_id)} does not match the task ${JSON.stringify(expectedId)}`);
  }

  for (const key of ['failure', 'evidence', 'expected_behavior', 'required_change']) {
    if (!nonEmptyString(obj[key])) errors.push(`${key} must be a non-empty string`);
  }

  // verification: non-empty list of safe commands
  let verification = [];
  if (!Array.isArray(obj.verification) || obj.verification.length === 0) {
    errors.push('verification must be a non-empty list of commands or steps');
  } else {
    obj.verification.forEach((v, i) => {
      if (!nonEmptyString(v)) {
        errors.push(`verification[${i}] must be a non-empty string`);
        return;
      }
      const safety = security.checkCommandSafety(v, extraUnsafe);
      if (!safety.safe) errors.push(`unsafe verification command ${JSON.stringify(v)}: ${safety.reason}`);
    });
    verification = obj.verification;
  }

  // verification_commands: optional shell commands that oo verify runs in this correction round,
  // safety-checked like a task's own verification commands
  let verificationCommands = [];
  if (obj.verification_commands !== undefined && obj.verification_commands !== null) {
    if (!Array.isArray(obj.verification_commands)) {
      errors.push('verification_commands must be a list of shell commands');
    } else {
      obj.verification_commands.forEach((v, i) => {
        if (!nonEmptyString(v)) {
          errors.push(`verification_commands[${i}] must be a non-empty string`);
          return;
        }
        const safety = security.checkCommandSafety(v, extraUnsafe);
        if (!safety.safe) errors.push(`unsafe verification_commands command ${JSON.stringify(v)}: ${safety.reason}`);
      });
      verificationCommands = obj.verification_commands;
    }
  }

  // scope: defaults to the task's authorized files, must lie inside them
  const authorized = task && Array.isArray(task.authorized_files) ? task.authorized_files : [];
  let scope;
  if (obj.scope === undefined || obj.scope === null) {
    scope = authorized.slice();
  } else if (!Array.isArray(obj.scope) || obj.scope.some((s) => !nonEmptyString(s))) {
    errors.push('scope must be a list of non-empty paths');
    scope = [];
  } else {
    scope = obj.scope.map(security.normalizePath);
    const outside = security.outOfScope(scope, authorized);
    if (outside.length > 0) {
      errors.push(`scope lies outside the task's authorized_files: ${outside.join(', ')}`);
    }
  }

  const r = Number.isInteger(round) ? round : 1;
  if (r >= 2 && !nonEmptyString(obj.strategy_change)) {
    errors.push(`strategy_change is required from the second correction round on (this is round ${r})`);
  }

  const correction = redactDeep({
    ...obj,
    task_id: expectedId !== null ? expectedId : obj.task_id,
    scope,
    verification,
    verification_commands: verificationCommands,
    strategy_change: nonEmptyString(obj.strategy_change) ? obj.strategy_change : null,
    round: r,
  });
  return finish(errors, 'correction', correction);
}

module.exports = {
  validateAgentResult,
  validateReview,
  validateCorrection,
  RESULT_STATUSES,
  VERDICTS,
  SEVERITIES,
};
