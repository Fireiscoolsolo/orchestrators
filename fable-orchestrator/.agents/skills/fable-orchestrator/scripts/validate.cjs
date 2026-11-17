'use strict';
/**
 * validate - schema checks for task contracts, worker completion reports,
 * review reports and correction requests. Each validator returns
 * {errors, warnings, <normalized object>}; nothing is accepted with errors.
 *
 * CLI: node validate.cjs contract <file> [<file>...]
 */
const fs = require('fs');
const yaml = require('./miniyaml.cjs');
const { FACTORS, MODEL_RANK, scoreFromFactors } = require('./routing.cjs');
const { matchPath } = require('./dependency_scheduler.cjs');

const WRITER_ROLES = ['implementation-worker', 'test-worker', 'debug-worker', 'integration-worker', 'documentation-worker', 'opus-executor', 'orchestrator'];
const READER_ROLES = ['research-worker', 'review-worker'];
const ROLES = WRITER_ROLES.concat(READER_ROLES);
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const RISKS = ['low', 'medium', 'high'];
const SIDE_EFFECTS = ['none', 'local', 'external'];
const REPORT_STATUS = ['implemented', 'blocked', 'failed', 'needs_decomposition'];
const STRATEGY_KINDS = ['model', 'decomposition', 'context', 'strategy'];
const REVIEW_CHECKS = [
  'criteria_met', 'no_functional_defects', 'no_regressions', 'no_unauthorized_files', 'tests_meaningful',
  'error_cases_handled', 'security_boundaries_preserved', 'maintainable', 'documentation_accurate', 'evidence_sufficient',
];
const TASK_ID = /^[A-Z][A-Z0-9]{0,11}-\d{1,4}$/;
const VAGUE = /\b(works? (correctly|properly|well|fine)|as expected|looks? good|is good|properly|appropriately|and so on|etc)\b/i;
const CONTRACT_FIELDS = [
  'task_id', 'title', 'objective', 'priority', 'dependencies', 'complexity_score', 'complexity_factors', 'risk_level',
  'assigned_role', 'preferred_model', 'file_scope', 'acceptance_criteria', 'verification', 'verification_commands',
  'security_sensitive', 'side_effects', 'exclusive', 'inputs', 'outputs', 'context', 'status', 'review_round',
];

// Commands the orchestrator must never run on its own authority.
const DANGEROUS = [
  [/\brm\s+(-\S+\s+)*-[a-zA-Z]*[rR]/, 'recursive delete'],
  [/\bgit\s+(push|clean|rebase)\b/, 'history-rewriting or remote git operation'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard discards work'],
  [/\bgit\s+checkout\s+(--\s|\.(\s|$))/, 'git checkout that discards changes'],
  [/\bgit\s+branch\s+-D\b/, 'forced branch deletion'],
  [/\bgit\s+stash\s+(drop|clear)\b/, 'stash deletion'],
  [/\b(rmdir|rd)\s+\/s\b/i, 'recursive delete'],
  [/\bdel\s+\/[a-z]/i, 'forced delete'],
  [/\bRemove-Item\b[^|;]*-Recurse/i, 'recursive delete'],
  [/\bformat\s+[a-z]:/i, 'disk format'],
  [/\b(shutdown|reboot|mkfs)\b|\bdd\s+if=/, 'system-level operation'],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|iex|powershell|pwsh)\b/i, 'piping a download into a shell'],
  [/\b(npm|pnpm|yarn)\s+publish\b/, 'package publication'],
  [/\b(terraform\s+(apply|destroy)|kubectl\s+(apply|delete)|helm\s+(install|upgrade|uninstall))\b/, 'infrastructure change'],
  [/\b(vercel|netlify|firebase|flyctl|fly)\s+deploy\b/, 'deployment'],
  [/\bdrop\s+(table|database)\b/i, 'destructive SQL'],
];

