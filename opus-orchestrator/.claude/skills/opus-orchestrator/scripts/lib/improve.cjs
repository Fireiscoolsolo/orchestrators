'use strict';
// improve.cjs: observations and controlled improvement proposals. See DESIGN.md sections 3.7 and 4.13.
//
// House rules enforced here:
// - Proposals are rule-based and evidence-backed; with too little evidence nothing is proposed.
// - The tool only ever edits one YAML key in a file under the skill's config/ directory. It never
//   rewrites SKILL.md, agents or references (those are `manual` proposals, never applied by the tool).
// - Nothing that touches security, weakens verification or enables self-modification can be applied:
//   such changes "must be changed by a person".
// - Nothing is applied without status `approved` recorded as coming from the user.
// - Every applied change is backed up under history/<old version>/, bumps VERSION and is logged in
//   CHANGELOG.md, and can be rolled back byte for byte.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store.cjs');
const yaml = require('./yaml.cjs');
const { redactSecrets } = require('./security.cjs');
const { DEFAULTS } = require('./config.cjs');

class ImproveError extends Error {
  constructor(code, message, errors) {
    super(message);
    this.name = 'ImproveError';
    this.code = code;
    if (errors) this.errors = errors;
  }
}

const CATEGORIES = [
  'worker_outcome', 'routing', 'verification_failure', 'debugging_pattern', 'context_duplication',
  'unnecessary_call', 'integration_conflict', 'retry_effectiveness', 'user_correction',
];

const PROPOSAL_CATEGORIES = [
  'task_decomposition', 'agent_instructions', 'specification_precision', 'verification_rules',
  'routing_heuristics', 'context_overhead', 'recovery_behavior', 'troubleshooting_procedure',
];