function dangerousCommand(cmd) {
  for (const [re, why] of DANGEROUS) if (re.test(cmd)) return why;
  return null;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** Normalize a list of strings. A "- Label: detail" item parses as a one-key mapping; fold it back into text. */
function strList(value, field, errors) {
  if (value === undefined || value === null) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  arr.forEach((item, idx) => {
    if (isObj(item)) {
      const keys = Object.keys(item);
      const v = keys.length === 1 ? item[keys[0]] : undefined;
      if (keys.length === 1 && (v === null || typeof v !== 'object')) {
        out.push(v === null ? `${keys[0]}:` : `${keys[0]}: ${v}`);
        return;
      }
      errors.push(`${field}[${idx}]: expected text, found a mapping`);
      return;
    }
    if (item === null || Array.isArray(item)) { errors.push(`${field}[${idx}]: expected text`); return; }
    const s = String(item).trim();
    if (s) out.push(s);
  });
  return out;
}

function scopeEntry(p, field, errors) {
  const s = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  if (/^([a-zA-Z]:|\/|~)/.test(s)) errors.push(`${field}: "${p}" must be relative to the project root`);
  if (s.split('/').includes('..')) errors.push(`${field}: "${p}" must not contain ".."`);
  return s === '' ? '.' : s;
}

function modelAlias(v) {
  const s = text(v).toLowerCase();
  if (s === '' || s === 'auto') return 'auto';
  for (const m of Object.keys(MODEL_RANK)) if (s.includes(m)) return m;
  return null;
}

const bool3 = (v) => (v === true ? true : v === false ? false : null);

function validateContract(raw) {
  const errors = [];
  const warnings = [];
  if (!isObj(raw)) return { errors: ['contract must be a YAML mapping'], warnings, contract: null };
  for (const k of Object.keys(raw)) if (!CONTRACT_FIELDS.includes(k)) warnings.push(`unknown field "${k}" ignored`);

  const c = {};
  c.task_id = text(raw.task_id);
  if (!TASK_ID.test(c.task_id)) errors.push(`task_id "${c.task_id}" must look like AUTH-001`);
  c.title = text(raw.title);
  if (!c.title) errors.push('title: required');
  c.objective = text(raw.objective);
  if (c.objective.length < 10) errors.push('objective: required (what must be true when the task is done)');
  c.priority = text(raw.priority || 'medium').toLowerCase();
  if (!PRIORITIES.includes(c.priority)) errors.push(`priority: one of ${PRIORITIES.join(', ')}`);
  c.dependencies = strList(raw.dependencies, 'dependencies', errors);
  for (const d of c.dependencies) if (!TASK_ID.test(d)) errors.push(`dependencies: "${d}" is not a task id`);

  let computed = null;
  if (raw.complexity_factors !== undefined && raw.complexity_factors !== null) {
    if (!isObj(raw.complexity_factors)) {
      errors.push('complexity_factors: mapping of factor -> 0..3');
    } else {
      const f = {};
      for (const [k, v] of Object.entries(raw.complexity_factors)) {
        if (!FACTORS.includes(k)) { errors.push(`complexity_factors: unknown factor "${k}" (use ${FACTORS.join(', ')})`); continue; }
        if (!Number.isInteger(v) || v < 0 || v > 3) { errors.push(`complexity_factors.${k}: integer 0-3`); continue; }
        f[k] = v;
      }
      c.complexity_factors = f;
      computed = scoreFromFactors(f);
    }
  }
  if (raw.complexity_score !== undefined && raw.complexity_score !== null) {
    const n = Number(raw.complexity_score);
    if (!Number.isInteger(n) || n < 1 || n > 10) errors.push('complexity_score: integer 1-10');
    else {
      c.complexity_score = n;
      if (computed !== null && Math.abs(computed - n) > 2) warnings.push(`complexity_score ${n} differs from the factor-derived score ${computed}`);
    }
  } else if (computed !== null) {
    c.complexity_score = computed;
  } else {
    errors.push('complexity_score (1-10) or complexity_factors: required');
  }

  c.risk_level = text(raw.risk_level).toLowerCase();
  if (!RISKS.includes(c.risk_level)) errors.push(`risk_level: required, one of ${RISKS.join(', ')}`);
  c.assigned_role = text(raw.assigned_role || 'auto');
  if (c.assigned_role !== 'auto' && !ROLES.includes(c.assigned_role)) errors.push(`assigned_role: "auto" or one of ${ROLES.join(', ')}`);
  c.preferred_model = modelAlias(raw.preferred_model);
  if (c.preferred_model === null) errors.push(`preferred_model: "auto" or one of ${Object.keys(MODEL_RANK).join(', ')}`);
  c.security_sensitive = raw.security_sensitive === true || (c.complexity_factors && c.complexity_factors.security >= 2) || false;
  c.side_effects = text(raw.side_effects || 'none').toLowerCase();
  if (!SIDE_EFFECTS.includes(c.side_effects)) errors.push(`side_effects: one of ${SIDE_EFFECTS.join(', ')}`);
  c.exclusive = raw.exclusive === true;

  const writer = c.assigned_role === 'auto' || WRITER_ROLES.includes(c.assigned_role);
  c.file_scope = strList(raw.file_scope, 'file_scope', errors).map((p) => scopeEntry(p, 'file_scope', errors));
  if (writer && !c.file_scope.length) errors.push('file_scope: required for tasks that modify files');
  if (c.file_scope.includes('.')) warnings.push('file_scope covers the whole project: this task cannot run in parallel with any other');

  c.acceptance_criteria = strList(raw.acceptance_criteria, 'acceptance_criteria', errors);
  if (!c.acceptance_criteria.length) errors.push('acceptance_criteria: at least one testable criterion required');
  c.acceptance_criteria.forEach((a, i) => {
    if (a.length < 8) errors.push(`acceptance_criteria[${i}]: too short to be testable`);
    else if (VAGUE.test(a)) warnings.push(`acceptance_criteria[${i}] is vague ("${a}"): state an observable result`);
  });
  c.verification = strList(raw.verification, 'verification', errors);
  if (!c.verification.length) errors.push('verification: at least one verification step required');
  c.verification_commands = strList(raw.verification_commands, 'verification_commands', errors);
  for (const cmd of c.verification_commands) {
    const why = dangerousCommand(cmd);
    if (why) errors.push(`verification_commands: "${cmd}" refused (${why}); such operations need explicit user authorization and are never run as verification`);
  }
  if (writer && !c.verification_commands.length) warnings.push('no verification_commands: approval will rest on recorded manual checks only');
  c.inputs = strList(raw.inputs, 'inputs', errors);
  c.outputs = strList(raw.outputs, 'outputs', errors);
  c.context = text(raw.context);
  if (raw.status !== undefined && text(raw.status).toLowerCase() !== 'pending') warnings.push('status is managed by the state machine; the value in the contract is ignored');
  return { errors, warnings, contract: c };
}

/** task: {id, contract, route}; opts.git: work must be locatable through git */
function validateReport(raw, task, opts) {
  const errors = [];
  const warnings = [];
  if (!isObj(raw)) return { errors: ['completion report must be a YAML mapping'], warnings, report: null };
  const reader = READER_ROLES.includes(task.route.role);
  const r = {};
  r.task_id = text(raw.task_id);
  if (r.task_id !== task.id) errors.push(`task_id "${r.task_id}" does not match ${task.id}`);
  r.status = text(raw.status).toLowerCase();
  if (!REPORT_STATUS.includes(r.status)) errors.push(`status: one of ${REPORT_STATUS.join(', ')}`);
  r.summary = text(raw.summary);
  if (!r.summary) errors.push('summary: required');
  r.files_changed = strList(raw.files_changed, 'files_changed', errors).map((p) => p.replace(/\\/g, '/'));
  r.known_issues = strList(raw.known_issues, 'known_issues', errors);
  r.findings = strList(raw.findings, 'findings', errors);
  r.reason = text(raw.reason);
  r.commit = text(raw.commit);
  if (r.commit && !/^[0-9a-f]{7,40}$/i.test(r.commit)) errors.push('commit: must be a git commit SHA');
  r.branch = text(raw.branch);
  r.worktree_path = text(raw.worktree_path);
  r.delegations = Number.isInteger(raw.delegations) && raw.delegations > 0 ? raw.delegations : 0;
  r.proposed_subtasks = Array.isArray(raw.proposed_subtasks) ? raw.proposed_subtasks : [];

  const v = isObj(raw.verification) ? raw.verification : null;
  if (v) {
    r.verification = { tests_run: bool3(v.tests_run), tests_passed: bool3(v.tests_passed), build_passed: bool3(v.build_passed), commands: [] };
    for (const item of Array.isArray(v.commands) ? v.commands : []) {
      if (isObj(item) && item.cmd !== undefined) r.verification.commands.push({ cmd: text(item.cmd), exit_code: Number.isInteger(item.exit_code) ? item.exit_code : null });
      else if (typeof item === 'string') r.verification.commands.push({ cmd: item, exit_code: null });
    }
  } else {
    r.verification = null;
  }

  if (r.status === 'implemented') {
    if (!v) {
      errors.push('verification: required mapping with tests_run, tests_passed, build_passed');
    } else {
      if (r.verification.tests_run === null) errors.push('verification.tests_run: true or false required');
      if (r.verification.tests_passed === true && r.verification.tests_run !== true) errors.push('verification: tests_passed true requires tests_run true');
      if (r.verification.tests_run === false && !reader) warnings.push('worker ran no tests');
      if (r.verification.tests_passed === false) warnings.push('worker reports failing tests');
    }
    if (reader && !r.findings.length) errors.push('findings: required for research and review roles');
    if (!reader && !r.files_changed.length) warnings.push('no files_changed reported');
    if (opts && opts.git && r.files_changed.length && !r.commit && !r.branch && !r.worktree_path) {
      errors.push('commit (or branch / worktree_path): required so the work can be located');
    }
  }
  if ((r.status === 'blocked' || r.status === 'failed') && !r.reason && !r.known_issues.length) {
    errors.push('reason: required when status is blocked or failed');
  }
  return { errors, warnings, report: r };
}

function validateReview(raw, task) {
  const errors = [];
  const warnings = [];
  if (!isObj(raw)) return { errors: ['review report must be a YAML mapping'], warnings, review: null };
  const r = {};
  r.task_id = text(raw.task_id);
  if (r.task_id !== task.id) errors.push(`task_id "${r.task_id}" does not match ${task.id}`);
  r.reviewer = text(raw.reviewer);
  if (!['orchestrator', 'review-worker'].includes(r.reviewer)) errors.push('reviewer: orchestrator or review-worker');
  r.perspective = text(raw.perspective || 'correctness').toLowerCase();
  r.verdict = text(raw.verdict).toLowerCase();
  if (!['approve', 'reject'].includes(r.verdict)) errors.push('verdict: approve or reject');
  r.findings = strList(raw.findings, 'findings', errors);
  r.notes = text(raw.notes);

  const expected = task.contract.acceptance_criteria;
  r.criteria = [];
  const list = Array.isArray(raw.criteria) ? raw.criteria : [];
  if (list.length !== expected.length) {
    errors.push(`criteria: ${expected.length} entries required, one per acceptance criterion in order (found ${list.length})`);
  }
  list.forEach((item, i) => {
    if (!isObj(item) || typeof item.met !== 'boolean') { errors.push(`criteria[${i}]: mapping with met: true|false and evidence`); return; }
    r.criteria.push({ criterion: expected[i] || text(item.criterion), met: item.met, evidence: text(item.evidence) });
  });

  r.checks = null;
  if (isObj(raw.checks)) {
    r.checks = {};
    for (const [k, v] of Object.entries(raw.checks)) {
      if (!REVIEW_CHECKS.includes(k)) { warnings.push(`checks: unknown key "${k}" ignored`); continue; }
      if (typeof v !== 'boolean') { errors.push(`checks.${k}: true or false`); continue; }
      r.checks[k] = v;
    }
  }

  if (r.verdict === 'approve') {
    const unmet = r.criteria.filter((c) => !c.met).length;
    const bare = r.criteria.filter((c) => c.met && !c.evidence).length;
    if (unmet) errors.push(`approve refused: ${unmet} acceptance criteria are marked unmet`);
    if (bare) errors.push(`approve refused: ${bare} criteria have no evidence`);
    if (r.checks && Object.values(r.checks).includes(false)) errors.push('approve refused: a review check is false');
    if (task.route.oversight && r.reviewer === 'orchestrator') {
      const missing = REVIEW_CHECKS.filter((k) => !r.checks || r.checks[k] === undefined);
      if (missing.length) errors.push(`approve refused: oversight-tier tasks need every review check answered (missing ${missing.join(', ')})`);
    }
  }
  if (r.verdict === 'reject' && !r.findings.length && !r.criteria.some((c) => !c.met)) {
    errors.push('reject requires at least one finding or one unmet criterion');
  }
  return { errors, warnings, review: r };
}

/** round: the correction round this request opens (1-based) */
function validateCorrection(raw, task, round) {
  const errors = [];
  const warnings = [];
  if (!isObj(raw)) return { errors: ['correction request must be a YAML mapping'], warnings, correction: null };
  const c = {};
  c.task_id = text(raw.task_id);
  if (c.task_id !== task.id) errors.push(`task_id "${c.task_id}" does not match ${task.id}`);
  for (const f of ['failure', 'evidence', 'expected_behavior', 'required_change']) {
    c[f] = text(raw[f]);
    if (!c[f]) errors.push(`${f}: required`);
  }
  c.verification = strList(raw.verification, 'verification', errors);
  if (!c.verification.length) errors.push('verification: how the fix will be re-verified is required');

  c.scope_expansion = strList(raw.scope_expansion, 'scope_expansion', errors).map((p) => scopeEntry(p, 'scope_expansion', errors));
  c.scope_expansion_reason = text(raw.scope_expansion_reason);
  if (c.scope_expansion.length && !c.scope_expansion_reason) errors.push('scope_expansion_reason: required when the correction widens the file scope');
  const allowed = task.contract.file_scope.concat(c.scope_expansion);
  c.scope = strList(raw.scope, 'scope', errors).map((p) => scopeEntry(p, 'scope', errors));
  for (const s of c.scope) {
    if (!allowed.some((p) => p === s || matchPath(p, s))) errors.push(`scope: "${s}" is outside the task file_scope (use scope_expansion with a reason to widen it)`);
  }

  c.assign_role = text(raw.assign_role);
  if (c.assign_role && !ROLES.includes(c.assign_role)) errors.push(`assign_role: one of ${ROLES.join(', ')}`);

  c.strategy_change = null;
  if (isObj(raw.strategy_change)) {
    const kind = text(raw.strategy_change.kind).toLowerCase();
    const detail = text(raw.strategy_change.detail);
    const model = raw.strategy_change.model === undefined ? null : modelAlias(raw.strategy_change.model);
    if (!STRATEGY_KINDS.includes(kind)) errors.push(`strategy_change.kind: one of ${STRATEGY_KINDS.join(', ')}`);
    if (!detail) errors.push('strategy_change.detail: required');
    if (raw.strategy_change.model !== undefined && (model === null || model === 'auto')) errors.push('strategy_change.model: haiku, sonnet, opus or fable');
    c.strategy_change = { kind, detail, model: model && model !== 'auto' ? model : null };
  }
  if (round >= 2 && !c.strategy_change) {
    errors.push(`round ${round}: a repeated correction must change something (strategy_change with kind model, decomposition, context or strategy)`);
  }
  return { errors, warnings, correction: c };
}

module.exports = {
  ROLES, WRITER_ROLES, READER_ROLES, REVIEW_CHECKS, TASK_ID,
  dangerousCommand, strList, validateContract, validateReport, validateReview, validateCorrection,
};

if (require.main === module) {
  const [kind, ...files] = process.argv.slice(2);
  if (kind !== 'contract' || !files.length) {
    console.error('usage: node validate.cjs contract <file> [<file>...]');
    process.exit(1);
  }
  let bad = 0;
  for (const f of files) {
    let res;
    try { res = validateContract(yaml.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { res = { errors: [e.message], warnings: [] }; }
    for (const w of res.warnings) console.log(`${f}: warning: ${w}`);
    for (const e of res.errors) console.log(`${f}: error: ${e}`);
    if (res.errors.length) bad++; else console.log(`${f}: ok`);
  }
  process.exit(bad ? 2 : 0);
}