const PROPOSAL_STATUSES = ['proposed', 'approved', 'rejected', 'applied', 'rolled_back'];
const CHANGE_KINDS = ['config_set', 'manual'];
const RISKS = ['low', 'medium', 'high'];
const PERSON = 'must be changed by a person';
const ID_RE = /^IMP-\d{8}-\d{3,}$/;
const KEY_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const PASSED_STATES = ['APPROVED', 'INTEGRATING', 'COMPLETED'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function isoNow(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === 'string' && now) return now;
  return new Date().toISOString();
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function redactDeep(v) {
  if (typeof v === 'string') return redactSecrets(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (isPlain(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = redactDeep(v[k]);
    return out;
  }
  return v;
}

function oneLine(s) {
  return redactSecrets(String(s == null ? '' : s)).replace(/\s+/g, ' ').trim();
}

function getPath(obj, segs) {
  let cur = obj;
  for (const s of segs) {
    if (!isPlain(cur) || !Object.prototype.hasOwnProperty.call(cur, s)) return undefined;
    cur = cur[s];
  }
  return cur;
}

function band(complexity) {
  const c = Number(complexity);
  if (c <= 2) return '1-2';
  if (c <= 4) return '3-4';
  if (c <= 6) return '5-6';
  if (c <= 8) return '7-8';
  return '9-10';
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Atomic write for files inside the skill directory: no .bak is left behind in config/.
function writeSkillFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

function recordObservation(paths, obs, now) {
  const o = obs || {};
  if (!CATEGORIES.includes(o.category)) {
    throw new ImproveError('UNKNOWN_CATEGORY', `unknown observation category: ${o.category} (expected one of ${CATEGORIES.join(', ')})`);
  }
  const rec = {
    ts: isoNow(now),
    run_id: o.run_id == null ? null : String(o.run_id),
    task_id: o.task_id == null ? null : String(o.task_id),
    category: o.category,
    text: redactSecrets(o.text == null ? '' : String(o.text)),
    data: o.data === undefined ? null : redactDeep(clone(o.data)),
  };
  fs.mkdirSync(path.dirname(paths.observationsFile), { recursive: true });
  fs.appendFileSync(paths.observationsFile, JSON.stringify(rec) + '\n');
  return rec;
}

function readObservations(paths) {
  let text;
  try {
    text = fs.readFileSync(paths.observationsFile, 'utf8');
  } catch (_) {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (isPlain(v)) out.push(v);
    } catch (_) { /* skip unparseable lines */ }
  }
  return out;
}

function failedCommands(evidence) {
  if (!evidence || !Array.isArray(evidence.commands)) return [];
  return evidence.commands
    .filter((c) => c && (c.refused || c.timed_out || (c.exit_code !== 0 && c.exit_code !== undefined)))
    .map((c) => ({ command: redactSecrets(String(c.command)), exit_code: c.exit_code == null ? null : c.exit_code, timed_out: !!c.timed_out, refused: !!c.refused }));
}

/**
 * Derives observations from a run's task records (pure). Returns records shaped like those of
 * recordObservation (ts = run.updated_at); the caller persists them with recordObservation.
 */
function collectRunObservations(run, tasks) {
  const runId = run && run.run_id ? String(run.run_id) : null;
  const ts = (run && (run.updated_at || run.created_at)) || null;
  const out = [];
  const add = (task_id, category, text, data) => out.push({ ts, run_id: runId, task_id, category, text: redactSecrets(text), data: redactDeep(data) });

  for (const t of tasks || []) {
    if (!t || !t.task_id) continue;
    const attempts = Number(t.attempts) || 0;
    if (attempts < 1) continue; // never dispatched
    const routing = t.routing || {};
    const model = routing.model || t.assigned_model || null;
    const role = routing.role || t.assigned_role || null;
    const reviewRound = Number(t.review_round) || 0;
    const retries = Number(t.retries) || 0;
    const passed = PASSED_STATES.includes(t.status);
    const firstPass = passed && attempts === 1 && reviewRound === 0 && retries === 0;

    add(t.task_id, 'worker_outcome',
      `${t.task_id}: ${model} as ${role} at complexity ${t.complexity}; status ${t.status}, attempts ${attempts}, review rounds ${reviewRound}, first pass ${firstPass ? 'yes' : 'no'}`,
      { model, role, complexity: t.complexity == null ? null : t.complexity, attempts, review_round: reviewRound, first_pass: firstPass, retries, status: t.status || null });

    // Verification failures: every VERIFYING/INTEGRATING -> CORRECTION_REQUIRED transition, or the
    // stored evidence when the history does not show the failure.
    const evidence = t.evidence || {};
    const history = Array.isArray(t.history) ? t.history : [];
    for (const stage of ['verification', 'integration']) {
      const from = stage === 'verification' ? 'VERIFYING' : 'INTEGRATING';
      const fails = history.filter((h) => h && h.from === from && h.to === 'CORRECTION_REQUIRED');
      const ev = evidence[stage];
      const evFailed = !!(ev && ev.passed === false);
      const entries = fails.length > 0 ? fails : (evFailed ? [{ ts: ev.run_at || null, reason: null }] : []);
      entries.forEach((h, i) => {
        const latest = i === entries.length - 1;
        const cmds = latest && evFailed ? failedCommands(ev) : [];
        const what = cmds.length ? `; failing: ${cmds.map((c) => `${c.command} (exit ${c.exit_code})`).join(', ')}` : '';
        add(t.task_id, 'verification_failure',
          `${t.task_id}: ${stage} failed (${i + 1} of ${entries.length})${h.reason ? `: ${oneLine(h.reason)}` : ''}${what}`,
          { stage, model, complexity: t.complexity == null ? null : t.complexity, failure_index: i + 1, at: h.ts || null, failed_commands: cmds });
      });
    }

    if (retries > 0) {
      const recovered = passed;
      add(t.task_id, 'retry_effectiveness',
        `${t.task_id}: ${retries} retr${retries === 1 ? 'y' : 'ies'} on ${model}; ${recovered ? 'recovered' : `not recovered (status ${t.status})`}`,
        { model, retries, attempts, recovered, status: t.status || null, failure_kind: t.failure && t.failure.kind ? t.failure.kind : null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Proposal generation (rule-based, evidence-backed)
// ---------------------------------------------------------------------------

// Keeps the last observation per (category, run_id, task_id) so that collecting a run twice does
// not double the evidence. Observations without both ids are kept as they are.
function dedupe(observations, category) {
  const keyed = new Map();
  const loose = [];
  for (const o of observations || []) {
    if (!o || o.category !== category || !isPlain(o.data)) continue;
    if (o.run_id && o.task_id) keyed.set(`${o.run_id}\u0000${o.task_id}`, o);
    else loose.push(o);
  }
  return [...keyed.values(), ...loose];
}

function runList(obs) {
  const ids = [...new Set(obs.map((o) => o.run_id).filter(Boolean))].sort();
  if (ids.length === 0) return 'runs not recorded';
  const shown = ids.slice(0, 3).join(', ');
  return ids.length > 3 ? `runs ${shown} and ${ids.length - 3} more` : `run${ids.length > 1 ? 's' : ''} ${shown}`;
}

function routingRule(observations, config, minSamples) {
  const groups = new Map();
  for (const o of dedupe(observations, 'worker_outcome')) {
    const { model, complexity } = o.data;
    if (!nonEmptyString(model) || complexity == null || !Number.isFinite(Number(complexity))) continue;
    if (!KEY_SEGMENT_RE.test(model)) continue;
    const k = `${model}\u0000${band(complexity)}`;
    if (!groups.has(k)) groups.set(k, { model, band: band(complexity), obs: [] });
    groups.get(k).obs.push(o);
  }
  const drafts = [];
  for (const g of [...groups.values()].sort((a, b) => (a.model + a.band < b.model + b.band ? -1 : 1))) {
    const n = g.obs.length;
    if (n < minSamples) continue;
    const fp = g.obs.filter((o) => o.data.first_pass === true).length;
    if (fp * 2 >= n) continue; // first-pass rate is at least one half
    const attemptsTotal = g.obs.reduce((s, o) => s + (Number(o.data.attempts) || 0), 0);
    const mean = attemptsTotal / n;
    const proposed = Math.round(mean * 10) / 10;
    const key = `routing.heuristic_expected_attempts.${g.model}.${g.band}`;
    const current = getPath(config, key.split('.'));
    const evidence = [
      `${g.model} first-pass ${fp} of ${n} at complexity ${g.band} (worker_outcome observations from ${runList(g.obs)})`,
      `${g.model} mean attempts ${mean.toFixed(2)} over ${n} tasks at complexity ${g.band}; configured heuristic ${current === undefined ? 'not set' : current}`,
    ];
    const base = {
      category: 'routing_heuristics',
      evidence,
      target_file: 'config/routing.yaml',
      risk: 'low',
    };
    if (typeof current === 'number' && proposed > current) {
      drafts.push(Object.assign(base, {
        title: `Raise expected attempts for ${g.model} at complexity ${g.band} from ${current} to ${proposed}`,
        rationale: `${g.model} passed first time in ${fp} of ${n} observed tasks at complexity ${g.band} (below one half) and needed ${mean.toFixed(2)} attempts on average, more than the configured heuristic of ${current}. Raising the heuristic makes routing account for the extra attempts before enough observations exist to replace it.`,
        change: { kind: 'config_set', key, value: proposed },
      }));
    } else {
      drafts.push(Object.assign(base, {
        title: `Review routing of ${g.model} at complexity ${g.band}: first-pass ${fp} of ${n}`,
        rationale: `${g.model} passed first time in ${fp} of ${n} observed tasks at complexity ${g.band} (below one half), but the observed mean attempts (${mean.toFixed(2)}) do not exceed the configured heuristic (${current === undefined ? 'not set' : current}), so there is no evidence-backed value to set. A person should decide whether tasks in this band need a higher model floor or more precise specifications.`,
        change: { kind: 'manual', description: `Decide whether ${g.model} should keep receiving complexity ${g.band} tasks (for example by raising the model floor or tightening task specifications).` },
      }));
    }
  }
  return drafts;
}

function retryRule(observations, minSamples) {
  const obs = dedupe(observations, 'retry_effectiveness');
  const n = obs.length;
  if (n < minSamples) return [];
  const recovered = obs.filter((o) => o.data.recovered === true).length;
  if (recovered * 2 >= n) return [];
  return [{
    category: 'recovery_behavior',
    title: `Review automatic retries: ${recovered} of ${n} retried tasks recovered`,
    rationale: `Only ${recovered} of ${n} retried tasks reached approval after an automatic retry (below one half). A person should decide whether retries should be fewer, or whether failures should go to diagnosis or escalation sooner.`,
    evidence: [`${recovered} of ${n} retried tasks recovered (retry_effectiveness observations from ${runList(obs)})`],
    target_file: 'config/execution.yaml',
    change: { kind: 'manual', description: 'Review execution.max_retries and the escalation path for failed workers.' },
    risk: 'low',
  }];
}

function signature(p) {
  const c = p.change || {};
  return [p.category, p.target_file, c.kind, c.kind === 'config_set' ? c.key : p.title].join('\u0000');
}

/**
 * generateProposals(observations, config, now, {existing}) -> proposal[]
 * `existing` (optional): proposals already saved; their ids are not reused and a new proposal
 * identical in category, target and key to an open (proposed/approved) one is not generated again.
 */
function generateProposals(observations, config, now, opts) {
  const cfg = config || {};
  const o = opts || {};
  const ms = getPath(cfg, ['improvement', 'min_samples']);
  const minSamples = Number.isInteger(ms) && ms >= 1 ? ms : DEFAULTS.improvement.min_samples;
  const created = isoNow(now);
  const day = created.slice(0, 10).replace(/-/g, '');
  const existing = Array.isArray(o.existing) ? o.existing.filter(isPlain) : [];
  const open = new Set(existing.filter((p) => p.status === 'proposed' || p.status === 'approved').map(signature));
  let seq = 0;
  for (const p of existing) {
    const m = typeof p.id === 'string' && p.id.match(/^IMP-(\d{8})-(\d+)$/);
    if (m && m[1] === day) seq = Math.max(seq, Number(m[2]));
  }

  const drafts = [...routingRule(observations, cfg, minSamples), ...retryRule(observations, minSamples)];
  const out = [];
  for (const d of drafts) {
    if (open.has(signature(d))) continue;
    seq += 1;
    const p = {
      id: `IMP-${day}-${String(seq).padStart(3, '0')}`,
      created,
      category: d.category,
      title: d.title,
      rationale: d.rationale,
      evidence: d.evidence,
      target_file: d.target_file,
      change: d.change,
      risk: d.risk,
      status: 'proposed',
      approved_by: null,
      weakens_safety: false,
    };
    const v = validateProposal(p, { config: cfg });
    if (!v.ok) throw new ImproveError('INTERNAL', `generated proposal failed validation: ${v.errors.join('; ')}`, v.errors);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function checkTargetFile(t, errors) {
  if (!nonEmptyString(t)) {
    errors.push('target_file must be a non-empty path relative to the skill directory');
    return null;
  }
  if (t.includes('..')) errors.push(`target_file must not contain "..": ${t}`);
  if (/^[\\/]/.test(t) || /^[A-Za-z]:/.test(t) || t.startsWith('~') || path.isAbsolute(t)) {
    errors.push(`target_file must be relative to the skill directory, not absolute: ${t}`);
  }
  return t.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
}

function lookupCurrent(config, segs) {
  const v = config ? getPath(config, segs) : undefined;
  return v === undefined ? getPath(DEFAULTS, segs) : v;
}

// Rules that keep safety-relevant settings in human hands.
function checkConfigSet(change, target, config, errors) {
  const key = change.key;
  if (!nonEmptyString(key)) {
    errors.push('change.key must be a non-empty dotted key for config_set');
    return;
  }
  const segs = key.split('.');
  if (segs.length < 2 || !segs.every((s) => KEY_SEGMENT_RE.test(s))) {
    errors.push(`change.key must be a dotted path of section and key names: ${key}`);
    return;
  }
  if (segs.some((s) => FORBIDDEN_SEGMENTS.has(s))) {
    errors.push(`change.key contains a forbidden name: ${key}`);
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(change, 'value') || change.value === undefined) {
    errors.push('change.value is required for config_set');
  }
  const value = change.value;

  if (target !== null && !/^config\/[^/]+\.ya?ml$/.test(target)) {
    errors.push(`config_set targets ${target}, outside config/: ${PERSON}`);
  }
  if (segs[0] === 'security') {
    errors.push(`config_set of ${key} (security settings) ${PERSON}`);
  }
  if (key === 'improvement.auto_modify_core_skill') {
    errors.push(`config_set of improvement.auto_modify_core_skill ${PERSON}`);
  }
  if (key === 'execution.max_review_rounds' || key === 'execution.max_retries') {
    if (!Number.isInteger(value) || value < 0) {
      errors.push(`config_set of ${key} must be a non-negative integer`);
    } else if (value > 10) {
      errors.push(`config_set of ${key} above 10 ${PERSON}`);
    }
  }
  if (key === 'execution.independent_verification') {
    errors.push(`config_set of ${key} (verification requirement) ${PERSON}`);
  }
  if (segs[0] === 'verification') {
    const isMinComplexity = segs.length === 5 && segs[1] === 'modes' && segs[3] === 'independent_review' && segs[4] === 'min_complexity';
    if (!isMinComplexity) {
      errors.push(`config_set of ${key} (verification requirement) ${PERSON}`);
    } else {
      const current = lookupCurrent(config, segs);
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`config_set of ${key} must be a number; ${PERSON}`);
      } else if (typeof current !== 'number') {
        errors.push(`config_set of ${key}: current value is unknown, so a raise cannot be ruled out; ${PERSON}`);
      } else if (value > current) {
        errors.push(`config_set raises ${key} from ${current} to ${value} (fewer independent reviews): ${PERSON}`);
      }
    }
  }
}

/**
 * validateProposal(p, {config}) -> {ok, errors}
 * `config` (optional) supplies current values for comparisons such as an independent_review
 * min_complexity raise; DEFAULTS are used for keys it does not contain.
 */
function validateProposal(p, opts) {
  const errors = [];
  const config = opts && opts.config;
  if (!isPlain(p)) return { ok: false, errors: ['proposal must be a mapping'] };

  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) errors.push(`id must look like IMP-YYYYMMDD-NNN: ${p.id}`);
  if (!nonEmptyString(p.created) || Number.isNaN(Date.parse(p.created))) errors.push('created must be an ISO-8601 timestamp');
  if (!PROPOSAL_CATEGORIES.includes(p.category)) errors.push(`unknown category: ${p.category}`);
  if (!nonEmptyString(p.title)) errors.push('title must be a non-empty string');
  if (!nonEmptyString(p.rationale)) errors.push('rationale must be a non-empty string');
  if (!Array.isArray(p.evidence) || p.evidence.length === 0) {
    errors.push('evidence must be a non-empty list');
  } else if (!p.evidence.every(nonEmptyString)) {
    errors.push('every evidence entry must be a non-empty string');
  }
  const target = checkTargetFile(p.target_file, errors);
  if (!RISKS.includes(p.risk)) errors.push(`unknown risk: ${p.risk}`);
  if (!PROPOSAL_STATUSES.includes(p.status)) errors.push(`unknown status: ${p.status}`);
  if (p.approved_by !== null && p.approved_by !== undefined && typeof p.approved_by !== 'string') {
    errors.push('approved_by must be null or a string');
  }
  if (['approved', 'applied', 'rolled_back'].includes(p.status) && p.approved_by !== 'user') {
    errors.push(`status ${p.status} requires approved_by: user`);
  }
  if (p.weakens_safety !== false) errors.push(`weakens_safety must be false (got ${JSON.stringify(p.weakens_safety)}); a change that weakens safety ${PERSON}`);

  const c = p.change;
  if (!isPlain(c)) {
    errors.push('change must be a mapping with a kind');
  } else if (!CHANGE_KINDS.includes(c.kind)) {
    errors.push(`unknown change kind: ${c.kind}`);
  } else if (c.kind === 'config_set') {
    checkConfigSet(c, target, config, errors);
  } else if (!nonEmptyString(c.description)) {
    errors.push('a manual change needs a non-empty description');
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function proposalFile(paths, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new ImproveError('BAD_ID', `invalid proposal id: ${id}`);
  return path.join(paths.proposalsDir, `${id}.yaml`);
}

function saveProposal(paths, proposal, opts) {
  const v = validateProposal(proposal, opts);
  if (!v.ok) throw new ImproveError('INVALID_PROPOSAL', `invalid proposal: ${v.errors.join('; ')}`, v.errors);
  const p = redactDeep(clone(proposal));
  fs.mkdirSync(paths.proposalsDir, { recursive: true });
  store.atomicWrite(proposalFile(paths, p.id), yaml.stringify(p));
  return p;
}

function loadProposal(paths, id) {
  const file = proposalFile(paths, id);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new ImproveError('NO_PROPOSAL', `proposal not found: ${id}`);
    throw e;
  }
  const p = yaml.parse(text);
  if (!isPlain(p)) throw new ImproveError('INVALID_PROPOSAL', `proposal file is not a mapping: ${id}`);
  return p;
}

function listProposals(paths) {
  let names;
  try {
    names = fs.readdirSync(paths.proposalsDir);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const n of names.filter((x) => x.endsWith('.yaml')).sort()) {
    const id = n.slice(0, -5);
    if (!ID_RE.test(id)) continue;
    try {
      out.push(loadProposal(paths, id));
    } catch (_) { /* unreadable proposal files are skipped */ }
  }
  return out;
}

function pushHistory(p, from, to, by, ts) {
  p.history = Array.isArray(p.history) ? p.history : [];
  p.history.push({ ts, from, to, by: by == null ? null : String(by) });
}

// Allowed status changes through setProposalStatus; applied/rolled_back only via apply/rollback.
const STATUS_FROM = {
  approved: ['proposed'],
  rejected: ['proposed', 'approved'],
  proposed: ['rejected'],
};

function setProposalStatus(paths, id, status, opts) {
  const o = opts || {};
  if (!PROPOSAL_STATUSES.includes(status)) throw new ImproveError('BAD_STATUS', `unknown status: ${status}`);
  if (status === 'applied' || status === 'rolled_back') {
    throw new ImproveError('BAD_STATUS', `status ${status} is set only by applyProposal/rollbackProposal`);
  }
  if (status === 'approved' && o.by !== 'user') {
    throw new ImproveError('NOT_USER', `approval must be recorded as coming from the user (by: user), got by: ${o.by}`);
  }
  return store.withLock(paths, () => {
    const p = loadProposal(paths, id);
    if (!STATUS_FROM[status].includes(p.status)) {
      throw new ImproveError('BAD_STATUS', `cannot change ${id} from ${p.status} to ${status}`);
    }
    const ts = isoNow(o.now);
    pushHistory(p, p.status, status, o.by, ts);
    p.status = status;
    p.approved_by = status === 'approved' ? 'user' : null;
    if (status === 'approved') p.approved_at = ts;
    return saveProposal(paths, p, { config: o.config });
  });
}

// ---------------------------------------------------------------------------
// Apply and rollback
// ---------------------------------------------------------------------------

function readVersion(skillDir) {
  const file = path.join(skillDir, 'VERSION');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    throw new ImproveError('BAD_VERSION', `VERSION file not found in ${skillDir}`);
  }
  const v = text.trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new ImproveError('BAD_VERSION', `VERSION is not MAJOR.MINOR.PATCH: ${v}`);
  return { file, text, version: v };
}

function bumpPatch(v) {
  const [a, b, c] = v.split('.').map(Number);
  return `${a}.${b}.${c + 1}`;
}

// Resolves a skill-relative path and proves it stays under `under` (also through symlinks).
function resolveInside(skillDir, rel, under) {
  const root = path.resolve(skillDir, under);
  const abs = path.resolve(skillDir, rel);
  const r = path.relative(root, abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) {
    throw new ImproveError('BAD_TARGET', `${rel} is not inside ${under}/ of the skill`);
  }
  if (fs.existsSync(abs)) {
    const realRoot = fs.realpathSync(root);
    const rr = path.relative(realRoot, fs.realpathSync(abs));
    if (!rr || rr.startsWith('..') || path.isAbsolute(rr)) {
      throw new ImproveError('BAD_TARGET', `${rel} resolves outside ${under}/ of the skill`);
    }
  }
  return abs;
}

function appendChangelog(skillDir, lines) {
  const file = path.join(skillDir, 'CHANGELOG.md');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    text = '# Changelog\n';
  }
  if (!text.endsWith('\n')) text += '\n';
  text += '\n' + lines.map((l) => redactSecrets(l)).join('\n') + '\n';
  writeSkillFile(file, text);
}

function flatten(v, prefix, out) {
  if (isPlain(v) && Object.keys(v).length > 0) {
    for (const k of Object.keys(v)) flatten(v[k], prefix.concat(k), out);
  } else {
    out.set(JSON.stringify(prefix), JSON.stringify(v));
  }
  return out;
}

// Paths (as JSON-encoded segment arrays) whose value differs between a and b.
function changedLeaves(a, b) {
  const fa = flatten(a, [], new Map());
  const fb = flatten(b, [], new Map());
  const keys = new Set([...fa.keys(), ...fb.keys()]);
  return [...keys].filter((k) => fa.get(k) !== fb.get(k));
}

function applyProposal(paths, skillDir, id, now) {
  const ts = isoNow(now);
  const date = ts.slice(0, 10);
  const skill = path.resolve(skillDir);
  return store.withLock(paths, () => {
    const p = loadProposal(paths, id);
    if (!isPlain(p.change) || p.change.kind === 'manual') {
      throw new ImproveError('MANUAL_ONLY', `${id} is a manual proposal; the tool never applies manual changes, a person must make them`);
    }
    if (p.status !== 'approved' || p.approved_by !== 'user') {
      throw new ImproveError('NOT_APPROVED', `${id} has status ${p.status}${p.approved_by ? ` (approved_by ${p.approved_by})` : ''}; only proposals approved by the user are applied`);
    }
    const target = String(p.target_file).replace(/\\/g, '/');
    if (target.includes('..')) throw new ImproveError('BAD_TARGET', `target_file must not contain "..": ${target}`);
    const targetAbs = resolveInside(skill, target, 'config');
    let original;
    try {
      original = fs.readFileSync(targetAbs);
    } catch (_) {
      throw new ImproveError('BAD_TARGET', `target file not found: ${target}`);
    }
    const parsed = yaml.parse(original.toString('utf8'));
    if (!isPlain(parsed)) throw new ImproveError('BAD_TARGET', `${target} is not a YAML mapping`);
    // Re-validate against the file as it is now (it may have been edited since approval).
    const v = validateProposal(p, { config: parsed });
    if (!v.ok) throw new ImproveError('INVALID_PROPOSAL', `invalid proposal: ${v.errors.join('; ')}`, v.errors);

    const segs = p.change.key.split('.');
    const parent = getPath(parsed, segs.slice(0, -1));
    if (!isPlain(parent)) {
      throw new ImproveError('BAD_KEY', `${segs.slice(0, -1).join('.')} is not a mapping in ${target}; the tool only sets keys inside existing sections`);
    }
    const leaf = segs[segs.length - 1];
    const previous = Object.prototype.hasOwnProperty.call(parent, leaf) ? parent[leaf] : null;
    const updated = clone(parsed);
    getPath(updated, segs.slice(0, -1))[leaf] = clone(p.change.value);

    const ver = readVersion(skill);
    const header = [
      `# Edited by improvement proposal ${p.id} on ${date}: ${p.change.key} set to ${JSON.stringify(p.change.value)}.`,
      '# Written by opus-orchestrator improve.cjs; comments from the previous version are kept only in',
      `# the backup history/${ver.version}/${target}.`,
    ];
    const newText = header.join('\n') + '\n' + yaml.stringify(updated);

    // Prove that exactly the named key changed before touching anything: every differing leaf
    // must be the key itself or lie below it (when the value is a mapping).
    const reparsed = yaml.parse(newText);
    const diff = changedLeaves(parsed, reparsed);
    const okDiff = diff.every((d) => {
      const s = JSON.parse(d);
      return s.length >= segs.length && segs.every((x, i) => s[i] === x);
    });
    if (!okDiff || JSON.stringify(getPath(reparsed, segs)) !== JSON.stringify(p.change.value)) {
      throw new ImproveError('EDIT_MISMATCH', `editing ${p.change.key} in ${target} would change other keys: ${diff.join(', ')}`);
    }

    const newVersion = bumpPatch(ver.version);
    const backupRel = `history/${ver.version}/${target}`;
    const backupAbs = resolveInside(skill, backupRel, 'history');
    if (fs.existsSync(backupAbs) && !fs.readFileSync(backupAbs).equals(original)) {
      throw new ImproveError('BACKUP_EXISTS', `a different backup already exists at ${backupRel}; refusing to overwrite it`);
    }
    const changelogFile = path.join(skill, 'CHANGELOG.md');
    const changelogBefore = fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile) : null;

    fs.mkdirSync(path.dirname(backupAbs), { recursive: true });
    fs.copyFileSync(targetAbs, backupAbs);
    if (!fs.readFileSync(backupAbs).equals(original)) {
      throw new ImproveError('BACKUP_FAILED', `backup of ${target} does not match the original`);
    }
    try {
      writeSkillFile(targetAbs, newText);
      writeSkillFile(ver.file, newVersion + '\n');
      appendChangelog(skill, [
        `## ${newVersion} - ${date}`,
        '',
        `- Applied improvement proposal ${p.id} (${p.category}, approved by the user): ${oneLine(p.title)}`,
        `  - Change: set \`${p.change.key}\` in ${target} from ${JSON.stringify(previous)} to ${JSON.stringify(p.change.value)}.`,
        `  - Rationale: ${oneLine(p.rationale)}`,
        `  - Evidence: ${p.evidence.map(oneLine).join('; ')}`,
        `  - Backup: ${backupRel} (version ${ver.version}). ${target} was rewritten by the YAML serializer, so comments in the previous version are preserved only in this backup.`,
        `  - Roll back with: oo proposals rollback ${p.id}`,
      ]);
      pushHistory(p, 'approved', 'applied', 'tool', ts);
      p.status = 'applied';
      p.applied = {
        at: ts,
        changed_file: target,
        key: p.change.key,
        previous_value: previous,
        new_value: clone(p.change.value),
        backup: backupRel,
        version_before: ver.version,
        version_after: newVersion,
        result_sha256: sha256(Buffer.from(newText, 'utf8')),
      };
      saveProposal(paths, p, { config: parsed });
    } catch (e) {
      // Undo partial changes so the skill stays consistent.
      try { writeSkillFile(targetAbs, original); } catch (_) { /* ignore */ }
      try { writeSkillFile(ver.file, ver.text); } catch (_) { /* ignore */ }
      try {
        if (changelogBefore) writeSkillFile(changelogFile, changelogBefore);
        else if (fs.existsSync(changelogFile)) fs.unlinkSync(changelogFile);
      } catch (_) { /* ignore */ }
      throw e;
    }
    return { changed_file: target, backup: backupRel, version: newVersion, previous_version: ver.version };
  });
}

function rollbackProposal(paths, skillDir, id, now) {
  const ts = isoNow(now);
  const date = ts.slice(0, 10);
  const skill = path.resolve(skillDir);
  return store.withLock(paths, () => {
    const p = loadProposal(paths, id);
    if (p.status !== 'applied' || !isPlain(p.applied)) {
      throw new ImproveError('NOT_APPLIED', `${id} has status ${p.status}; only applied proposals can be rolled back`);
    }
    const a = p.applied;
    const target = String(a.changed_file || '').replace(/\\/g, '/');
    if (!nonEmptyString(target) || target.includes('..')) throw new ImproveError('BAD_TARGET', `invalid changed_file recorded in ${id}`);
    const targetAbs = resolveInside(skill, target, 'config');
    const backupRel = String(a.backup || '').replace(/\\/g, '/');
    if (!nonEmptyString(backupRel) || backupRel.includes('..')) throw new ImproveError('NO_BACKUP', `invalid backup recorded in ${id}`);
    const backupAbs = resolveInside(skill, backupRel, 'history');
    let backup;
    try {
      backup = fs.readFileSync(backupAbs);
    } catch (_) {
      throw new ImproveError('NO_BACKUP', `backup not found: ${backupRel}`);
    }
    if (a.result_sha256 && fs.existsSync(targetAbs)) {
      const cur = sha256(fs.readFileSync(targetAbs));
      if (cur !== a.result_sha256) {
        throw new ImproveError('CHANGED_SINCE', `${target} changed after ${id} was applied (a later proposal or a manual edit); roll back later changes first or restore ${backupRel} by hand`);
      }
    }
    const ver = readVersion(skill);
    writeSkillFile(targetAbs, backup);
    if (!fs.readFileSync(targetAbs).equals(backup)) {
      throw new ImproveError('RESTORE_FAILED', `restored ${target} does not match ${backupRel}`);
    }
    appendChangelog(skill, [
      `## ${ver.version} - ${date} (rollback; VERSION unchanged)`,
      '',
      `- Rolled back improvement proposal ${p.id} (${p.category}): ${oneLine(p.title)}`,
      `  - Restored ${target} byte for byte from ${backupRel}; \`${a.key}\` is back to ${JSON.stringify(a.previous_value)}.`,
      `  - Rationale of the rolled-back change: ${oneLine(p.rationale)}`,
    ]);
    pushHistory(p, 'applied', 'rolled_back', 'tool', ts);
    p.status = 'rolled_back';
    p.rolled_back = { at: ts, restored_from: backupRel, version: ver.version };
    let restoredConfig;
    try { restoredConfig = yaml.parse(backup.toString('utf8')); } catch (_) { restoredConfig = undefined; }
    saveProposal(paths, p, { config: isPlain(restoredConfig) ? restoredConfig : undefined });
    return { restored_file: target, backup: backupRel, version: ver.version };
  });
}

module.exports = {
  CATEGORIES,
  PROPOSAL_CATEGORIES,
  PROPOSAL_STATUSES,
  recordObservation,
  readObservations,
  collectRunObservations,
  generateProposals,
  validateProposal,
  saveProposal,
  listProposals,
  loadProposal,
  setProposalStatus,
  applyProposal,
  rollbackProposal,
  ImproveError,
};
