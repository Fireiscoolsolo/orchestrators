#!/usr/bin/env node
'use strict';
// oo.cjs: the opus-orchestrator command line (DESIGN.md sections 5 and 6).
//
// A dispatcher over small command functions. State logic lives in scripts/lib/: the state
// machine guards every transition, the store writes atomically, and every state-changing
// command appends to events.jsonl and rewrites checkpoint.yaml before it returns.
//
// Exit codes: 0 success; 1 refused (an invariant, limit or validation failed; the message names
// the cause and what to do next); 2 usage error. Output is plain text for the orchestrator
// model; every successful command ends with a NEXT line.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const store = require('./lib/store.cjs');
const yaml = require('./lib/yaml.cjs');
const configLib = require('./lib/config.cjs');
const sm = require('./lib/statemachine.cjs');
const specLib = require('./lib/spec.cjs');
const routing = require('./lib/routing.cjs');
const scheduler = require('./lib/scheduler.cjs');
const reports = require('./lib/reports.cjs');
const verify = require('./lib/verify.cjs');
const budget = require('./lib/budget.cjs');
const gitops = require('./lib/gitops.cjs');
const checkpoint = require('./lib/checkpoint.cjs');
const improve = require('./lib/improve.cjs');
const cliargs = require('./lib/cliargs.cjs');
const packages = require('./lib/packages.cjs');
const reportgen = require('./lib/reportgen.cjs');
const workspace = require('./lib/workspace.cjs');
const security = require('./lib/security.cjs');

const SKILL_DIR = path.resolve(__dirname, '..');
const MODEL_ORDER = ['haiku', 'sonnet', 'opus'];
const FAILURE_KINDS = ['crash', 'invalid_output', 'permission', 'rate_limit', 'context', 'timeout', 'tool', 'budget'];
const AUTH_LIMITS = ['agent_call_limit', 'token_limit', 'cost_limit_usd', 'max_review_rounds', 'max_retries'];
const LIST_FIELDS = ['dependencies', 'authorized_files', 'acceptance_criteria', 'deliverables', 'verification',
  'verification_commands', 'constraints', 'tool_permissions'];
const SPEC_KEYS = ['task_id', 'title', 'objective', 'kind', 'priority', 'complexity', 'complexity_factors', 'risk',
  'dependencies', 'assigned_model', 'assigned_role', 'authorized_files', 'acceptance_criteria', 'deliverables',
  'verification', 'verification_commands', 'context', 'constraints', 'tool_permissions', 'security_sensitive',
  'side_effects', 'exclusive'];

// ---------------------------------------------------------------------------
// Errors and output
// ---------------------------------------------------------------------------

class Refusal extends Error {
  constructor(what, why, next) {
    super(`${what}: ${Array.isArray(why) ? why.join('; ') : why}`);
    this.name = 'Refusal';
    this.code = 'REFUSED';
    this.what = what;
    this.why = why;
    this.next = next;
  }
}

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.code = 'USAGE';
  }
}

function refuse(what, why, next) {
  throw new Refusal(what, why, next);
}

function usage(message) {
  throw new UsageError(message);
}

function makeEnv() {
  return {
    paths: store.resolvePaths(),
    home: process.env.OPUS_ORCH_HOME || os.homedir(),
    out: [],
  };
}

function say(env, ...lines) {
  for (const l of lines) {
    if (Array.isArray(l)) env.out.push(...l);
    else env.out.push(String(l));
  }
}

function nowIso() {
  return new Date().toISOString();
}

function oneLine(s, max = 200) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

function indent(text, pad = '  ') {
  return String(text || '').split(/\r?\n/).map((l) => pad + l);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function runDir(env, runId) {
  return path.join(env.paths.runsDir, runId);
}

/** Forward-slash path relative to the project root when inside it, else absolute. */
function relProject(env, abs) {
  const rel = workspace.relInside(env.paths.projectDir, abs);
  return rel || path.resolve(abs).split(path.sep).join('/');
}

/**
 * A file a worker reported by absolute path inside the project (or inside its own worktree) becomes
 * project-relative with forward slashes, so one file is listed once however the worker wrote it.
 */
function relativizeReported(env, files, roots) {
  const norm = (p) => security.normalizePath(path.resolve(p)).replace(/\/+$/, '');
  const rootList = [env.paths.projectDir].concat(roots || []).filter(Boolean).map(norm).sort((x, y) => y.length - x.length);
  const out = [];
  for (const raw of files || []) {
    let f = security.normalizePath(raw);
    if (/^[A-Za-z]:\//.test(f) || f.startsWith('/')) {
      const fold = /^[A-Za-z]:/.test(f) || process.platform === 'win32'; // drive paths are case-insensitive
      for (const root of rootList) {
        const inside = fold ? f.toLowerCase().startsWith(`${root.toLowerCase()}/`) : f.startsWith(`${root}/`);
        if (inside) { f = f.slice(root.length + 1); break; }
      }
    }
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

function absProject(env, p) {
  return path.resolve(env.paths.projectDir, p);
}

function writeRunFile(env, runId, rel, text) {
  const file = path.join(runDir(env, runId), ...rel.split('/'));
  store.atomicWrite(file, text);
  return file;
}

// ---------------------------------------------------------------------------
// Run context
// ---------------------------------------------------------------------------

function sortTasks(list) {
  return list.slice().sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
}

function openRun(env) {
  let run;
  try {
    run = store.loadRun(env.paths);
  } catch (e) {
    if (e.code === 'NO_RUN') refuse('no current run', e.message, 'start a run with: oo init <objective>');
    throw e;
  }
  let tasks;
  try {
    tasks = store.listTasks(env.paths, run.run_id);
  } catch (e) {
    if (e.code === 'CORRUPT') refuse('the run state is unreadable', e.message, 'oo resume (it restores files from their backups and reports what it cannot restore)');
    throw e;
  }
  const ctx = {
    env, paths: env.paths, run, tasks, byId: new Map(), now: nowIso(), dirty: new Set(), events: [],
    cfg: run.config && run.config.execution ? run.config : configLib.DEFAULTS,
  };
  for (const t of tasks) ctx.byId.set(t.task_id, t);
  if (!run.usage || typeof run.usage.agent_calls !== 'number') run.usage = budget.newUsage();
  if (!Array.isArray(run.authorizations)) run.authorizations = [];
  if (!Array.isArray(run.decisions)) run.decisions = [];
  return ctx;
}

function setTask(ctx, t) {
  ctx.byId.set(t.task_id, t);
  ctx.tasks = sortTasks([...ctx.byId.values()]);
  ctx.dirty.add(t.task_id);
  return t;
}

function touch(ctx, t) {
  ctx.dirty.add(t.task_id);
  return t;
}

function getTask(ctx, id) {
  if (!id) usage('a task id is required');
  const t = ctx.byId.get(id);
  if (!t) {
    const known = ctx.tasks.map((x) => x.task_id);
    refuse(`no task ${id}`, `this run has ${known.length ? `the tasks ${known.join(', ')}` : 'no tasks'}`, known.length ? 'use one of those ids (oo status lists them)' : 'plan tasks with: oo plan --file <specs.yaml>');
  }
  return t;
}

function updatePhase(ctx) {
  const r = ctx.run;
  const ts = ctx.tasks;
  if (r.delivered) r.phase = 'delivered';
  else if (!ts.length) r.phase = 'planning';
  else if (ts.every((t) => sm.isTerminal(t.status))) r.phase = 'finished';
  else if (ts.some((t) => (t.attempts || 0) > 0)) r.phase = 'executing';
  else r.phase = 'planned';
}

function writeCheckpointFor(ctx) {
  return checkpoint.writeCheckpoint(ctx.paths, ctx.run.run_id, checkpoint.buildCheckpoint(ctx.run, ctx.tasks, ctx.now));
}

/** Saves changed tasks and the run, appends events and rewrites checkpoint.yaml. */
function persist(ctx, commandEvent) {
  store.assertLockHeld(ctx.paths); // a write without the lock (or after losing it) is refused
  for (const id of ctx.dirty) store.saveTask(ctx.paths, ctx.run.run_id, ctx.byId.get(id));
  updatePhase(ctx);
  store.saveRun(ctx.paths, ctx.run);
  for (const e of ctx.events) store.appendEvent(ctx.paths, ctx.run.run_id, e);
  if (commandEvent) store.appendEvent(ctx.paths, ctx.run.run_id, Object.assign({ type: 'command' }, commandEvent));
  writeCheckpointFor(ctx);
  ctx.dirty.clear();
  ctx.events = [];
}

function locked(env, fn) {
  return store.withLock(env.paths, fn, { command: env.command || null });
}

function limits(ctx) {
  const o = ctx.run.options || {};
  const auth = (name) => ctx.run.authorizations
    .filter((a) => a && a.by === 'user' && a.limit === name && Number.isFinite(a.value))
    .map((a) => a.value);
  return {
    max_workers: o.max_workers,
    max_review_rounds: Math.max(o.max_review_rounds, ...auth('max_review_rounds')),
    max_retries: Math.max(o.max_retries, ...auth('max_retries')),
    mode: o.mode,
  };
}

function budgetCheck(ctx) {
  return budget.check(ctx.run.usage, ctx.cfg.budget, ctx.run.authorizations);
}

function nextActionsFor(ctx) {
  return checkpoint.nextActions(ctx.run, ctx.tasks);
}

function firstNext(ctx, fallback) {
  const a = nextActionsFor(ctx);
  return a.length ? a[0] : fallback;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function unmetDeps(ctx, task) {
  return (task.dependencies || []).filter((d) => {
    const t = ctx.byId.get(d);
    return !t || t.status !== 'COMPLETED';
  });
}

function transitionRefusal(ctx, task, to, e) {
  const id = task.task_id;
  const lim = limits(ctx);
  const table = {
    INVALID_TRANSITION: [`${id} is ${task.status}; the state machine does not allow ${task.status} -> ${to}`, `run oo status and follow the next action listed for ${id}`],
    DEPS_UNSATISFIED: [`dependencies of ${id} are not COMPLETED: ${unmetDeps(ctx, task).join(', ')}`, 'complete those tasks first (oo status lists them)'],
    RETRY_LIMIT: [`${id} has used ${task.retries || 0} of ${lim.max_retries} retries`, `oo fail ${id} --reason <text>, then oo escalate ${id} --model <stronger model> --reason <text>, or ask the user`],
    UNSAFE_RETRY: [`${id} has external side effects; it is never retried automatically`, `check what the worker already did, then oo fail ${id} --reason <text> or ask the user`],
    VERIFICATION_FAILED: [`verification of ${id} has not passed`, `oo verify ${id}`],
    UNVERIFIED: [`verification of ${id} has not passed in the current round`, `oo verify ${id}`],
    NO_APPROVAL: [`the latest review by the orchestrator does not approve ${id}`, `oo review ${id} --stdin with reviewer orchestrator and verdict approve`],
    NO_INDEPENDENT_REVIEW: [`${id} requires an approving independent review in the current round and none is recorded`, `oo review-package ${id}, launch the reviewer, record its report with oo review ${id} --stdin, then approve again`],
    NO_CORRECTION: [`${id} has no pending correction request`, `oo correct ${id} --stdin`],
    CORRECTION_LIMIT: [`${id} has used ${task.review_round || 0} of ${lim.max_review_rounds} correction rounds`, `diagnose it; oo fail ${id} --reason <text> then oo escalate, or oo block ${id} --reason <text> and ask the user`],
    INTEGRATION_FAILED: [`integration of ${id} has not passed`, `oo integrate ${id}`],
    NOT_AUTHORIZED: [`moving ${id} from ${task.status} to ${to} needs the user's authorization (or an escalation)`, `ask the user; only when the user has said so, repeat with --user-authorized`],
    REASON_REQUIRED: [`moving ${id} to ${to} needs a reason`, 'repeat with --reason <text>'],
  };
  const [why, next] = table[e.code] || [e.message, 'run oo status'];
  return new Refusal(`${id} cannot move from ${task.status} to ${to}`, `${e.code}: ${why}`, next);
}

function move(ctx, task, to, x = {}) {
  const c = {
    now: ctx.now,
    reason: x.reason,
    actor: x.actor || 'orchestrator',
    kind: x.kind,
    depsCompleted: scheduler.depsCompleted(task, ctx.byId),
    limits: x.limits || limits(ctx),
    userAuthorized: x.userAuthorized === true,
    escalated: x.escalated === true,
    requiresIndependentReview: x.requiresIndependentReview === true,
  };
  let next;
  try {
    next = sm.transition(task, to, c);
  } catch (e) {
    if (e instanceof sm.TransitionError) throw transitionRefusal(ctx, task, to, e);
    throw e;
  }
  setTask(ctx, next);
  ctx.events.push({ type: 'transition', task_id: task.task_id, from: task.status, to, reason: x.reason || null });
  return next;
}

/** Moves the current round's evidence into evidence.rounds[] so guards only see fresh evidence. */
function archiveRound(ctx, t, reason) {
  const ev = t.evidence || (t.evidence = {});
  const has = ev.verification || (ev.reviews || []).length || (ev.checks || []).length || ev.integration || ev.self_check
    || (ev.review_packages || []).length;
  if (!has) return false;
  ev.rounds = (ev.rounds || []).concat([{
    round: t.review_round || 0,
    archived_at: ctx.now,
    reason,
    self_check: ev.self_check || null,
    verification: ev.verification || null,
    checks: ev.checks || [],
    review_packages: ev.review_packages || [],
    reviews: ev.reviews || [],
    integration: ev.integration || null,
  }]);
  ev.self_check = null;
  ev.verification = null;
  ev.reviews = [];
  ev.checks = [];
  ev.review_packages = [];
  ev.integration = null;
  touch(ctx, t);
  return true;
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

function readInput(a, required = true) {
  if (a.opts.stdin) return fs.readFileSync(0, 'utf8');
  if (a.opts.file !== undefined) {
    try {
      return fs.readFileSync(path.resolve(String(a.opts.file)), 'utf8');
    } catch (e) {
      refuse('cannot read the input file', `${a.opts.file}: ${e.message}`, 'check the path and repeat the command');
    }
  }
  if (required) usage('this command reads its input from --stdin or --file <path>');
  return null;
}

function needReason(a) {
  const r = a.opts.reason;
  if (typeof r !== 'string' || !r.trim()) usage('--reason <text> is required');
  return r.trim();
}

function parseReportBlock(text, what, id, next) {
  const block = yaml.extractYamlBlock(text);
  if (block === null) {
    refuse(`${what} for ${id} rejected; task state unchanged`, 'no report block found: the input must end with a fenced ```yaml block (or start with task_id:)', next);
  }
  try {
    return yaml.parse(block);
  } catch (e) {
    refuse(`${what} for ${id} rejected; task state unchanged`, `the report block is not valid YAML (line ${e.line || '?'} of the yaml block): ${String(e.message).replace(/ \(line \d+\)$/, '')}`,
      `ask the agent to resend the report with every evidence string, command and path in single quotes ('...') and forward slashes in paths, then repeat oo ${what} ${id} --stdin; or ${next}`);
  }
  return null;
}

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Errors for list items that YAML parsed as mappings because they contain ": ". */
function mappingHints(raw) {
  const out = [];
  if (!isPlain(raw)) return out;
  for (const f of LIST_FIELDS) {
    if (!Array.isArray(raw[f])) continue;
    raw[f].forEach((item, i) => {
      if (!isPlain(item)) return;
      const text = Object.entries(item).map(([k, v]) => `${k}: ${v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
      out.push(`${f}[${i}] was parsed as a mapping (${JSON.stringify(item)}) because the item contains ": " (a colon followed by a space). Quote the whole item, for example: - ${JSON.stringify(text)}`);
    });
  }
  return out;
}

function readStats(ctx) {
  if (!ctx.cfg.routing || ctx.cfg.routing.adaptive === false) return null;
  try {
    return routing.performanceStats(improve.readObservations(ctx.paths));
  } catch (_) {
    return null;
  }
}

/**
 * routing.route plus the CLI rule of DESIGN 5: work the orchestrator does itself always needs an
 * independent review, so its routing record says so (the checkpoint's next actions read it).
 */
function routeTask(ctx, spec, stats) {
  const r = routing.route(spec, ctx.cfg, stats, ctx.run.options.mode);
  if (r.role === 'orchestrator' && !r.independent_review) {
    r.independent_review = true;
    r.verification_layers = r.verification_layers.filter((l) => l !== 'opus_gate' && l !== 'integration')
      .concat(['independent_review', 'opus_gate', 'integration']);
    r.reasons = r.reasons.concat(['rule orchestrator_self: work the orchestrator does itself always gets an independent review']);
  }
  return r;
}

function roleWrites(ctx, role) {
  if (role === 'orchestrator') return true;
  const r = ctx.cfg.routing && ctx.cfg.routing.roles && ctx.cfg.routing.roles[role];
  return !r || r.writes !== false;
}

// ---------------------------------------------------------------------------
// Agents and packages
// ---------------------------------------------------------------------------

function agentInstalled(env, agent) {
  return [path.join(env.paths.projectDir, '.claude', 'agents', `${agent}.md`), path.join(env.home, '.claude', 'agents', `${agent}.md`)]
    .some((f) => fs.existsSync(f));
}

/** subagent_type to print, plus the agent file to read first when the agent is not installed. */
function agentTarget(env, agent) {
  if (agent && agentInstalled(env, agent)) return { subagentType: agent, agentFile: null };
  const file = agent ? path.join(SKILL_DIR, 'agents', `${agent}.md`) : null;
  return { subagentType: 'general-purpose', agentFile: file && fs.existsSync(file) ? file : null };
}

function printPrompt(env, text) {
  say(env, 'BEGIN PROMPT', text.replace(/\s+$/, ''), 'END PROMPT');
}

function integrationDir(ctx) {
  const w = ctx.run.workspace || {};
  return w.integration_worktree ? absProject(ctx.env, w.integration_worktree) : null;
}

function integrationHead(ctx) {
  const dir = integrationDir(ctx);
  if (!dir) return null;
  const r = gitops.git(['rev-parse', 'HEAD'], { cwd: dir });
  return r.code === 0 ? r.stdout.trim() : null;
}

function sideEffectAuth(ctx, t) {
  return ctx.run.authorizations.find((a) => a && a.by === 'user' && a.limit === 'side_effects' && a.task_id === t.task_id && !a.used_by_attempt) || null;
}

// ---------------------------------------------------------------------------
// Operation identities, attempts, candidates and integrity checks
// ---------------------------------------------------------------------------

/**
 * A slow operation (verification, integration, delivery) runs its commands outside the state lock.
 * Its record {kind, id, pid, host, acquired_at, ...} is written under the lock before the commands
 * start, and the result is applied only if the record still carries the same id afterwards: a
 * result of a superseded or taken-over operation is discarded, never merged into newer state.
 */
function newOp(kind, extra) {
  const o = store.newOwner(kind);
  return Object.assign(o, { id: o.token }, extra || {});
}

/**
 * Checks an existing operation record before a new one starts. A live owner blocks; a dead owner
 * (same host, process gone) is taken over; an owner whose liveness cannot be proven blocks unless
 * the caller names it with --takeover <op id> after checking. A process id the operating system
 * reused for an unrelated program also looks alive; --takeover <op id> resolves that too. A
 * takeover is safe for the state: the superseded operation's result is discarded by its id.
 * Returns a note or null.
 */
function opGate(op, what, takeover) {
  if (!op) return null;
  const st = store.ownerState(op);
  if (st === 'alive' && takeover !== op.id) {
    refuse(`${what} not started`, `${op.kind} ${op.id} is already running in process ${op.pid} on this host (since ${op.acquired_at})`,
      `wait for it to finish, then oo status; if that process id now belongs to an unrelated program (the oo process is gone), repeat with --takeover ${op.id}`);
  }
  if (st === 'unknown' && takeover !== op.id) {
    refuse(`${what} not started`, `${op.kind} ${op.id} was started by process ${op.pid} on host ${op.host} at ${op.acquired_at}, and oo cannot tell whether it still runs`,
      `confirm that process is gone, then repeat with --takeover ${op.id}`);
  }
  return `took over the interrupted ${op.kind} ${op.id} of process ${op.pid} (${st === 'dead' ? 'it no longer runs' : 'confirmed by --takeover'})`;
}

function attemptIdFor(t) {
  return `${t.task_id}-a${t.attempts}-${require('node:crypto').randomBytes(3).toString('hex')}`;
}

/** Closes the current attempt if it is still open (a block, cancel or failure of an in-flight task). */
function closeAttempt(t, outcome, ts, reason) {
  const cur = t.dispatch && t.dispatch.attempt_id;
  if (!cur) return;
  const e = (t.attempt_log || []).find((x) => x.attempt_id === cur);
  if (e && e.outcome === 'open') logAttempt(t, cur, outcome === 'blocked' || outcome === 'cancelled' || outcome === 'failed' ? 'abandoned' : outcome, ts, { reason: reason || outcome });
}

function logAttempt(t, attemptId, outcome, ts, extra) {
  t.attempt_log = (t.attempt_log || []).map((e) => (e.attempt_id === attemptId ? Object.assign({}, e, { outcome, closed_at: ts }, extra || {}) : e));
}

/** Why a report naming `attemptId` is not the current in-flight attempt, or null when it is. */
function attemptMismatch(t, attemptId) {
  const cur = t.dispatch && t.dispatch.attempt_id;
  if (attemptId && cur && attemptId === cur && sm.IN_FLIGHT.includes(t.status)) return null;
  const known = (t.attempt_log || []).find((e) => e.attempt_id === attemptId);
  if (!attemptId) return `the report has no attempt_id; the current attempt of ${t.task_id} is ${cur || 'none'} (copy attempt_id from the report block of the task package)`;
  if (known && known.outcome === 'abandoned') return `attempt ${attemptId} was abandoned at ${known.closed_at} (${known.reason || 'reconciled'}); a late report of an abandoned attempt is never applied`;
  if (known && known.outcome && known.outcome !== 'open') return `attempt ${attemptId} is already closed (${known.outcome} at ${known.closed_at}); a duplicate or late report is not applied`;
  if (!known) return `attempt ${attemptId} was never dispatched for ${t.task_id}`;
  return `attempt ${attemptId} is not the current attempt of ${t.task_id} (current: ${cur || 'none'}, status ${t.status})`;
}

function generated(ctx) {
  return workspace.generatedPolicy(ctx.cfg);
}

function setupCommands(ctx) {
  const s = ctx.cfg.verification && ctx.cfg.verification.setup_commands;
  return Array.isArray(s) ? s.filter((x) => typeof x === 'string' && x.trim()) : [];
}

function commandOpts(ctx) {
  return {
    timeout: (Number(ctx.cfg.execution.command_timeout_seconds) || 600) * 1000,
    extraUnsafe: (ctx.cfg.security && ctx.cfg.security.extra_unsafe_patterns) || [],
    envAllow: (ctx.cfg.security && ctx.cfg.security.command_env_allow) || [],
  };
}

/** Repository configuration/hooks guard (worktree strategy): refuses when they changed since init. */
function checkRepoGuard(ctx, what) {
  const ws = ctx.run.workspace || {};
  if (ws.strategy !== 'worktree' || !ws.repo_guard) return;
  let now;
  try {
    now = gitops.repoGuard(ctx.paths.projectDir);
  } catch (e) {
    refuse(`${what} not started`, `the repository configuration and hooks cannot be read: ${e.message}`, 'fix the permissions of the .git directory, then repeat');
  }
  if (now !== ws.repo_guard) {
    refuse(`${what} not started`,
      'the repository configuration, hooks or info/attributes in the git directory changed since the run started; a changed hook, filter or diff driver would run inside oo\'s git operations',
      'inspect .git/config, .git/hooks and .git/info/attributes; if the user made or approves the change: oo repo-guard --accept --reason <text> --user-authorized');
  }
}

/**
 * Runs setup commands, then commands, stopping at the first failure. Returns the combined
 * commands result; skipped commands are listed with skipped: true.
 */
function runChecked(cwd, setup, cmds, o) {
  const all = setup.concat(cmds);
  if (!all.length) return { passed: null, shell: null, commands: [] };
  const r = verify.runCommands(all, { cwd, timeout_ms: o.timeout, extraUnsafe: o.extraUnsafe, envAllow: o.envAllow, stopOnFailure: true });
  r.commands.forEach((c, i) => { if (i < setup.length) c.setup = true; });
  return r;
}

/**
 * Changes a command run made in a clean git checkout: [{path, generated}]. Ignored files (the
 * project's own .gitignore) and paths of the generated-artifact policy are generated artifacts;
 * anything else invalidates the evidence. Throws when the status cannot be read.
 */
function checkoutMutations(dir, policy) {
  return gitops.statusEntries(dir).map((e) => ({ path: e.path, generated: workspace.isGenerated(e.path, policy) }));
}

/** A fresh detached checkout of `commit` under the run directory (owned by oo). */
function cleanCheckout(ctx, purpose, commit) {
  const dir = path.join(runDir(ctx.env, ctx.run.run_id), 'worktrees', `${purpose}-${require('node:crypto').randomBytes(3).toString('hex')}`);
  gitops.addDetachedWorktree(ctx.paths.projectDir, dir, commit);
  return dir;
}

function dropCheckout(ctx, dir) {
  if (!dir) return 'none';
  const r = gitops.removeWorktree(ctx.paths.projectDir, dir);
  if (r.ok) return 'removed';
  // One of oo's own clean checkouts whose only changes are generated artifacts (build output,
  // coverage) holds no evidence and no user work: it is deleted and the registration pruned.
  // Anything else, and every directory outside oo's own worktrees folder, is kept.
  const own = gitops.normPath(path.join(runDir(ctx.env, ctx.run.run_id), 'worktrees')) + '/';
  if (gitops.normPath(dir).startsWith(own) && fs.existsSync(dir)) {
    try {
      const entries = gitops.statusEntries(dir);
      const policy = generated(ctx);
      if (entries.every((e) => workspace.isGenerated(e.path, policy))) {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        gitops.git(['worktree', 'prune'], { cwd: ctx.paths.projectDir });
        return 'removed (only generated artifacts were in it)';
      }
    } catch (_) { /* unreadable: keep it */ }
  }
  return `kept (${r.reason})`;
}

/** Stable digest of a shared candidate's file entries. */
function filesDigest(files) {
  const keys = Object.keys(files || {}).sort();
  return 'sha256:' + require('node:crypto').createHash('sha256').update(JSON.stringify(keys.map((k) => [k, files[k]]))).digest('hex');
}

/** The identity of a verified candidate, as review dispatches and integration bind to it. */
function candidateId(c) {
  if (!c) return null;
  if (c.kind === 'shared') return `shared:${c.digest}`;
  return `${c.kind}:${c.commit || '-'}:${c.tree || '-'}`;
}

/**
 * Shared workspace: true when every file of the verified candidate still has the recorded content.
 * Returns {ok, changed:[paths], problem}.
 */
function sharedCandidateIntact(ctx, cand) {
  const changed = [];
  for (const f of Object.keys((cand && cand.files) || {}).sort()) {
    const abs = path.join(ctx.paths.projectDir, ...f.split('/'));
    let now;
    try {
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) now = 'link:' + fs.readlinkSync(abs).split(path.sep).join('/');
      else if (st.isFile()) now = gitops.hashFile(abs);
      else now = 'special:' + (st.isDirectory() ? 'directory' : 'other');
    } catch (e) {
      if (e.code !== 'ENOENT') return { ok: false, changed: [f], problem: `${f} cannot be read (${e.code})` };
      now = null;
    }
    if (now !== cand.files[f]) changed.push(f);
  }
  return { ok: changed.length === 0, changed, problem: null };
}

/** Shared workspace: another task whose evidence window is open and that writes (or `t` writes). */
function sharedWindowConflict(ctx, t) {
  if ((ctx.run.workspace || {}).strategy === 'worktree') return null;
  const writes = (x) => roleWrites(ctx, x.routing && x.routing.role);
  return ctx.tasks.find((o) => o.task_id !== t.task_id && workspace.SHARED_WINDOW.includes(o.status) && (writes(o) || writes(t))) || null;
}

/**
 * Establishes that `dir` is a worktree the task may own: the root of a work tree of this
 * repository, not the main checkout, not the integration worktree, not one of oo's own checkouts,
 * not bound to another task or attempt, and not on the base or integration branch. A report never
 * establishes ownership; only this check, on a path the orchestrator passes (or oo's own
 * self-worktree path), does.
 */
function bindWorktree(ctx, t, given) {
  const env = ctx.env;
  const ws = ctx.run.workspace || {};
  const dir = path.resolve(String(given));
  const why = [];
  if (!fs.existsSync(dir)) why.push(`worktree ${dir} does not exist`);
  const top = why.length ? null : gitops.topLevel(dir);
  if (!why.length && (!top || top !== gitops.normPath(dir))) why.push(`${dir} is not the top directory of a git work tree`);
  if (!why.length && gitops.commonDir(dir) !== gitops.commonDir(ctx.paths.projectDir)) why.push(`${dir} belongs to another repository`);
  const n = gitops.normPath(dir);
  if (!why.length && n === gitops.topLevel(ctx.paths.projectDir)) why.push('that is the main checkout, not a worker worktree');
  if (!why.length && integrationDir(ctx) && n === gitops.normPath(integrationDir(ctx))) why.push('that is the integration worktree');
  if (!why.length && n.startsWith(gitops.normPath(path.join(runDir(env, ctx.run.run_id), 'worktrees')) + '/')) why.push('that is a checkout owned by oo itself');
  const selfDir = t.dispatch && t.dispatch.self_worktree ? gitops.normPath(absProject(env, t.dispatch.self_worktree.dir)) : null;
  if (!why.length && selfDir && n !== selfDir) why.push(`work the orchestrator does itself must be in its own worktree ${absProject(env, t.dispatch.self_worktree.dir)}`);
  if (!why.length) {
    const other = ctx.tasks.find((o) => o.binding && gitops.normPath(absProject(env, o.binding.worktree)) === n && !(o.task_id === t.task_id && o.binding.attempt_id === t.dispatch.attempt_id));
    if (other) why.push(`that worktree is already bound to ${other.task_id} attempt ${other.binding.attempt_id}`);
  }
  let branch = null;
  if (!why.length) {
    const b = gitops.git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: dir });
    branch = b.code === 0 ? b.stdout.trim() : null;
    if (branch && (branch === ws.base_branch || branch === ws.integration_branch)) why.push(`the worktree is on ${branch}, a branch oo delivers to or integrates on`);
    if (selfDir && branch !== t.dispatch.self_worktree.branch) why.push(`the worktree is on ${branch || 'a detached HEAD'}, not on ${t.dispatch.self_worktree.branch}`);
    const ops = gitops.operationsInProgress(dir);
    if (ops.length) why.push(`a git operation is unfinished in the worktree: ${ops.join(', ')}`);
  }
  return { dir, branch, problems: why };
}

/** Commits on the integration branch between `from` and `to` that oo did not create (merges recorded in task evidence). */
function foreignIntegrationCommits(ctx, from, to) {
  if (!from || !to || from === to) return [];
  const r = gitops.git(['rev-list', '--first-parent', `${from}..${to}`], { cwd: ctx.paths.projectDir });
  if (r.code !== 0) return [`(cannot list commits ${from.slice(0, 12)}..${to.slice(0, 12)}: ${r.stderr.trim()})`];
  const known = new Set();
  for (const x of ctx.tasks) {
    const ev = x.evidence || {};
    for (const i of [ev.integration].concat((ev.rounds || []).map((rd) => rd && rd.integration))) if (i && i.merged_commit) known.add(i.merged_commit);
  }
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((c) => !known.has(c));
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

const INIT_USAGE = 'oo init [--mode fast|balanced|thorough|maximum] [--max-workers N] [--review-rounds N] [--plan-only] [--] <objective text>'
  + ' (options are read only before the objective; -- ends them; the objective is kept verbatim and may come from --stdin or --file F;'
  + ' init --status = status, init --resume = resume)';

function cmdInit(env, argv) {
  // Options (including --stdin and --file F) are read only from the leading arguments; the first
  // argument that is not an option or an option's value, or a bare --, starts the objective text.
  const parts = [];
  let useStdin = false;
  let file = null;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stdin') {
      useStdin = true;
    } else if (a === '--file') {
      file = argv[++i];
      if (!file) usage('--file needs a path');
    } else if (a.startsWith('--file=')) {
      file = a.slice(7);
    } else {
      const opt = cliargs.initOptionOf(a);
      if (!opt) break;
      parts.push(a);
      if (opt.takesValue && opt.inline === undefined && i + 1 < argv.length && !argv[i + 1].startsWith('--')) parts.push(argv[++i]);
    }
  }
  parts.push(...argv.slice(i));
  const sources = [parts.join(' ')];
  if (useStdin) sources.push(fs.readFileSync(0, 'utf8'));
  if (file) sources.push(readInput({ opts: { file } }));
  const p = cliargs.parseInitText(sources.join('\n'));
  if (p.errors.length) usage(p.errors.join('; '));
  if (p.status) return cmdStatus(env, { pos: [], opts: {} });
  if (p.resume) return cmdResume(env, { pos: [], opts: {} });
  if (!p.objective) usage(`init needs an objective: ${INIT_USAGE}`);

  const overrides = { execution: {} };
  if (p.mode) overrides.execution.mode = p.mode;
  if (p.max_workers !== null) overrides.execution.max_workers = p.max_workers;
  if (p.review_rounds !== null) overrides.execution.max_review_rounds = p.review_rounds;
  let cfg;
  try {
    cfg = configLib.loadConfig({ skillDir: SKILL_DIR, stateConfigFile: env.paths.configFile, overrides });
  } catch (e) {
    refuse('configuration could not be read', e.message, `fix the YAML in ${env.paths.configFile} or ${path.join(SKILL_DIR, 'config')}`);
  }
  const val = configLib.validateConfig(cfg);
  if (!val.ok) refuse('configuration is invalid; no run was created', val.errors, `fix ${env.paths.configFile} (project overrides) or the skill config, then run oo init again`);
  const lim = configLib.effectiveLimits(cfg);
  const options = {
    mode: lim.mode, max_workers: lim.max_workers, max_review_rounds: lim.max_review_rounds,
    max_retries: lim.max_retries, plan_only: p.plan_only,
  };

  const projectDir = env.paths.projectDir;
  let info;
  try {
    info = gitops.inspect(projectDir);
  } catch (e) {
    info = { is_repo: false, has_commits: false, branch: null, head: null, dirty: [], error: e.message };
  }
  const isolation = cfg.execution.isolation;
  let strategy = gitops.chooseStrategy(info, isolation);
  const warnings = val.warnings.map((w) => `config: ${w}`);
  if (info.error) warnings.push(`git could not be run (${info.error}); shared workspace strategy`);
  else if (!info.is_repo) warnings.push('the workspace is not a git repository: shared workspace strategy (workers edit files in place; scope is checked with file snapshots)');
  else if (!info.has_commits) warnings.push('the git repository has no commits: shared workspace strategy (worktrees need a commit)');
  else if (strategy === 'shared') warnings.push(`execution.isolation is ${isolation}: shared workspace strategy`);

  store.ensureState(env.paths);
  return locked(env, () => {
    let previous = null;
    try {
      const prev = store.loadRun(env.paths);
      const open = store.listTasks(env.paths, prev.run_id).filter((t) => !sm.isTerminal(t.status));
      if (open.length) previous = `${prev.run_id} (${open.length} unfinished task(s))`;
    } catch (_) { /* no previous run */ }

    const run = store.createRun(env.paths, {
      objective: p.objective,
      options,
      config: cfg,
      workspace: {
        strategy, is_repo: info.is_repo, base_branch: info.branch, base_commit: info.head,
        integration_branch: null, integration_worktree: null,
      },
    });
    run.usage = budget.newUsage();
    const gv = gitops.gitVersion();
    if (strategy === 'worktree' && !(gv && (gv[0] > 2 || (gv[0] === 2 && gv[1] >= 31)))) {
      strategy = 'shared';
      run.workspace.strategy = 'shared';
      warnings.push(`git ${gv ? gv.join('.') : '(unknown version)'} is older than 2.31, which the worktree checks need; shared workspace strategy`);
    }
    if (strategy === 'worktree') {
      const dir = path.join(runDir(env, run.run_id), 'worktrees', 'integration');
      try {
        const r = gitops.ensureIntegration(projectDir, run.run_id, dir);
        run.workspace.integration_branch = r.branch;
        run.workspace.integration_worktree = relProject(env, dir);
        run.workspace.base_commit = r.base;
        // The head oo expects on the integration branch; every integration moves it, and any other
        // movement is detected before the next integration or delivery.
        run.workspace.integration_head = gitops.revParse(dir, 'HEAD');
        run.workspace.repo_guard = gitops.repoGuard(projectDir);
      } catch (e) {
        strategy = 'shared';
        run.workspace.strategy = 'shared';
        warnings.push(`the integration worktree could not be created (${e.message}); shared workspace strategy`);
      }
    }
    if (strategy === 'worktree' && info.dirty.length) {
      warnings.push(`${info.dirty.length} uncommitted file(s) in the main checkout (${info.dirty.slice(0, 5).join(', ')}${info.dirty.length > 5 ? ', ...' : ''}): they are left untouched; workers start from the last commit and do not see them`);
    } else if (info.is_repo && info.dirty.length) {
      warnings.push(`${info.dirty.length} uncommitted file(s) in the checkout; workers edit the same files in place`);
    }
    if (previous) warnings.push(`the previous run ${previous} stays on disk; oo commands now work on the new run`);
    store.saveRun(env.paths, run);
    store.appendEvent(env.paths, run.run_id, { type: 'init', options, strategy });
    checkpoint.writeCheckpoint(env.paths, run.run_id, checkpoint.buildCheckpoint(run, [], nowIso()));

    const specsFile = path.join(env.paths.inboxDir, 'specs.yaml');
    say(env,
      `RUN CREATED ${run.run_id}`,
      `Objective: ${oneLine(p.objective, 400)}`,
      `Mode: ${options.mode} | max workers ${options.max_workers} | review rounds ${options.max_review_rounds} | retries ${options.max_retries} | plan only: ${options.plan_only ? 'yes' : 'no'}`,
      strategy === 'worktree'
        ? `Workspace strategy: worktree (integration branch ${run.workspace.integration_branch} at ${String(run.workspace.base_commit).slice(0, 12)}, worktree ${absProject(env, run.workspace.integration_worktree)})`
        : 'Workspace strategy: shared',
    );
    for (const w of warnings) say(env, `Warning: ${w}`);
    say(env,
      `State: ${env.paths.stateRoot}`,
      `Inbox for your drafts: ${env.paths.inboxDir}`,
      `NEXT: write the task specifications (DESIGN 3.1 YAML) to ${specsFile}, then oo plan --file ${specsFile}`);
    return 0;
  });
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

function printTaskPlan(env, t) {
  const r = t.routing || {};
  say(env,
    `TASK ${t.task_id}: ${t.title}`,
    `  complexity ${t.complexity} | risk ${t.risk} | priority ${t.priority} | kind ${t.kind}${t.side_effects !== 'none' ? ` | side effects ${t.side_effects}` : ''}${t.exclusive ? ' | exclusive' : ''}`,
    `  role ${r.role} | agent ${r.agent || 'none (the orchestrator does it)'} | model ${r.role === 'orchestrator' ? 'self' : r.model} | tier ${r.tier} | basis ${r.decision_basis}`,
    `  verification layers: ${(r.verification_layers || []).join(', ')}`,
    `  independent review: ${r.independent_review || r.role === 'orchestrator' ? 'required' : 'not required'}`,
    `  dependencies: ${(t.dependencies || []).length ? t.dependencies.join(', ') : 'none'}`,
    '  routing reasons:',
    ...(r.reasons || []).map((x) => `    - ${x}`));
}

function cmdPlan(env, a) {
  cliargs.checkAllowed(a.opts, ['file', 'stdin'], 'plan');
  const text = readInput(a);
  return locked(env, () => {
    const ctx = openRun(env);
    const rejected = 'plan rejected: nothing was saved';
    const fixNext = 'fix the specification file and run oo plan --file <file> again';
    let docs;
    try {
      docs = yaml.parseAll(text);
    } catch (e) {
      refuse(rejected, `YAML error at line ${e.line || '?'}: ${e.message}`, fixNext);
    }
    const raws = [];
    for (const d of docs) {
      if (d === null || d === undefined) continue;
      if (Array.isArray(d)) raws.push(...d);
      else raws.push(d);
    }
    if (!raws.length) refuse(rejected, 'the input contains no task specification', 'write one YAML mapping per task (DESIGN 3.1), as a list or as documents separated by ---');

    const errors = [];
    const warnings = [];
    const specs = [];
    raws.forEach((raw, i) => {
      const label = isPlain(raw) && typeof raw.task_id === 'string' ? raw.task_id : `specification ${i + 1}`;
      const v = specLib.validateSpec(raw, { config: ctx.cfg });
      const hints = mappingHints(raw);
      for (const e of v.errors) errors.push(`${label}: ${e}`);
      for (const h of hints) errors.push(`${label}: ${h}`);
      for (const w of v.warnings) warnings.push(`${label}: ${w}`);
      if (v.ok && !hints.length) specs.push({ spec: v.spec, raw });
    });
    const newIds = new Set(specs.map((s) => s.spec.task_id));
    for (const s of specs) {
      const ex = ctx.byId.get(s.spec.task_id);
      if (ex && ex.status !== 'PENDING') {
        errors.push(`${s.spec.task_id}: already exists with status ${ex.status}; only PENDING tasks can be re-planned (use oo amend ${s.spec.task_id} --file <file> --reason <text>)`);
      }
    }
    if (!errors.length) {
      const combined = ctx.tasks.filter((t) => !newIds.has(t.task_id)).concat(specs.map((s) => s.spec));
      const pv = specLib.validatePlan(combined);
      errors.push(...pv.errors);
      warnings.push(...pv.warnings);
    }
    if (errors.length) refuse(rejected, errors, fixNext);

    const stats = readStats(ctx);
    let replaced = 0;
    for (const s of specs) {
      const id = s.spec.task_id;
      const r = routeTask(ctx, s.spec, stats);
      const rec = specLib.newTaskRecord(s.spec, r, ctx.now);
      const old = ctx.byId.get(id);
      if (old) {
        replaced += 1;
        rec.spec_revision = (old.spec_revision || 1) + 1;
        rec.history = (old.history || []).concat([{ ts: ctx.now, from: 'PENDING', to: 'PENDING', reason: 're-planned', actor: 'orchestrator' }]);
        rec.created_at = old.created_at || ctx.now;
      }
      setTask(ctx, rec);
      store.saveSpecText(ctx.paths, ctx.run.run_id, id, yaml.stringify(s.raw));
      ctx.events.push({ type: 'planned', task_id: id, spec_revision: rec.spec_revision });
    }
    persist(ctx, { command: 'plan', tasks: specs.map((s) => s.spec.task_id) });

    say(env, `PLAN SAVED: ${specs.length} task(s)${replaced ? `, ${replaced} re-planned` : ''}; ${ctx.tasks.length} task(s) in the run`);
    for (const s of specs) printTaskPlan(env, ctx.byId.get(s.spec.task_id));
    const lim = limits(ctx);
    try {
      const open = ctx.tasks.filter((t) => !sm.isTerminal(t.status) || t.status === 'COMPLETED');
      const waves = scheduler.planWaves(open, lim.max_workers);
      say(env, `Waves (static preview assuming every task succeeds; max workers ${lim.max_workers}):`);
      waves.forEach((w, i) => say(env, `  wave ${i + 1}: ${w.join(', ')}`));
    } catch (e) {
      say(env, `Waves: no preview (${e.message})`);
    }
    if (warnings.length) say(env, 'Warnings:', ...warnings.map((w) => `  - ${w}`));
    if (ctx.run.options.plan_only) {
      say(env,
        'PLAN ONLY: this run was created with --plan-only; no task will be dispatched in it.',
        'NEXT: present this plan to the user; to execute it, start a run without --plan-only (oo init <objective>) and plan the same file');
    } else {
      say(env, 'NEXT: oo next');
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// next
// ---------------------------------------------------------------------------

const DEFER_TEXT = {
  no_slot: 'no free worker slot',
  scope_conflict: 'its authorized files overlap a task in progress or one dispatched now',
  exclusive: 'an exclusive task must run alone',
  budget: 'the agent call budget has no calls left for it',
  shared_serial: 'shared workspace: another task is being worked on, verified or integrated in the same directory, and concurrent changes there cannot be attributed reliably',
};

function dispatchWorkspace(ctx, t) {
  const ws = ctx.run.workspace || {};
  const projectDir = ctx.paths.projectDir;
  if (ws.strategy !== 'worktree') return { mode: 'shared', workDir: projectDir, isolated: false, snapshotRoot: projectDir };
  const head = integrationHead(ctx);
  const intDir = integrationDir(ctx);
  const base = { integrationHead: head, integrationBranch: ws.integration_branch, workDir: intDir };
  if (t.routing.role === 'orchestrator') {
    const name = `${t.task_id}-d${t.attempts}`;
    return Object.assign(base, {
      mode: 'self', isolated: true, snapshotRoot: null,
      // under the inbox, not under .claude: Claude Code refuses file-tool writes below .claude
      selfWorktree: { dir: path.join(ctx.paths.inboxDir, 'worktrees', ctx.run.run_id, name), branch: `opus-orch/${ctx.run.run_id}/${name}` },
    });
  }
  if (roleWrites(ctx, t.routing.role)) return Object.assign(base, { mode: 'isolated', isolated: true, snapshotRoot: null });
  // Read-only work reads the integration worktree; its evidence is git's own (the worktree stays
  // clean and only oo's merges move the branch), not a file snapshot.
  return Object.assign(base, { mode: 'readonly', isolated: false, snapshotRoot: null });
}

function depSummaries(ctx, t) {
  return (t.dependencies || []).map((d) => {
    const dep = ctx.byId.get(d) || {};
    return { task_id: d, title: dep.title, summary: dep.result ? oneLine(dep.result.summary, 300) : null };
  });
}

function cmdNext(env, a) {
  cliargs.checkAllowed(a.opts, ['inline'], 'next');
  // Shared workspace: the baseline snapshot hashes every file, which can take a while, so it is
  // taken before the state lock. No worker can be editing meanwhile: shared-workspace tasks are
  // serialized, and a task is only dispatched when no other task's evidence window is open.
  let preSnap = null;
  try {
    const r0 = store.loadRun(env.paths);
    if (!r0.workspace || r0.workspace.strategy !== 'worktree') preSnap = gitops.snapshot(env.paths.projectDir, { ignore: workspace.snapshotIgnore(env.paths) });
  } catch (_) { /* no run: openRun refuses below */ }
  return locked(env, () => {
    const ctx = openRun(env);
    if (ctx.run.options.plan_only) {
      refuse('nothing dispatched', 'this run was created with --plan-only', 'present the plan to the user; to execute it, start a run without --plan-only (oo init <objective>) and plan the same specifications');
    }
    const chk = budgetCheck(ctx);
    if (chk.state === 'exceeded') {
      refuse('nothing dispatched: the budget is exceeded', chk.messages.filter((m) => /exceeded/.test(m)),
        'ask the user; a higher limit is recorded only with oo authorize --limit <agent_call_limit|token_limit|cost_limit_usd> --value <n> --by user --reason <text>');
    }
    for (const id of scheduler.promotable(ctx.tasks)) move(ctx, ctx.byId.get(id), 'READY', { reason: 'dependencies completed' });

    const held = [];
    const schedTasks = ctx.tasks.map((t) => {
      if (t.status === 'READY' && t.side_effects === 'external' && !sideEffectAuth(ctx, t)) {
        held.push(t.task_id);
        return Object.assign({}, t, { status: 'HELD' });
      }
      return t;
    });
    const remaining = budget.remainingCalls(ctx.run.usage, ctx.cfg.budget, ctx.run.authorizations);
    const lim = limits(ctx);
    const shared = (ctx.run.workspace || {}).strategy !== 'worktree';
    const batch = scheduler.selectBatch(schedTasks, {
      max_workers: lim.max_workers,
      parallel: ctx.cfg.execution.parallel_execution !== false,
      call_budget: remaining,
      shared_serial: shared ? { window: workspace.SHARED_WINDOW, writes: (x) => roleWrites(ctx, x.routing && x.routing.role) } : null,
    });

    let snapRel = null;
    const snapshotFor = () => {
      if (snapRel) return snapRel;
      if (!preSnap || !preSnap.complete) {
        refuse('nothing dispatched: the shared workspace cannot be snapshotted completely',
          preSnap ? preSnap.errors.map((e) => `${e.path}: ${e.code}`) : ['no snapshot could be taken'],
          'fix the permissions of the listed paths (or remove them), then oo next; without a complete baseline the scope of shared-workspace work cannot be checked');
      }
      const name = `snapshots/baseline-${ctx.now.replace(/[-:.]/g, '')}-${process.pid}.json`;
      const file = path.join(runDir(env, ctx.run.run_id), ...name.split('/'));
      store.writeJson(file, preSnap);
      snapRel = relProject(env, file);
      return snapRel;
    };

    const blocks = [];
    for (const id of batch.dispatch) {
      let t = ctx.byId.get(id);
      const kind = t.next_dispatch_kind || 'worker';
      t = move(ctx, t, 'DISPATCHED', { reason: kind === 'worker' ? 'dispatched' : `dispatched after ${kind}` });
      t.next_dispatch_kind = null;
      const isOrch = t.routing.role === 'orchestrator';
      if (!isOrch) ctx.run.usage = budget.recordCall(ctx.run.usage, { task_id: id, kind });
      const auth = t.side_effects === 'external' ? sideEffectAuth(ctx, t) : null;
      if (auth) auth.used_by_attempt = t.attempts;
      const ws = dispatchWorkspace(ctx, t);
      const attemptId = attemptIdFor(t);
      // Shared workspace: the first dispatch records the task's baseline; retries and correction
      // rounds keep it, so an out-of-scope change of an earlier attempt cannot become baseline.
      if (ws.snapshotRoot && !(t.baseline && t.baseline.snapshot)) {
        t.baseline = { snapshot: snapshotFor(), at: ctx.now, attempt_id: attemptId, root: relProject(env, ws.snapshotRoot) };
      }
      const roleCfg = (ctx.cfg.routing.roles || {})[t.routing.role] || {};
      const text = packages.workerPackage(t, {
        brief: roleCfg.brief, agent: t.routing.agent, deps: depSummaries(ctx, t), orchestrator: isOrch, workspace: ws, attemptId,
      });
      const pkgFile = writeRunFile(env, ctx.run.run_id, `packages/${id}-d${t.attempts}.md`, text);
      t.dispatch = {
        attempt: t.attempts, attempt_id: attemptId, at: ctx.now, kind, package: relProject(env, pkgFile), mode: ws.mode, isolated: ws.isolated,
        integration_head: ws.integrationHead || null, snapshot: ws.snapshotRoot ? t.baseline.snapshot : null,
        snapshot_root: ws.snapshotRoot ? relProject(env, ws.snapshotRoot) : null,
        self_worktree: ws.selfWorktree ? { dir: relProject(env, ws.selfWorktree.dir), branch: ws.selfWorktree.branch } : null,
      };
      t.binding = null;
      t.candidate = null;
      t.attempt_log = (t.attempt_log || []).concat([{ attempt_id: attemptId, attempt: t.attempts, kind, dispatched_at: ctx.now, outcome: 'open' }]);
      blocks.push({ t, ws, pkgFile, text, isOrch });
    }
    ctx.events.push({ type: 'dispatch', tasks: batch.dispatch, deferred: batch.deferred, held });
    persist(ctx, { command: 'next', dispatched: batch.dispatch });

    const inflight = ctx.tasks.filter((t) => sm.IN_FLIGHT.includes(t.status)).length;
    const after = budgetCheck(ctx);
    for (const m of after.messages.filter((x) => / (warning|exceeded):/.test(x))) say(env, `Budget: ${m}`);
    if (blocks.length) {
      const agents = blocks.filter((b) => !b.isOrch).length;
      say(env, `DISPATCH ${blocks.length} task(s)${agents ? `; issue the ${agents} Agent call(s) below in ONE message so they run in parallel` : ''}.`);
    }
    blocks.forEach((b) => {
      const t = b.t;
      say(env, '', `=== ${t.task_id} (attempt ${t.attempts}${t.dispatch.kind !== 'worker' ? `, ${t.dispatch.kind}` : ''}) ${t.routing.role} / ${t.routing.model}${b.isOrch ? ' / DO YOURSELF' : ''} ===`);
      if (b.isOrch) {
        say(env,
          `DO YOURSELF: no agent is launched for ${t.task_id}; the orchestrator does it.`,
          `Package: ${b.pkgFile}`,
          b.ws.mode === 'self'
            ? `Workspace: create your own worktree: git worktree add -b ${b.ws.selfWorktree.branch} "${b.ws.selfWorktree.dir}" ${b.ws.integrationHead}`
            : `Workspace: edit in place in ${b.ws.workDir}`,
          `When done: oo result ${t.task_id} --stdin${b.ws.mode === 'self' ? ` --worktree "${b.ws.selfWorktree.dir}" --branch ${b.ws.selfWorktree.branch}` : ''} with the report block the package specifies (an independent review is always required for work the orchestrator did itself)`);
        return;
      }
      const target = agentTarget(env, t.routing.agent);
      say(env, packages.agentCallLine({
        subagentType: target.subagentType,
        model: t.routing.model,
        isolation: b.ws.mode === 'isolated' ? 'worktree' : null,
        description: packages.describeTask(t),
      }));
      if (target.agentFile) say(env, `(agent ${t.routing.agent} is not installed in .claude/agents; the prompt tells general-purpose to read its definition first)`);
      if (a.opts.inline) {
        printPrompt(env, (target.agentFile ? `First read ${target.agentFile} and follow it as your role definition.\n\n` : '') + b.text);
      } else {
        printPrompt(env, packages.shortPrompt(b.pkgFile, target.agentFile));
      }
    });

    const deferred = batch.deferred.filter((d) => !held.includes(d.task_id));
    if (deferred.length) {
      say(env, '', 'Deferred:');
      for (const d of deferred) {
        let why = DEFER_TEXT[d.reason] || d.reason;
        if (d.reason === 'no_slot') why += ` (max workers ${lim.max_workers}, ${inflight} in flight)`;
        if (d.reason === 'budget') why += '; ask the user, then oo authorize --limit agent_call_limit --value <n> --by user --reason <text>';
        say(env, `  ${d.task_id}: ${d.reason}: ${why}`);
      }
    }
    if (held.length) {
      say(env, '', 'Held (external side effects, no user authorization recorded):');
      for (const id of held) say(env, `  ${id}: ask the user; only with their consent run oo authorize --task ${id} --side-effects --by user --reason <text>`);
    }

    if (!blocks.length) {
      let reason = scheduler.explainIdle(schedTasks.map((t) => (t.status === 'HELD' ? Object.assign({}, t, { status: 'BLOCKED' }) : t)));
      if (!ctx.tasks.length) reason = 'no tasks are planned';
      else if (held.length && /blocked/.test(reason) && !ctx.tasks.some((t) => t.status === 'BLOCKED' || t.status === 'FAILED')) reason = `held for user authorization: ${held.join(', ')}`;
      else if (/^ready/.test(reason)) reason = `ready tasks are deferred (${deferred.map((d) => `${d.task_id}: ${d.reason}`).join(', ')})`;
      say(env, `NOTHING DISPATCHED: ${reason}`);
      let next;
      if (!ctx.tasks.length) next = 'oo plan --file <specs.yaml>';
      else if (reason === 'all_done') next = 'oo final-report, then oo deliver';
      else if (reason.startsWith('held for user authorization')) next = `ask the user about ${held.join(', ')}; only with their consent run oo authorize --task <ID> --side-effects --by user --reason <text>, then oo next`;
      else next = firstNext(ctx, 'oo status');
      say(env, `NEXT: ${next}`);
      return 0;
    }
    const agentIds = blocks.filter((b) => !b.isOrch).map((b) => b.t.task_id);
    const selfIds = blocks.filter((b) => b.isOrch).map((b) => b.t.task_id);
    if (agentIds.length) {
      say(env, '', `NEXT: launch the Agent call(s) above in one message, then oo started ${agentIds.join(' ')}${selfIds.length ? `; do ${selfIds.join(', ')} yourself` : ''}`);
    } else {
      say(env, '', `NEXT: do ${selfIds.join(', ')} yourself, then oo result <ID> --stdin`);
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// started
// ---------------------------------------------------------------------------

function cmdStarted(env, a) {
  cliargs.checkAllowed(a.opts, [], 'started');
  const ids = a.pos.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  if (!ids.length) usage('started needs task ids: oo started <ID> [<ID>...]');
  return locked(env, () => {
    const ctx = openRun(env);
    const problems = [];
    const already = [];
    for (const id of ids) {
      const t = getTask(ctx, id);
      if (t.status === 'RUNNING') already.push(id);
      else if (t.status !== 'DISPATCHED') problems.push(`${id} is ${t.status}, not DISPATCHED`);
    }
    if (problems.length) refuse('nothing was marked as started', problems, 'only tasks printed by oo next (status DISPATCHED) can be started; check oo status');
    const moved = [];
    for (const id of ids) {
      if (already.includes(id)) continue;
      move(ctx, ctx.byId.get(id), 'RUNNING', { reason: 'agent launched' });
      moved.push(id);
    }
    persist(ctx, { command: 'started', tasks: moved });
    say(env, `RUNNING: ${moved.join(', ') || '(none changed)'}${already.length ? `; already RUNNING: ${already.join(', ')}` : ''}`);
    say(env, 'NEXT: when a worker returns, oo result <ID> --stdin [--tokens N] with its final message (in the worktree strategy add --worktree <path> --branch <branch>)');
    return 0;
  });
}

// ---------------------------------------------------------------------------
// worker failures
// ---------------------------------------------------------------------------

/** Records a worker failure on a DISPATCHED/RUNNING task and moves it on. Returns an outcome word. */
function workerFailure(ctx, t, kind, reason) {
  t.failures = (t.failures || []).concat([{ kind, reason, ts: ctx.now, attempt: t.attempts || 0, attempt_id: (t.dispatch && t.dispatch.attempt_id) || null }]);
  closeAttempt(t, `failed_${kind}`, ctx.now, reason);
  touch(ctx, t);
  if (kind === 'permission' || kind === 'budget' || kind === 'worker_blocked' || kind === 'needs_decomposition') {
    move(ctx, t, 'BLOCKED', { reason, kind });
    return 'blocked';
  }
  if (t.side_effects === 'external') {
    move(ctx, t, 'FAILED', { reason: `${reason} (external side effects: never retried automatically)`, kind });
    return 'failed_external';
  }
  const lim = limits(ctx);
  if ((t.retries || 0) < lim.max_retries) {
    const n = move(ctx, t, 'READY', { reason: `retry after ${kind}: ${reason}` });
    n.next_dispatch_kind = 'retry';
    return 'retry';
  }
  move(ctx, t, 'FAILED', { reason: `${reason} (retry limit ${lim.max_retries} reached)`, kind });
  return 'failed';
}

function sayFailureOutcome(env, ctx, id, kind, outcome) {
  const t = ctx.byId.get(id);
  const lim = limits(ctx);
  const adv = routing.escalation(t, ctx.cfg, { failure_kind: kind });
  const text = {
    blocked: `${id} -> BLOCKED (${kind}; never retried automatically)`,
    failed_external: `${id} -> FAILED (external side effects; never retried automatically)`,
    retry: `${id} -> READY for retry ${t.retries} of ${lim.max_retries}`,
    failed: `${id} -> FAILED (retry limit ${lim.max_retries} reached)`,
  }[outcome];
  say(env, `WORKER FAILURE RECORDED: ${text}`, `Escalation advice: ${adv.action} (model ${adv.model}): ${adv.reason}`);
  const next = {
    blocked: kind === 'needs_decomposition'
      ? `split the work: oo plan --file <new specs> for the subtasks, then oo cancel ${id} --reason <text> (or amend it)`
      : `resolve the block (ask the user if it is a permission or budget decision), then oo unblock ${id} --reason <text>`,
    failed_external: `check what the worker already did; ask the user before oo reopen ${id} --reason <text> --user-authorized`,
    retry: 'oo next',
    failed: `oo escalate ${id} --model ${adv.model === 'opus' ? 'opus' : 'sonnet'} --reason <text>, or oo amend / ask the user`,
  }[outcome];
  say(env, `NEXT: ${next}`);
}

function cmdWorkerFailed(env, a) {
  cliargs.checkAllowed(a.opts, ['kind', 'reason', 'attempt'], 'worker-failed');
  const id = a.pos[0];
  if (!id) usage('worker-failed needs a task id: oo worker-failed <ID> --kind K --reason T [--attempt AID]');
  const kind = a.opts.kind;
  if (!FAILURE_KINDS.includes(kind)) usage(`--kind must be one of ${FAILURE_KINDS.join('|')}`);
  const reason = needReason(a);
  return locked(env, () => {
    const ctx = openRun(env);
    const t = getTask(ctx, id);
    if (!sm.IN_FLIGHT.includes(t.status)) {
      refuse(`worker failure for ${id} not recorded`, `${id} is ${t.status}; worker failures apply to DISPATCHED or RUNNING tasks`, 'check oo status; for a finished task use block, fail or cancel');
    }
    // With --attempt, a failure notice that belongs to an earlier, superseded attempt is refused.
    if (a.opts.attempt !== undefined && String(a.opts.attempt) !== (t.dispatch && t.dispatch.attempt_id)) {
      refuse(`worker failure for ${id} not recorded`, attemptMismatch(t, String(a.opts.attempt)) || `the current attempt is ${t.dispatch && t.dispatch.attempt_id}`, 'a failure of an earlier attempt does not affect the current one');
    }
    const outcome = workerFailure(ctx, t, kind, reason);
    persist(ctx, { command: 'worker-failed', task_id: id, kind, outcome });
    sayFailureOutcome(env, ctx, id, kind, outcome);
    return 0;
  });
}

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------

function cmdResult(env, a) {
  cliargs.checkAllowed(a.opts, ['stdin', 'file', 'tokens', 'worktree', 'branch', 'verify', 'agent-id'], 'result');
  const id = a.pos[0];
  if (!id) usage('result needs a task id: oo result <ID> --stdin');
  let tokens = null;
  if (a.opts.tokens !== undefined) {
    if (!/^\d+$/.test(String(a.opts.tokens))) usage('--tokens must be a non-negative integer');
    tokens = Number(a.opts.tokens);
  }
  const agentId = a.opts['agent-id'] !== undefined ? String(a.opts['agent-id']).trim() : null;
  if (agentId !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(agentId)) usage('--agent-id must be the agent id the host printed (letters, digits, . _ : -)');
  const text = readInput(a);
  let completed = false;
  const code = locked(env, () => {
    const ctx = openRun(env);
    let t = getTask(ctx, id);
    const unchanged = `result for ${id} rejected; task state unchanged`;
    const failNext = `send the errors back to the worker, or record oo worker-failed ${id} --kind invalid_output --reason <text>`;
    if (t.status === 'CANCELLED') {
      refuse(`result for ${id} refused`, `${id} was cancelled; a late result for a cancelled task is never applied`, 'ignore that worker\'s output; reopen the task only if the user asks (oo reopen <ID> --reason <text> --user-authorized)');
    }
    if (!sm.IN_FLIGHT.includes(t.status)) {
      refuse(`result for ${id} refused`, `${id} is ${t.status}; a worker result is accepted only while the task is DISPATCHED or RUNNING`, firstNext(ctx, 'oo status'));
    }
    const obj = parseReportBlock(text, 'result', id, failNext);
    const reportedAttempt = obj && typeof obj === 'object' && typeof obj.attempt_id === 'string' ? obj.attempt_id.trim() : null;
    const mismatch = attemptMismatch(t, reportedAttempt);
    if (mismatch) {
      refuse(unchanged, mismatch, `only the report of the current attempt ${t.dispatch && t.dispatch.attempt_id} is accepted; ignore a late or duplicate report`);
    }
    const v = reports.validateAgentResult(obj, t);
    if (!v.ok) refuse(unchanged, v.errors, failNext);
    const r = v.result;
    const notes = [];
    const attemptId = t.dispatch.attempt_id;

    let binding = null;
    let candidate = null;
    const ws = ctx.run.workspace || {};
    if (r.status === 'completed' && ws.strategy === 'worktree') {
      const d = t.dispatch || {};
      if (d.isolated) {
        const given = a.opts.worktree || (d.self_worktree ? absProject(env, d.self_worktree.dir) : null);
        if (!given) {
          if (r.commit || r.files_changed.length) {
            refuse(unchanged, 'worktree strategy: the worker changed files in its own worktree, so oo needs the worktree path to verify them', 'repeat with --worktree <path> taken from the Agent result (the report itself never names the worktree oo verifies)');
          }
          const tree = gitops.treeOf(env.paths.projectDir, d.integration_head);
          candidate = { kind: 'no_change', attempt_id: attemptId, commit: d.integration_head, tree, base: d.integration_head, integration_head: d.integration_head, recorded_at: ctx.now };
          notes.push('no worktree given and no change reported: the candidate is the integration head the task was dispatched with, so nothing will be merged for it');
        } else {
          const b = bindWorktree(ctx, t, given);
          if (b.problems.length) refuse(unchanged, b.problems, 'pass the worktree of this attempt with --worktree <path> (from the Agent result)');
          const sha = gitops.revParse(b.dir, 'HEAD');
          if (!sha) refuse(unchanged, `${b.dir} has no commit at HEAD`, 'ask the worker to commit its work, or record oo worker-failed');
          if (r.commit && !sha.startsWith(String(r.commit).toLowerCase())) notes.push(`the reported commit ${r.commit} differs from the worktree HEAD ${sha}; the worktree HEAD is the candidate`);
          if (a.opts.branch && String(a.opts.branch) !== b.branch) notes.push(`--branch ${a.opts.branch} differs from the worktree's branch ${b.branch || '(detached)'}; the worktree's branch is recorded`);
          if (r.branch && r.branch !== b.branch) notes.push(`the reported branch ${r.branch} differs from the worktree's branch ${b.branch || '(detached)'}; the report does not decide which branch is used`);
          let base;
          try {
            base = workspace.worktreeChanges(env.paths.projectDir, d.integration_head, sha).base;
          } catch (e) {
            refuse(unchanged, e.message, `the worker must start from the integration head ${d.integration_head}; record oo worker-failed ${id} --kind invalid_output --reason <text>`);
          }
          binding = { attempt_id: attemptId, worktree: relProject(env, b.dir), branch: b.branch, bound_at: ctx.now };
          candidate = {
            kind: 'commit', attempt_id: attemptId, commit: sha, tree: gitops.treeOf(b.dir, sha), base, integration_head: d.integration_head,
            contains_integration_head: gitops.isAncestor(b.dir, d.integration_head, sha), branch: b.branch, worktree: relProject(env, b.dir), recorded_at: ctx.now,
          };
        }
      } else if (d.mode === 'readonly') {
        candidate = { kind: 'readonly', attempt_id: attemptId, commit: null, tree: null, integration_head: d.integration_head, recorded_at: ctx.now };
      }
    }

    r.files_changed = relativizeReported(env, r.files_changed, [binding ? absProject(env, binding.worktree) : null, t.dispatch && t.dispatch.self_worktree ? absProject(env, t.dispatch.self_worktree.dir) : null]);
    const reportFile = writeRunFile(env, ctx.run.run_id, `reports/${id}-d${t.attempts || 0}.yaml`, yaml.stringify(r));
    if (tokens !== null) ctx.run.usage = budget.recordTokens(ctx.run.usage, { task_id: id, total: tokens });
    if (t.status === 'DISPATCHED') t = move(ctx, t, 'RUNNING', { reason: 'result received before oo started' });

    if (r.status === 'completed') {
      t = move(ctx, t, 'IMPLEMENTED', { reason: `worker reported completed (attempt ${attemptId})` });
      t.binding = binding;
      t.candidate = candidate;
      t.result = {
        attempt_id: attemptId, agent_id: agentId, summary: r.summary, files_changed: r.files_changed,
        commit: candidate && candidate.commit ? candidate.commit : null, branch: binding ? binding.branch : null,
        worktree: binding ? binding.worktree : null, tokens, reported_at: ctx.now,
        report_file: relProject(env, reportFile), issues: r.issues || [], commands_run: r.commands_run || [],
      };
      logAttempt(t, attemptId, 'reported', ctx.now);
      t.evidence = t.evidence || {};
      t.evidence.self_check = r.self_check;
      t.correction = null;
      persist(ctx, { command: 'result', task_id: id, status: r.status, attempt_id: attemptId });
      completed = true;
      const unmet = (r.self_check || []).map((c, i) => (c.met ? null : i + 1)).filter(Boolean);
      say(env, `RESULT ACCEPTED: ${id} -> IMPLEMENTED (attempt ${attemptId}: ${oneLine(r.summary, 160)})`);
      say(env, `Files reported: ${r.files_changed.length ? r.files_changed.join(', ') : 'none'}`);
      if (binding) say(env, `Worktree bound: ${absProject(env, binding.worktree)} | branch ${binding.branch || '(detached)'} | candidate ${candidate.commit} (tree ${String(candidate.tree).slice(0, 12)})`);
      if (unmet.length) say(env, `Warning: the worker reports criteria ${unmet.join(', ')} as not met`);
      if ((r.issues || []).length) say(env, `Worker issues: ${r.issues.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' | ')}`);
      for (const n of notes) say(env, `Note: ${n}`);
      say(env, `Report saved: ${reportFile}`);
      if (!a.opts.verify) say(env, `NEXT: oo verify ${id}`);
      return 0;
    }

    const issues = (r.issues || []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
    const reason = oneLine(`${r.summary}${issues.length ? ` (issues: ${issues.join('; ')})` : ''}`, 400);
    const kind = r.status === 'failed' ? 'worker_failed' : r.status === 'blocked' ? 'worker_blocked' : 'needs_decomposition';
    if (kind === 'needs_decomposition') {
      t.proposed_subtasks = r.proposed_subtasks;
      touch(ctx, t);
    }
    logAttempt(t, attemptId, `reported_${r.status}`, ctx.now);
    touch(ctx, t);
    const outcome = workerFailure(ctx, t, kind, reason);
    persist(ctx, { command: 'result', task_id: id, status: r.status, outcome, attempt_id: attemptId });
    say(env, `RESULT RECORDED: ${id} reported ${r.status}: ${reason}`);
    if (kind === 'needs_decomposition') say(env, 'Proposed subtasks:', ...indent(yaml.stringify(r.proposed_subtasks).trimEnd()));
    sayFailureOutcome(env, ctx, id, kind, outcome);
    return 0;
  });
  if (code === 0 && completed && a.opts.verify) return runVerify(env, id, {});
  return code;
}

// ---------------------------------------------------------------------------
// verify and check
// ---------------------------------------------------------------------------

function readSnapshotFile(env, rel) {
  try {
    return store.readJson(absProject(env, rel)).value;
  } catch (_) {
    return null;
  }
}

function commandLines(cmds) {
  const out = [];
  for (const c of cmds || []) {
    const status = c.skipped ? 'not run' : c.refused ? 'refused' : c.timed_out ? 'timed out' : `exit ${c.exit_code === null ? 'none' : c.exit_code}`;
    out.push(`  [${status}]${c.setup ? ' (setup)' : ''} ${c.command} (${c.duration_ms} ms)${c.reason ? ` - ${c.reason}` : ''}`);
  }
  return out;
}

function evidenceText(title, info) {
  const L = [title, `Run at: ${info.at}`, `Workspace: ${info.cwd}`, `Shell: ${info.shell || '(no command run)'}`];
  if (info.candidate) L.push(`Candidate: ${candidateId(info.candidate)}${info.candidate.attempt_id ? ` (attempt ${info.candidate.attempt_id})` : ''}`);
  if (info.basis) L.push(`Scope basis: ${info.basis}`);
  if ((info.envRemoved || []).length) L.push(`Removed from the command environment (credential-like names): ${info.envRemoved.join(', ')}`);
  if ((info.correctionCommands || []).length) L.push(`Correction-round commands (from the correction request): ${info.correctionCommands.join(' ; ')}`);
  if (info.files) L.push(`Changed files: ${info.files.length ? info.files.join(', ') : 'none'}`);
  if (info.scope) {
    L.push(`Scope: ${info.scope.ok ? 'ok' : `VIOLATIONS: ${info.scope.violations.join(', ')}`}`);
    for (const g of info.scope.ignored || []) L.push(`Attributed elsewhere (${g.basis}): ${g.file}`);
    for (const g of info.scope.generated || []) L.push(`Generated artifact (not scope evidence): ${g}`);
  }
  for (const m of info.mutations || []) L.push(`Changed by the commands: ${m.path}${m.generated ? ' (generated artifact, allowed)' : ' (INVALIDATES THE EVIDENCE)'}`);
  for (const n of info.notes || []) L.push(`Note: ${n}`);
  for (const c of info.checks || []) L.push(`Check ${c.name}: ${c.result}${c.note ? ` (${c.note})` : ''}`);
  for (const c of info.commands || []) {
    L.push('', `$ ${c.command}${c.setup ? '   (setup)' : ''}`, `exit ${c.exit_code === null ? 'none' : c.exit_code} | ${c.duration_ms} ms${c.timed_out ? ' | timed out' : ''}${c.refused ? ' | refused' : ''}${c.skipped ? ' | not run' : ''}${c.reason ? ` | ${c.reason}` : ''}`);
    if (c.output_tail) L.push(c.output_tail);
  }
  L.push('', `Verdict: ${info.passed ? 'passed' : 'failed'}${info.reasons ? ` - ${info.reasons.join('; ')}` : ''}`);
  return L.join('\n') + '\n';
}

/**
 * Collects, outside the state lock, the evidence of one verification: where the candidate is,
 * which files it changed and whether they lie in scope, the commands' results in a clean place,
 * and what the commands changed. Never throws for evidence problems: it returns them as failing
 * checks (or blocking problems) so that the verification fails closed with a reason.
 */
function gatherVerification(ctx, plan) {
  const env = ctx.env;
  const out = { cwd: null, files: [], scope: null, extraChecks: [], notes: [], mutations: [], cr: { passed: null, shell: null, commands: [], env_removed: [] }, candidate: null, diff: null, block: null };
  const policy = generated(ctx);
  const fail = (name, note) => out.extraChecks.push({ name, result: 'fail', note });
  if (plan.mode === 'shared') {
    const root = plan.root;
    out.cwd = root;
    const baseline = plan.baseline ? readSnapshotFile(env, plan.baseline) : null;
    const current = gitops.snapshot(root, { ignore: workspace.snapshotIgnore(ctx.paths) });
    const cmp = gitops.compareSnapshots(baseline, current);
    if (!cmp.ok) {
      out.block = { kind: !baseline || !gitops.isSnapshot(baseline) ? 'evidence_missing' : 'evidence_incomplete', reasons: cmp.problems };
      return out;
    }
    const att = workspace.attributeShared(plan.task, cmp, current, { tasks: ctx.tasks, generated: policy });
    out.files = att.own.concat(att.violations).sort();
    out.scope = { ok: att.ok, violations: att.violations, ignored: att.ignored, generated: att.generated, basis: `content-hash snapshot compared with the task baseline of ${plan.baselineAt}` };
    const files = gitops.pickEntries(current, att.own);
    out.candidate = { kind: 'shared', attempt_id: plan.attemptId, files, digest: filesDigest(files) };
    out.cr = runChecked(root, plan.setup, plan.cmds, plan.copts);
    const post = gitops.snapshot(root, { ignore: workspace.snapshotIgnore(ctx.paths) });
    const after = gitops.compareSnapshots(current, post);
    if (!after.ok) fail('commands left the workspace readable', after.problems.join('; '));
    else out.mutations = after.changed.map((p) => ({ path: p, generated: workspace.isGenerated(p, policy) }));
    return out;
  }
  // Worktree strategy: commands run in a fresh detached checkout of the pinned commit.
  let commit = null;
  if (plan.mode === 'commit' || plan.mode === 'no_change') {
    const c = plan.candidate;
    commit = c.commit;
    if (gitops.revParse(ctx.paths.projectDir, commit) !== commit || gitops.treeOf(ctx.paths.projectDir, commit) !== c.tree) {
      out.block = { kind: 'candidate_missing', reasons: [`the pinned candidate ${commit} (tree ${c.tree}) is no longer in the repository`] };
      return out;
    }
    out.candidate = Object.assign({}, c);
    if (plan.mode === 'commit') {
      try {
        const ch = workspace.worktreeChanges(ctx.paths.projectDir, c.integration_head, commit);
        out.files = ch.files;
        const sc = verify.checkScope(ch.files, plan.task.authorized_files || []);
        out.scope = Object.assign(sc, { ignored: [], generated: [], basis: `git diff ${ch.base.slice(0, 12)}..${commit.slice(0, 12)} (merge base with the dispatch integration head)` });
        out.diff = { base: ch.base, commit };
      } catch (e) {
        out.scope = { ok: false, violations: [], ignored: [], generated: [], basis: `the candidate's changes cannot be listed: ${e.message}` };
        fail('candidate changes listed', e.message);
      }
      const wt = c.worktree ? absProject(env, c.worktree) : null;
      if (wt && fs.existsSync(wt)) {
        try {
          const left = workspace.uncommittedFiles(wt);
          if (left.length) fail('work committed', `uncommitted changes in the worktree: ${left.join(', ')}`);
        } catch (e) {
          fail('work committed', `the worktree status cannot be read (${e.message}); uncommitted work cannot be ruled out`);
        }
        const head = gitops.revParse(wt, 'HEAD');
        if (head && head !== commit) out.notes.push(`the worktree HEAD moved to ${head} after the report; the pinned candidate ${commit} is verified, and a newer commit needs a new attempt`);
      } else if (wt) {
        out.notes.push(`the worker worktree ${wt} no longer exists; the pinned candidate commit is verified from the repository`);
      }
    } else {
      out.scope = { ok: true, violations: [], ignored: [], generated: [], basis: 'no change: the candidate is the integration head the task was dispatched with' };
    }
  } else if (plan.mode === 'readonly') {
    const intDir = integrationDir(ctx);
    commit = gitops.revParse(intDir, 'HEAD');
    out.candidate = { kind: 'readonly', attempt_id: plan.attemptId, commit, tree: commit ? gitops.treeOf(intDir, commit) : null };
    const violations = [];
    try {
      const dirty = workspace.uncommittedFiles(intDir);
      violations.push(...dirty);
      const ops = gitops.operationsInProgress(intDir);
      if (ops.length) fail('integration worktree untouched', `an unfinished git operation: ${ops.join(', ')}`);
    } catch (e) {
      fail('integration worktree untouched', `its status cannot be read: ${e.message}`);
    }
    const foreign = foreignIntegrationCommits(ctx, plan.dispatchHead, commit);
    if (foreign.length) fail('integration branch moved only by oo', `commits not created by oo since the dispatch: ${foreign.join(', ')}`);
    out.files = violations;
    out.scope = { ok: violations.length === 0, violations, ignored: [], generated: [], basis: 'read-only task: the integration worktree must stay clean and its branch may move only by oo\'s merges' };
  }
  if (!commit) {
    out.block = { kind: 'candidate_missing', reasons: ['no candidate commit to verify'] };
    return out;
  }
  let dir = null;
  try {
    dir = cleanCheckout(ctx, `verify-${plan.task.task_id}`, commit);
  } catch (e) {
    out.block = { kind: 'checkout_failed', reasons: [`a clean checkout of ${commit} could not be created: ${e.message}`] };
    return out;
  }
  out.cwd = dir;
  out.cr = runChecked(dir, plan.setup, plan.cmds, plan.copts);
  try {
    out.mutations = checkoutMutations(dir, policy);
  } catch (e) {
    fail('commands left the checkout readable', e.message);
  }
  out.notes.push(`clean checkout ${relProject(env, dir)}: ${out.mutations.some((m) => !m.generated) ? 'kept as evidence' : dropCheckout(ctx, dir)}`);
  return out;
}

function runVerify(env, id, o) {
  const prep = locked(env, () => {
    const ctx = openRun(env);
    let t = getTask(ctx, id);
    if (!['IMPLEMENTED', 'VERIFYING'].includes(t.status)) {
      const why = `${id} is ${t.status}; verification runs on IMPLEMENTED tasks (or re-runs on VERIFYING)`;
      refuse(`verification of ${id} not started`, why, firstNext(ctx, 'oo status'));
    }
    const takeoverNote = opGate(t.pending_op, `verification of ${id}`, o.takeover);
    checkRepoGuard(ctx, `verification of ${id}`);
    const checks = (t.evidence && t.evidence.checks) || [];
    // A correction round may add commands of its own (verification_commands of the correction request).
    const roundNo = t.review_round || 0;
    const corr = roundNo > 0 ? (t.corrections || []).filter((c) => c && c.round === roundNo).pop() : null;
    const correctionCmds = ((corr && corr.verification_commands) || []).filter((c) => !(t.verification_commands || []).includes(c));
    const cmds = (t.verification_commands || []).concat(correctionCmds);
    if (!cmds.length && !checks.length) {
      refuse(`verification of ${id} not started`, `${id} has no verification_commands and no manual check is recorded`,
        `inspect the result yourself and record it with oo check ${id} --name <name> --result pass|fail --note <text>, then oo verify ${id}`);
    }
    const ws = ctx.run.workspace || {};
    const d = t.dispatch || {};
    let mode;
    if (ws.strategy !== 'worktree') mode = 'shared';
    else if (t.candidate && (t.candidate.kind === 'commit' || t.candidate.kind === 'no_change')) mode = t.candidate.kind;
    else if (d.mode === 'readonly') mode = 'readonly';
    else {
      // An isolated task without a recorded candidate: there is no authoritative evidence.
      t = move(ctx, t, 'BLOCKED', { kind: 'evidence_missing', reason: 'no candidate was recorded for the worker\'s attempt (no bound worktree and no no-change record); its work cannot be verified' });
      persist(ctx, { command: 'verify', task_id: id, outcome: 'evidence_missing' });
      return { blocked: true, reasons: [t.block.reason] };
    }
    if (mode === 'shared' && !(t.baseline && t.baseline.snapshot)) {
      t = move(ctx, t, 'BLOCKED', { kind: 'evidence_missing', reason: 'no baseline snapshot is recorded for this task; changes since its dispatch cannot be established' });
      persist(ctx, { command: 'verify', task_id: id, outcome: 'evidence_missing' });
      return { blocked: true, reasons: [t.block.reason] };
    }
    if (t.status === 'IMPLEMENTED') t = move(ctx, t, 'VERIFYING', { reason: 'verification started' });
    t.pending_op = newOp('verify', { attempt_id: d.attempt_id || null, round: roundNo });
    if (takeoverNote) t.history.push({ ts: ctx.now, from: t.status, to: t.status, reason: takeoverNote, actor: 'oo' });
    touch(ctx, t);
    persist(ctx, { command: 'verify', task_id: id, phase: 'start', op: t.pending_op.id });
    return {
      opId: t.pending_op.id, attemptId: d.attempt_id || null, mode, cmds, correctionCmds, takeoverNote,
      plan: {
        mode, task: structuredClone(t), cmds, setup: setupCommands(ctx), copts: commandOpts(ctx), attemptId: d.attempt_id || null,
        candidate: t.candidate, root: ctx.paths.projectDir, baseline: t.baseline && t.baseline.snapshot, baselineAt: t.baseline && t.baseline.at,
        dispatchHead: d.integration_head || null,
      },
    };
  });
  if (prep.blocked) {
    say(env, `VERIFICATION NOT POSSIBLE: ${id} -> BLOCKED (kind evidence_missing)`, ...prep.reasons.map((r) => `  - ${r}`),
      `NEXT: find out what happened to the attempt; then oo unblock ${id} --reason <text> to dispatch it again${(prep.reasons[0] || '').includes('baseline') ? ` (a shared-workspace task without a baseline gets a new one only with oo rebaseline ${id} --reason <text> --user-authorized)` : ''}`);
    return 1;
  }

  // Outside the lock: snapshots, clean checkouts and commands. A refreshed view of the tasks is
  // read for attribution (other tasks' recorded candidates), without holding the lock.
  let ev;
  try {
    const view = openRun(env);
    ev = gatherVerification(view, prep.plan);
  } catch (e) {
    ev = { block: { kind: 'evidence_error', reasons: [e.message] }, cr: { passed: null, shell: null, commands: [], env_removed: [] } };
  }

  return locked(env, () => {
    const ctx = openRun(env);
    let t = getTask(ctx, id);
    if (t.status !== 'VERIFYING' || !t.pending_op || t.pending_op.id !== prep.opId || (t.dispatch && t.dispatch.attempt_id) !== prep.attemptId) {
      refuse(`verification result for ${id} discarded`, `the verification ${prep.opId} is no longer current (${id} is ${t.status}${t.pending_op ? `, current operation ${t.pending_op.id}` : ''})`, firstNext(ctx, 'oo status'));
    }
    t.pending_op = null;
    if (ev.block) {
      const n = (t.verification_runs || 0) + 1;
      t.verification_runs = n;
      const evRel = store.writeEvidence(ctx.paths, ctx.run.run_id, `${id}-verify-${n}.txt`, evidenceText(
        `Verification ${n} of ${id}: evidence could not be established`, { at: ctx.now, cwd: ev.cwd || '(none)', shell: null, passed: false, reasons: ev.block.reasons }));
      t = move(ctx, t, 'BLOCKED', { kind: ev.block.kind, reason: oneLine(ev.block.reasons.join('; '), 400) });
      persist(ctx, { command: 'verify', task_id: id, outcome: ev.block.kind });
      say(env, `VERIFICATION NOT POSSIBLE: ${id} -> BLOCKED (kind ${ev.block.kind})`, ...ev.block.reasons.map((r) => `  - ${r}`), `Evidence: ${absProject(env, evRel)}`,
        `NEXT: fix the cause; a missing or incomplete snapshot is never treated as "no change". Then oo unblock ${id} --reason <text>${ev.block.kind === 'evidence_missing' ? ` (and, if the baseline itself is gone, oo rebaseline ${id} --reason <text> --user-authorized)` : ''}`);
      return 1;
    }
    const cr = ev.cr;
    const storedChecks = (t.evidence && t.evidence.checks) || [];
    const mutated = (ev.mutations || []).filter((m) => !m.generated).map((m) => m.path);
    const extra = ev.extraChecks.slice();
    if (mutated.length) extra.push({ name: 'commands left the sources unchanged', result: 'fail', note: `the verification commands changed ${mutated.join(', ')}; evidence produced by commands that rewrite sources is not accepted (add true build outputs to verification.generated_artifacts)` });
    const allChecks = storedChecks.concat(extra);
    const v = verify.verdict({ commandsResult: cr, checks: allChecks, scope: ev.scope });
    const n = (t.verification_runs || 0) + 1;
    const evRel = store.writeEvidence(ctx.paths, ctx.run.run_id, `${id}-verify-${n}.txt`, evidenceText(
      `Verification ${n} of ${id} (round ${t.review_round || 0}, attempt ${prep.attemptId || '?'})`,
      { at: ctx.now, cwd: ev.cwd, shell: cr.shell, basis: ev.scope.basis, files: ev.files, scope: ev.scope, checks: allChecks, commands: cr.commands, passed: v.passed, reasons: v.reasons,
        correctionCommands: prep.correctionCmds, candidate: ev.candidate, envRemoved: cr.env_removed, mutations: ev.mutations, notes: ev.notes.concat(prep.takeoverNote ? [prep.takeoverNote] : []) }));
    t.verification_runs = n;
    t.evidence.verification = {
      passed: v.passed, run_at: ctx.now, shell: cr.shell, workspace: ev.cwd ? relProject(env, ev.cwd) : null, attempt_id: prep.attemptId,
      commands: cr.commands, checks: allChecks, scope: { ok: ev.scope.ok, violations: ev.scope.violations, ignored: ev.scope.ignored || [], generated: ev.scope.generated || [], basis: ev.scope.basis },
      changed_files: ev.files, reasons: v.reasons, evidence_file: evRel, correction_commands: prep.correctionCmds,
      candidate: ev.candidate, candidate_id: candidateId(ev.candidate), mutations: ev.mutations, env_removed: cr.env_removed || [], notes: ev.notes,
      diff: ev.diff ? { cwd: '.', base: ev.diff.base, commit: ev.diff.commit } : null,
    };
    touch(ctx, t);
    ctx.run.usage = budget.recordVerification(ctx.run.usage, id);
    if (v.passed) t = move(ctx, t, 'REVIEWING', { reason: `verification passed (candidate ${candidateId(ev.candidate)})` });
    else t = move(ctx, t, 'CORRECTION_REQUIRED', { reason: `verification failed: ${v.reasons.join('; ')}` });
    persist(ctx, { command: 'verify', task_id: id, passed: v.passed });

    const evAbs = absProject(env, evRel);
    if (v.passed) {
      say(env, `VERIFICATION PASSED: ${id} -> REVIEWING`, ...v.reasons.map((r) => `  ${r}`));
      say(env, `Candidate: ${candidateId(ev.candidate)}`);
      if (cr.commands.length) say(env, 'Commands:', ...commandLines(cr.commands));
      say(env, `Changed files: ${ev.files.length ? ev.files.join(', ') : 'none'}`);
      for (const g of ev.scope.ignored || []) say(env, `Attributed elsewhere: ${g.file} (${g.basis})`);
      for (const nn of ev.notes) say(env, `Note: ${nn}`);
      say(env, `Evidence: ${evAbs}`);
      const needsIndependent = t.routing && (t.routing.independent_review || t.routing.role === 'orchestrator');
      say(env, needsIndependent
        ? `NEXT: oo review-package ${id} (an independent review is required), then oo review ${id} --stdin --agent-id <id> for each review`
        : `NEXT: oo review ${id} --stdin with your own review (reviewer: orchestrator)`);
      return 0;
    }
    say(env, `VERIFICATION FAILED: ${id} -> CORRECTION_REQUIRED`, ...v.reasons.map((r) => `  - ${r}`));
    const failing = cr.commands.filter((c) => c.refused || c.timed_out || (!c.skipped && c.exit_code !== 0));
    for (const c of failing) {
      say(env, `Failing command: ${c.command}${c.setup ? ' (setup)' : ''}`, `Exit code: ${c.refused ? 'refused' : c.timed_out ? 'timed out' : c.exit_code}${c.reason ? ` (${c.reason})` : ''}`, 'Output tail:', ...indent(c.output_tail || '(no output)', '  | '));
    }
    const skipped = cr.commands.filter((c) => c.skipped);
    if (skipped.length) say(env, `Not run after the failure: ${skipped.map((c) => c.command).join(' ; ')}`);
    if (!ev.scope.ok) say(env, `Scope violations (changed outside the authorized files, not attributable to another task's recorded content): ${ev.scope.violations.join(', ')}`);
    for (const g of ev.scope.ignored || []) say(env, `Attributed elsewhere: ${g.file} (${g.basis})`);
    for (const nn of ev.notes) say(env, `Note: ${nn}`);
    say(env, `Evidence: ${evAbs}`);
    say(env, `NEXT: oo correct ${id} --stdin with a correction request (failure, evidence, expected_behavior, required_change, verification, verification_commands (a command that fails before the fix and passes after it, when one exists)${(t.review_round || 0) >= 1 ? ', strategy_change' : ''})`);
    return 1;
  });
}

function cmdVerify(env, a) {
  cliargs.checkAllowed(a.opts, ['takeover'], 'verify');
  const id = a.pos[0];
  if (!id) usage('verify needs a task id: oo verify <ID>');
  return runVerify(env, id, { takeover: a.opts.takeover });
}

function cmdCheck(env, a) {
  cliargs.checkAllowed(a.opts, ['name', 'result', 'note'], 'check');
  const id = a.pos[0];
  if (!id) usage('check needs a task id: oo check <ID> --name N --result pass|fail --note T');
  const name = typeof a.opts.name === 'string' ? a.opts.name.trim() : '';
  if (!name) usage('--name <check name> is required');
  if (!['pass', 'fail'].includes(a.opts.result)) usage('--result must be pass or fail');
  const note = typeof a.opts.note === 'string' ? a.opts.note.trim() : '';
  if (!note) usage('--note <what you checked and saw> is required');
  return locked(env, () => {
    const ctx = openRun(env);
    const t = getTask(ctx, id);
    if (!['IMPLEMENTED', 'VERIFYING'].includes(t.status)) {
      refuse(`check for ${id} not recorded`, `${id} is ${t.status}; manual checks are recorded in IMPLEMENTED or VERIFYING`, firstNext(ctx, 'oo status'));
    }
    t.evidence = t.evidence || {};
    t.evidence.checks = (t.evidence.checks || []).concat([{ name, result: a.opts.result, note, recorded_at: ctx.now }]);
    touch(ctx, t);
    ctx.events.push({ type: 'check', task_id: id, name, result: a.opts.result });
    persist(ctx, { command: 'check', task_id: id });
    say(env, `CHECK RECORDED: ${id} ${name} = ${a.opts.result}`, `NEXT: oo verify ${id}`);
    return 0;
  });
}

// ---------------------------------------------------------------------------
// reviews
// ---------------------------------------------------------------------------

/**
 * Pinned evidence for a reviewer that has no shell: the diff of the verified candidate commit
 * (worktree strategy) or the verified content of the candidate's files (shared workspace). Files
 * matching security.protected_paths are listed without their content.
 */
function pinnedReviewEvidence(ctx, t, n) {
  const v = t.evidence.verification || {};
  const c = v.candidate || {};
  const protectedPaths = (ctx.cfg.security && ctx.cfg.security.protected_paths) || [];
  const lines = [`Pinned review evidence for ${t.task_id}, candidate ${candidateId(c)}, verified at ${v.run_at}.`, ''];
  if (c.kind === 'commit' && v.diff && v.diff.base) {
    lines.push(`git diff ${v.diff.base} ${c.commit} (no external diff programs, no text conversion), file by file:`, '');
    let total = 0;
    for (const f of gitops.changedFiles(ctx.paths.projectDir, v.diff.base, c.commit)) {
      if (security.isProtectedPath(f, protectedPaths)) { lines.push(`=== ${f}`, '(protected path: content not included)'); continue; }
      const room = 2 * 1024 * 1024 - total;
      if (room <= 0) { lines.push(`=== ${f}`, '(not included: the evidence file reached 2 MB; read the file at the candidate commit)'); continue; }
      const d = gitops.git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', v.diff.base, c.commit, '--', `:(literal)${f}`], { cwd: ctx.paths.projectDir });
      const text = d.code === 0 ? d.stdout : `(the diff of ${f} could not be produced: ${d.stderr.trim()})`;
      lines.push(text.length > room ? `${text.slice(0, room)}\n(truncated at 2 MB)` : text);
      total += Math.min(text.length, room);
    }
  } else if (c.kind === 'shared') {
    let total = 0;
    for (const f of Object.keys(c.files || {}).sort()) {
      lines.push(`=== ${f} (${c.files[f] === null ? 'deleted' : c.files[f]})`);
      if (c.files[f] === null) continue;
      if (security.isProtectedPath(f, protectedPaths)) { lines.push('(protected path: content not included)'); continue; }
      if (!String(c.files[f]).startsWith('sha256:')) { lines.push('(not a regular file)'); continue; }
      const buf = fs.readFileSync(path.join(ctx.paths.projectDir, ...f.split('/')));
      if (buf.includes(0)) { lines.push(`(binary, ${buf.length} bytes)`); continue; }
      const room = 2 * 1024 * 1024 - total;
      if (room <= 0) { lines.push('(not included: the evidence file reached 2 MB; read the file itself)'); continue; }
      const text = buf.toString('utf8');
      lines.push(text.length > room ? `${text.slice(0, room)}\n(truncated at 2 MB)` : text);
      total += Math.min(text.length, room);
    }
  } else {
    lines.push(c.kind === 'readonly' ? 'Read-only task: no file was changed; review its report and the verification evidence.' : 'No change: the candidate is the integration head the task was dispatched with.');
  }
  return writeRunFile(ctx.env, ctx.run.run_id, `packages/${t.task_id}-review-${n}.evidence.txt`, lines.join('\n') + '\n');
}

function cmdReviewPackage(env, a) {
  cliargs.checkAllowed(a.opts, ['inline'], 'review-package');
  const id = a.pos[0];
  if (!id) usage('review-package needs a task id');
  return locked(env, () => {
    const ctx = openRun(env);
    let t = getTask(ctx, id);
    if (t.status !== 'REVIEWING') {
      refuse(`no review package for ${id}`, `${id} is ${t.status}; an independent review starts after verification passed (REVIEWING)`, firstNext(ctx, 'oo status'));
    }
    const chk = budgetCheck(ctx);
    const remaining = budget.remainingCalls(ctx.run.usage, ctx.cfg.budget, ctx.run.authorizations);
    if (chk.state === 'exceeded' || remaining < 1) {
      refuse(`no review package for ${id}: the budget is exceeded`, chk.messages.length ? chk.messages : ['no agent calls remain'], 'ask the user; a higher limit is recorded only with oo authorize --limit agent_call_limit --value <n> --by user --reason <text>');
    }
    const v = t.evidence.verification || {};
    if (!v.candidate) {
      refuse(`no review package for ${id}`, 'the passed verification recorded no candidate (it predates candidate binding)', `run the verification again: oo block ${id} --reason <text>, oo unblock ${id} --reason <text>, and repeat the attempt`);
    }
    if (v.candidate.kind === 'shared') {
      const intact = sharedCandidateIntact(ctx, v.candidate);
      if (!intact.ok) {
        t = move(ctx, t, 'CORRECTION_REQUIRED', { kind: 'candidate_changed', reason: `the verified files changed after verification: ${intact.problem || intact.changed.join(', ')}` });
        persist(ctx, { command: 'review-package', task_id: id, outcome: 'candidate_changed' });
        say(env, `CANDIDATE CHANGED: ${id} -> CORRECTION_REQUIRED`, `  the verified content of ${intact.changed.join(', ') || intact.problem} is no longer in the workspace; a review of different content would not bind to the verified candidate`,
          `NEXT: oo correct ${id} --stdin (the next attempt is verified again)`);
        return 1;
      }
    }
    const role = t.security_sensitive ? 'security-worker' : 'review-worker';
    const floor = t.routing && MODEL_ORDER.includes(t.routing.model) ? t.routing.model : 'auto';
    const rspec = Object.assign({}, t, { kind: 'review', assigned_role: role, assigned_model: floor });
    const rr = routing.route(rspec, ctx.cfg, readStats(ctx), ctx.run.options.mode);
    const agent = rr.agent || 'opus-reviewer';
    const n = (t.review_packages || 0) + 1;
    const reviewId = `${id}-r${n}-${require('node:crypto').randomBytes(3).toString('hex')}`;
    const pinned = pinnedReviewEvidence(ctx, t, n);
    const changes = { kind: 'pinned', file: pinned, files: v.changed_files || [], reported: (t.result && t.result.files_changed) || [] };
    const evidenceFiles = [v.evidence_file, t.result && t.result.report_file].filter(Boolean).map((f) => absProject(env, f));
    const text = packages.reviewPackage(t, {
      reviewer: agent, reviewId, changes, evidenceFiles, candidate: candidateId(v.candidate),
      verificationSummary: v.passed ? `passed at ${v.run_at}: ${(v.reasons || []).join('; ')}` : 'not passed',
    });
    const file = writeRunFile(env, ctx.run.run_id, `packages/${id}-review-${n}.md`, text);
    t.review_packages = n;
    t.review_dispatches = (t.review_dispatches || []).concat([{
      review_id: reviewId, n, round: t.review_round || 0, attempt_id: t.dispatch && t.dispatch.attempt_id, perspective: role, agent, model: rr.model,
      candidate_id: candidateId(v.candidate), issued_at: ctx.now, status: 'issued', package: relProject(env, file), evidence: relProject(env, pinned),
    }]);
    // The current round's evidence records the package; a correction archives it, so each round needs its own.
    t.evidence.review_packages = (t.evidence.review_packages || []).concat([{ n, at: ctx.now, round: t.review_round || 0, file: relProject(env, file), review_id: reviewId }]);
    touch(ctx, t);
    ctx.run.usage = budget.recordCall(ctx.run.usage, { task_id: id, kind: 'review' });
    persist(ctx, { command: 'review-package', task_id: id, n, review_id: reviewId });
    const target = agentTarget(env, agent);
    say(env, `REVIEW PACKAGE ${id} #${n} (review ${reviewId}; independent review of candidate ${candidateId(v.candidate)}; model routed for a review of complexity ${t.complexity}, at least the worker's model)`);
    say(env, packages.agentCallLine({ subagentType: target.subagentType, model: rr.model, description: packages.describeTask({ task_id: `${id} review`, title: t.title }) }));
    if (target.agentFile) say(env, `(agent ${agent} is not installed in .claude/agents; the prompt tells general-purpose to read its definition first, and general-purpose has a shell: install the agents for a read-only reviewer)`);
    if (a.opts.inline) printPrompt(env, (target.agentFile ? `First read ${target.agentFile} and follow it as your role definition.\n\n` : '') + text);
    else printPrompt(env, packages.shortPrompt(file, target.agentFile));
    say(env, `NEXT: launch the reviewer, then oo review ${id} --stdin --agent-id <the agent id the Agent tool returned> with its report (if the reviewer is lost: oo review-abandon ${id} --review ${reviewId} --reason <text>)`);
    return 0;
  });
}

/** Approving independent reviews a high-risk task needs in this round (mode setting reviewers_high_risk); 1 for other tasks. */
function highRiskReviewers(ctx, t) {
  if (t.risk !== 'high') return 1;
  const mode = ((ctx.cfg.verification || {}).modes || {})[ctx.run.options.mode] || {};
  return Number.isInteger(mode.reviewers_high_risk) && mode.reviewers_high_risk > 1 ? mode.reviewers_high_risk : 1;
}

/** Approving independent reviews of the current round from distinct reviewer agents. */
function distinctApprovals(t) {
  const ids = new Set();
  for (const r of (t.evidence.reviews || [])) if (r.independent && r.verdict === 'approve') ids.add(r.agent_id || r.review_id || r.reviewer);
  return ids.size;
}

function cmdReview(env, a) {
  cliargs.checkAllowed(a.opts, ['stdin', 'file', 'integrate', 'agent-id'], 'review');
  const id = a.pos[0];
  if (!id) usage('review needs a task id: oo review <ID> --stdin');
  const agentId = a.opts['agent-id'] !== undefined ? String(a.opts['agent-id']).trim() : null;
  if (agentId !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(agentId)) usage('--agent-id must be the agent id the host printed (letters, digits, . _ : -)');
  const text = readInput(a);
  let approved = false;
  const code = locked(env, () => {
    const ctx = openRun(env);
    let t = getTask(ctx, id);
    if (t.status !== 'REVIEWING') {
      const why = {
        IMPLEMENTED: `verification of ${id} has not passed yet (the task is IMPLEMENTED); a review is accepted only after verification passed`,
        VERIFYING: `verification of ${id} has not passed yet (the task is VERIFYING)`,
        CORRECTION_REQUIRED: `${id} needs a correction (verification or a review failed); it cannot be reviewed or approved in this round`,
        APPROVED: `${id} is already APPROVED`,
      }[t.status] || `${id} is ${t.status}; reviews are accepted only in REVIEWING`;
      refuse(`review of ${id} refused; task state unchanged`, why, firstNext(ctx, 'oo status'));
    }
    const failNext = 'fix the review report (DESIGN 3.5: one criteria entry per acceptance criterion, findings unless approve) and repeat';
    const obj = parseReportBlock(text, 'review', id, failNext);
    const v = reports.validateReview(obj, t);
    if (!v.ok) refuse(`review of ${id} rejected; task state unchanged`, v.errors, failNext);
    const rv = v.review;
    const independent = rv.reviewer !== 'orchestrator';
    const round = t.review_round || 0;
    const unchanged = `review of ${id} refused; task state unchanged`;
    const ver = t.evidence.verification || {};
    let dispatch = null;
    if (independent) {
      if (!(t.evidence.review_packages || []).length) {
        refuse(unchanged,
          `the reviewer is ${JSON.stringify(rv.reviewer)}, not orchestrator, and no review package was issued for ${id} in the current round (round ${round}); an independent review is accepted only from a reviewer launched with oo review-package in this round`,
          `oo review-package ${id}, launch the reviewer it prints, then oo review ${id} --stdin --agent-id <id> with that reviewer's report (for your own quality gate use reviewer: orchestrator)`);
      }
      const rid = typeof rv.review_id === 'string' ? rv.review_id.trim() : '';
      dispatch = (t.review_dispatches || []).find((x) => x.review_id === rid) || null;
      const why = [];
      if (!rid) why.push('the review report has no review_id (copy it from the report block of the review package)');
      else if (!dispatch) why.push(`review ${rid} was never issued for ${id}`);
      else {
        if (dispatch.status === 'abandoned') why.push(`review ${rid} was abandoned at ${dispatch.abandoned_at} (${dispatch.abandon_reason}); a late report of an abandoned review is never applied`);
        if (dispatch.status === 'recorded') why.push(`review ${rid} was already recorded at ${dispatch.recorded_at}; a duplicate report is not applied`);
        if (dispatch.round !== round) why.push(`review ${rid} was issued for round ${dispatch.round}, and the task is in round ${round}`);
        if (dispatch.attempt_id !== (t.dispatch && t.dispatch.attempt_id)) why.push(`review ${rid} was issued for attempt ${dispatch.attempt_id}, and the current attempt is ${t.dispatch && t.dispatch.attempt_id}`);
        if (dispatch.candidate_id !== ver.candidate_id) why.push(`review ${rid} reviewed candidate ${dispatch.candidate_id}, and the verified candidate is ${ver.candidate_id}`);
      }
      if (!agentId) why.push('an independent review needs --agent-id <the agent id the Agent tool returned for this reviewer>, so that distinct reviewers can be told apart');
      else {
        if (t.result && t.result.agent_id && t.result.agent_id === agentId) why.push(`agent ${agentId} is the worker that produced this result; it cannot review its own work`);
        const same = (t.review_dispatches || []).find((x) => x.status === 'recorded' && x.round === round && x.agent_id === agentId);
        if (same) why.push(`agent ${agentId} already recorded review ${same.review_id} in this round; a second report from the same agent is not a second independent review`);
      }
      if (why.length) refuse(unchanged, why, `only the report of an issued, still open review of the verified candidate is accepted; a lost reviewer is replaced with oo review-abandon ${id} --review <id> --reason <text> and a new oo review-package ${id}`);
    }
    // Integrity: the reviewed candidate must still be what verification saw.
    if (ver.candidate && ver.candidate.kind === 'shared') {
      const intact = sharedCandidateIntact(ctx, ver.candidate);
      if (!intact.ok) {
        t = move(ctx, t, 'CORRECTION_REQUIRED', { kind: 'candidate_changed', reason: `the verified files changed after verification: ${intact.problem || intact.changed.join(', ')}` });
        persist(ctx, { command: 'review', task_id: id, outcome: 'candidate_changed' });
        say(env, `CANDIDATE CHANGED: ${id} -> CORRECTION_REQUIRED; the review was not recorded`, `  changed since verification: ${intact.changed.join(', ') || intact.problem}`, `NEXT: oo correct ${id} --stdin`);
        return 1;
      }
    }
    const n = ((t.evidence.reviews || []).length) + 1;
    const entry = {
      reviewer: rv.reviewer, independent, verdict: rv.verdict, criteria: rv.criteria, findings: rv.findings || [],
      checks: rv.checks || {}, recorded_at: ctx.now, round, report_file: null,
      review_id: dispatch ? dispatch.review_id : null, agent_id: independent ? agentId : null, candidate_id: ver.candidate_id || null,
    };
    t.evidence.reviews = (t.evidence.reviews || []).concat([entry]);
    if (dispatch) {
      t.review_dispatches = t.review_dispatches.map((x) => (x.review_id === dispatch.review_id ? Object.assign({}, x, { status: 'recorded', recorded_at: ctx.now, agent_id: agentId, verdict: rv.verdict }) : x));
    }
    touch(ctx, t);
    let outcome;
    if (rv.verdict === 'approve') {
      if (independent) {
        outcome = 'independent_approve';
      } else {
        const requires = !!(t.routing && (t.routing.independent_review || t.routing.role === 'orchestrator'));
        const needed = highRiskReviewers(ctx, t);
        const have = distinctApprovals(t);
        if (needed > 1 && have < needed) {
          refuse(`approval of ${id} refused; task state unchanged`,
            `${id} is high risk and mode ${ctx.run.options.mode} requires ${needed} approving independent reviews from distinct reviewer agents in the current round (round ${round}); ${have} recorded`,
            `oo review-package ${id}, launch the next reviewer, record its report with oo review ${id} --stdin --agent-id <id> until ${needed} approve, then approve again`);
        }
        t = move(ctx, t, 'APPROVED', { reason: `approved by the orchestrator (candidate ${ver.candidate_id || '?'})`, requiresIndependentReview: requires });
        outcome = 'approved';
      }
    } else {
      const f = (rv.findings || []).map((x) => `${x.severity}: ${x.description}`).join('; ');
      t = move(ctx, t, 'CORRECTION_REQUIRED', { reason: `${independent ? 'independent review' : 'orchestrator review'} ${rv.verdict}: ${oneLine(f, 300)}` });
      outcome = 'changes';
    }
    const file = writeRunFile(env, ctx.run.run_id, `reviews/${id}-c${round}-${n}.yaml`, yaml.stringify(rv));
    const cur = ctx.byId.get(id);
    cur.evidence.reviews[cur.evidence.reviews.length - 1].report_file = relProject(env, file);
    touch(ctx, cur);
    ctx.events.push({ type: 'review', task_id: id, reviewer: rv.reviewer, verdict: rv.verdict, independent, review_id: entry.review_id, agent_id: entry.agent_id });
    persist(ctx, { command: 'review', task_id: id, outcome });

    if (outcome === 'independent_approve') {
      const needed = highRiskReviewers(ctx, ctx.byId.get(id));
      const have = distinctApprovals(ctx.byId.get(id));
      say(env, `INDEPENDENT REVIEW RECORDED: ${id} approved by ${rv.reviewer} (review ${entry.review_id}, agent ${agentId}); ${id} stays REVIEWING until your own gate`,
        have < needed
          ? `NEXT: ${id} is high risk and needs ${needed} approving independent reviews from distinct reviewer agents in this round (${have} so far): oo review-package ${id}, launch the next reviewer, then oo review ${id} --stdin --agent-id <id>`
          : `NEXT: oo review ${id} --stdin with your own review (reviewer: orchestrator)`);
    } else if (outcome === 'approved') {
      approved = true;
      say(env, `APPROVED: ${id} -> APPROVED`);
      if (!a.opts.integrate) say(env, `NEXT: oo integrate ${id}`);
    } else {
      say(env, `CHANGES REQUESTED: ${id} -> CORRECTION_REQUIRED (${rv.reviewer}: ${rv.verdict})`,
        ...(rv.findings || []).map((x) => `  - [${x.severity}] ${x.file ? `${x.file}: ` : ''}${x.description}`),
        `NEXT: oo correct ${id} --stdin with a correction request built from these findings`);
    }
    return 0;
  });
  if (code === 0 && approved && a.opts.integrate) return runIntegrate(env, id, {});
  return code;
}

function cmdReviewAbandon(env, a) {
  cliargs.checkAllowed(a.opts, ['review', 'reason'], 'review-abandon');
  const id = a.pos[0];
  if (!id || typeof a.opts.review !== 'string') usage('review-abandon needs a task id and --review <review id>: oo review-abandon <ID> --review <RID> --reason <text>');
  const reason = needReason(a);
  return locked(env, () => {
    const ctx = openRun(env);
    const t = getTask(ctx, id);
    const d = (t.review_dispatches || []).find((x) => x.review_id === a.opts.review);
    if (!d) refuse(`review ${a.opts.review} not abandoned`, `no review ${a.opts.review} was issued for ${id}`, 'oo status');
    if (d.status !== 'issued') refuse(`review ${a.opts.review} not abandoned`, `review ${a.opts.review} is ${d.status}`, 'only an issued review whose report has not been recorded can be abandoned');
    t.review_dispatches = t.review_dispatches.map((x) => (x.review_id === d.review_id ? Object.assign({}, x, { status: 'abandoned', abandoned_at: ctx.now, abandon_reason: reason }) : x));
    touch(ctx, t);
    ctx.events.push({ type: 'review_abandoned', task_id: id, review_id: d.review_id, reason });
    persist(ctx, { command: 'review-abandon', task_id: id, review_id: d.review_id });
    say(env, `REVIEW ABANDONED: ${d.review_id} of ${id} (${reason}); a late report from it is refused`, `NEXT: ${t.status === 'REVIEWING' ? `oo review-package ${id} to issue a replacement review` : firstNext(ctx, 'oo status')}`);
    return 0;
  });
}

// ---------------------------------------------------------------------------
// correct
// ---------------------------------------------------------------------------

function cmdCorrect(env, a) {
  cliargs.checkAllowed(a.opts, ['stdin', 'file'], 'correct');
  const id = a.pos[0];
  if (!id) usage('correct needs a task id: oo correct <ID> --stdin');
  const text = readInput(a);
  return locked(env, () => {
    const ctx = openRun(env);
    let t = getTask(ctx, id);
    if (t.status !== 'CORRECTION_REQUIRED') {
      refuse(`correction for ${id} refused`, `${id} is ${t.status}; a correction request is accepted only in CORRECTION_REQUIRED`, firstNext(ctx, 'oo status'));
    }
    const lim = limits(ctx);
    const used = t.review_round || 0;
    if (used >= lim.max_review_rounds) {
      refuse(`correction for ${id} refused`, `the correction round limit is reached: ${used} of ${lim.max_review_rounds} rounds used`,
        `diagnose the failure yourself, then either oo fail ${id} --reason <text> followed by oo escalate ${id} --model <stronger model> --reason <text>, or oo block ${id} --reason <text> and ask the user (more rounds only with oo authorize --limit max_review_rounds --value <n> --by user --reason <text>)`);
    }
    const round = used + 1;
    const failNext = `fix the correction request (DESIGN 3.6${round >= 2 ? '; from round 2 it needs strategy_change' : ''}) and repeat oo correct ${id} --stdin`;
    let obj;
    try {
      const block = yaml.extractYamlBlock(text);
      obj = yaml.parse(block === null ? text : block);
    } catch (e) {
      refuse(`correction for ${id} rejected; task state unchanged`, `not valid YAML (line ${e.line || '?'}): ${e.message}`, failNext);
    }
    const v = reports.validateCorrection(obj, t, { round, extraUnsafe: (ctx.cfg.security && ctx.cfg.security.extra_unsafe_patterns) || [] });
    if (!v.ok) refuse(`correction for ${id} rejected; task state unchanged`, v.errors, failNext);
    const c = Object.assign({}, v.correction, { recorded_at: ctx.now });
    archiveRound(ctx, t, `correction round ${round} requested`);
    t.correction = c;
    t.corrections = (t.corrections || []).concat([c]);
    t = move(ctx, t, 'READY', { reason: `correction round ${round}: ${oneLine(c.required_change, 200)}` });
    t.next_dispatch_kind = 'correction';
    persist(ctx, { command: 'correct', task_id: id, round });
    say(env, `CORRECTION RECORDED: ${id} round ${round} of ${lim.max_review_rounds} -> READY`,
      'The earlier verification and reviews were archived; approval needs a fresh verification and fresh reviews.',
      'NEXT: oo next (the correction request is included in the new worker package)');
    return 0;
  });
}

// ---------------------------------------------------------------------------
// integrate
// ---------------------------------------------------------------------------

function integrationCommands(ctx, t) {
  const cmds = (t.verification_commands || []).slice();
  const mode = (ctx.cfg.verification.modes || {})[ctx.run.options.mode] || {};
  const rc = ctx.cfg.verification.regression_command;
  let regression = false;
  if (rc && (mode.regression === 'always' || (mode.regression === 'risky' && (t.risk === 'high' || t.security_sensitive)))) {
    cmds.push(rc);
    regression = true;
  }
  return { cmds, regression };
}

function runIntegrate(env, id, o) {
  const opts = o || {};
  const prep = locked(env, () => {
    const ctx = openRun(env);
    let t = getTask(ctx, id);
    if (!['APPROVED', 'INTEGRATING'].includes(t.status)) {
      refuse(`integration of ${id} not started`, `${id} is ${t.status}; integration needs an APPROVED task`, firstNext(ctx, 'oo status'));
    }
    const prevOp = t.pending_op && t.pending_op.kind === 'integrate' ? t.pending_op : null;
    const takeoverNote = opGate(t.pending_op, `integration of ${id}`, opts.takeover);
    const ws = ctx.run.workspace || {};
    const ver = t.evidence.verification || {};
    const cand = ver.candidate || null;
    if (!cand) refuse(`integration of ${id} not started`, 'the passed verification recorded no candidate (it predates candidate binding)', `oo block ${id} --reason <text>, then oo unblock to repeat the attempt`);
    const gate = (t.evidence.reviews || []).filter((r) => r.reviewer === 'orchestrator').pop();
    if (!gate || gate.candidate_id !== ver.candidate_id) {
      refuse(`integration of ${id} not started`, `the approval does not name the verified candidate ${ver.candidate_id}`, `review the verified candidate again: oo review ${id} --stdin`);
    }
    const blockWith = (kind, reason) => {
      t.pending_op = null;
      move(ctx, t, 'BLOCKED', { kind, reason });
      persist(ctx, { command: 'integrate', task_id: id, outcome: kind });
      return { blocked: true, kind, reason };
    };
    let plan;
    if (ws.strategy === 'worktree') {
      const other = ctx.tasks.find((x) => x.status === 'INTEGRATING' && x.task_id !== id);
      if (other) refuse(`integration of ${id} not started`, `${other.task_id} is being integrated into the same branch`, `finish it first: oo integrate ${other.task_id}`);
      checkRepoGuard(ctx, `integration of ${id}`);
      const intDir = integrationDir(ctx);
      if (!ws.integration_head) refuse(`integration of ${id} not started`, 'this run predates integration-head tracking', 'finish it by hand or start a new run');
      let dirty;
      let ops;
      try {
        dirty = workspace.uncommittedFiles(intDir);
        ops = gitops.operationsInProgress(intDir);
      } catch (e) {
        return blockWith('integration_unreadable', `the integration worktree's status cannot be read: ${e.message}`);
      }
      if (dirty.length || ops.length) return blockWith('integration_dirty', `the integration worktree is not clean (${dirty.concat(ops).join(', ')}); oo does not merge over changes it did not make`);
      const head = gitops.revParse(intDir, 'HEAD');
      let recover = false;
      if (head !== ws.integration_head) {
        if (prevOp && prevOp.merge_sha && prevOp.merge_sha === head && prevOp.checks_passed === true) recover = true;
        else return blockWith('integration_moved', `the integration branch is at ${head}, but oo last left it at ${ws.integration_head}; something other than oo moved it`);
      }
      plan = {
        mode: cand.kind === 'commit' ? 'merge' : 'check', strategy: 'worktree', expected: ws.integration_head, candidate: cand, recover,
        prev: prevOp, intDir,
      };
    } else {
      const busy = sharedWindowConflict(ctx, t);
      if (busy) refuse(`integration of ${id} not started`, `shared workspace: ${busy.task_id} is ${busy.status} in the same directory, and its changes would mix with this integration`, `finish or verify ${busy.task_id} first, then oo integrate ${id}`);
      const intact = sharedCandidateIntact(ctx, cand);
      if (!intact.ok) {
        t.pending_op = null;
        // APPROVED has no direct way back to a correction; the integration that found the change
        // is what fails, so the task passes through INTEGRATING.
        if (t.status === 'APPROVED') t = move(ctx, t, 'INTEGRATING', { reason: 'integration started' });
        t = move(ctx, t, 'CORRECTION_REQUIRED', { kind: 'candidate_changed', reason: `the verified files changed after verification: ${intact.problem || intact.changed.join(', ')}` });
        persist(ctx, { command: 'integrate', task_id: id, outcome: 'candidate_changed' });
        return { changed: intact.changed.length ? intact.changed : [intact.problem] };
      }
      plan = { mode: 'shared', strategy: 'shared', candidate: cand };
    }
    if (t.status === 'APPROVED') t = move(ctx, t, 'INTEGRATING', { reason: `integration started (candidate ${ver.candidate_id})` });
    t.pending_op = newOp('integrate', { candidate_id: ver.candidate_id, expected_head: plan.expected || null });
    if (plan.recover) Object.assign(t.pending_op, { merge_sha: plan.prev.merge_sha, checks_passed: true, evidence_file: plan.prev.evidence_file || null, recovered_from: plan.prev.id });
    if (takeoverNote) t.history.push({ ts: ctx.now, from: t.status, to: t.status, reason: takeoverNote, actor: 'oo' });
    touch(ctx, t);
    persist(ctx, { command: 'integrate', task_id: id, phase: 'start', op: t.pending_op.id });
    const { cmds, regression } = integrationCommands(ctx, t);
    return Object.assign(plan, {
      opId: t.pending_op.id, title: t.title, cmds, regression, setup: setupCommands(ctx), copts: commandOpts(ctx), policy: generated(ctx),
      runId: ctx.run.run_id, takeoverNote,
    });
  });
  if (prep.blocked) {
    say(env, `INTEGRATION NOT STARTED: ${id} -> BLOCKED (kind ${prep.kind})`, `  ${prep.reason}`, `NEXT: inspect the integration worktree; nothing was merged or forced. Then oo unblock ${id} --reason <text> or ask the user`);
    return 1;
  }
  if (prep.changed) {
    say(env, `CANDIDATE CHANGED: ${id} -> CORRECTION_REQUIRED; nothing was integrated`, `  changed since verification: ${prep.changed.join(', ')}`, `NEXT: oo correct ${id} --stdin`);
    return 1;
  }

  // Outside the lock: merge in a clean checkout, the checks on that exact commit, then the fast-forward.
  const ctxView = openRun(env);
  let outcome;
  const empty = { passed: null, shell: null, commands: [], env_removed: [] };
  const notes = [];
  if (prep.recover) {
    outcome = { kind: 'ok', cwd: prep.intDir, sha: prep.prev.merge_sha, before: prep.expected, cr: empty, mutations: [], merged: true };
    notes.push(`finalized the interrupted integration ${prep.prev.id}: its merge commit ${prep.prev.merge_sha} had passed the checks and was already on the integration branch`);
  } else if (prep.strategy === 'worktree') {
    let dir = null;
    try {
      dir = cleanCheckout(ctxView, `integrate-${id}`, prep.expected);
      let sha = prep.expected;
      let merged = false;
      if (prep.mode === 'merge') {
        const m = gitops.mergeNoCommit(dir, prep.candidate.commit);
        if (m.conflict) {
          gitops.abortMerge(dir);
          outcome = { kind: 'conflict', cwd: dir, files: m.files, before: prep.expected, cr: empty };
        } else {
          sha = gitops.commitMerge(dir, `opus-orch: integrate ${id}: ${prep.title}`);
          merged = sha !== prep.expected;
        }
      }
      if (!outcome) {
        const cr = runChecked(dir, prep.setup, prep.cmds, prep.copts);
        let mutations = [];
        let unreadable = null;
        try {
          mutations = checkoutMutations(dir, prep.policy);
        } catch (e) {
          unreadable = e.message;
        }
        const bad = mutations.filter((x) => !x.generated).map((x) => x.path);
        if (cr.passed === false || bad.length || unreadable) {
          outcome = { kind: 'failed', cwd: dir, before: prep.expected, cr, mutations, reasons: bad.length ? [`the integration commands changed ${bad.join(', ')}`] : unreadable ? [unreadable] : null };
        } else {
          outcome = { kind: 'ok', cwd: dir, sha, before: prep.expected, cr, mutations, merged };
        }
      }
    } catch (e) {
      outcome = { kind: 'merge_failed', cwd: dir || prep.intDir, message: e.message, cr: empty };
    }
    notes.push(`clean integration checkout ${dir ? relProject(env, dir) : '(not created)'}: ${dir && outcome.kind !== 'failed' ? dropCheckout(ctxView, dir) : (dir ? 'kept as evidence' : 'none')}`);
    if (outcome.kind === 'ok' && outcome.merged) {
      // The integration commands ran candidate code; a hook or filter it planted in the shared git
      // directory would run inside the fast-forward below, so the guard is checked again first.
      const guardNow = (() => { try { return gitops.repoGuard(env.paths.projectDir); } catch (e) { return `unreadable: ${e.message}`; } })();
      if (ctxView.run.workspace.repo_guard && guardNow !== ctxView.run.workspace.repo_guard) {
        outcome = { kind: 'merge_failed', cwd: prep.intDir, message: 'the repository configuration, hooks or info files changed while the integration commands ran; the integration branch was not moved (inspect .git/hooks, .git/config and .git/info, then oo repo-guard)', cr: outcome.cr };
      }
    }
    if (outcome.kind === 'ok' && outcome.merged) {
      // Record the verified merge commit before the branch moves, so an interruption can be finalized.
      const recorded = locked(env, () => {
        const ctx = openRun(env);
        const t = getTask(ctx, id);
        if (!t.pending_op || t.pending_op.id !== prep.opId) return false;
        Object.assign(t.pending_op, { merge_sha: outcome.sha, checks_passed: true });
        touch(ctx, t);
        persist(ctx, { command: 'integrate', task_id: id, phase: 'checked', merge_sha: outcome.sha });
        return true;
      });
      if (!recorded) outcome = { kind: 'superseded', cwd: prep.intDir, cr: outcome.cr };
      else {
        const ff = gitops.git(['merge', '--ff-only', outcome.sha], { cwd: prep.intDir });
        if (ff.code !== 0 || gitops.revParse(prep.intDir, 'HEAD') !== outcome.sha) {
          outcome = { kind: 'merge_failed', cwd: prep.intDir, message: `the integration branch could not be fast-forwarded to the checked merge commit ${outcome.sha}: ${(ff.stderr || ff.stdout).trim()}`, cr: outcome.cr };
        }
      }
    }
  } else {
    const root = env.paths.projectDir;
    const pre = gitops.snapshot(root, { ignore: workspace.snapshotIgnore(env.paths) });
    const cr = runChecked(root, prep.setup, prep.cmds, prep.copts);
    const post = gitops.snapshot(root, { ignore: workspace.snapshotIgnore(env.paths) });
    const cmp = gitops.compareSnapshots(pre, post);
    const mutations = cmp.ok ? cmp.changed.map((p) => ({ path: p, generated: workspace.isGenerated(p, prep.policy) })) : [];
    const bad = mutations.filter((x) => !x.generated).map((x) => x.path);
    if (!cmp.ok || cr.passed === false || bad.length) {
      outcome = { kind: 'failed', cwd: root, cr, mutations, reasons: !cmp.ok ? cmp.problems : bad.length ? [`the integration commands changed ${bad.join(', ')}`] : null };
    } else {
      outcome = { kind: 'ok', cwd: root, sha: null, cr, mutations };
    }
  }

  return locked(env, () => {
    const ctx = openRun(env);
    let t = getTask(ctx, id);
    if (t.status !== 'INTEGRATING' || !t.pending_op || t.pending_op.id !== prep.opId || outcome.kind === 'superseded') {
      refuse(`integration result for ${id} discarded`, `the integration ${prep.opId} is no longer current (${id} is ${t.status})`, firstNext(ctx, 'oo status'));
    }
    t.pending_op = null;
    const cr = outcome.cr;
    const passed = outcome.kind === 'ok';
    const n = (t.integration_runs || 0) + 1;
    const reasons = outcome.kind === 'conflict' ? [`merge conflict in ${outcome.files.join(', ')}`] : outcome.kind === 'merge_failed' ? [outcome.message] : outcome.reasons || null;
    const evRel = store.writeEvidence(ctx.paths, ctx.run.run_id, `${id}-integrate-${n}.txt`, evidenceText(
      `Integration ${n} of ${id} (${prep.strategy} workspace${prep.mode === 'merge' ? `, merge of the verified candidate ${prep.candidate.commit}` : ''})`,
      { at: ctx.now, cwd: outcome.cwd, shell: cr.shell, commands: cr.commands, passed, reasons, candidate: prep.candidate, envRemoved: cr.env_removed, mutations: outcome.mutations, notes: notes.concat(prep.takeoverNote ? [prep.takeoverNote] : []) }));
    t.integration_runs = n;
    t.evidence.integration = {
      passed, run_at: ctx.now, commands: cr.commands, merged_commit: passed && outcome.merged ? outcome.sha : null,
      integrated_head: passed ? (outcome.sha || null) : null, candidate_id: candidateId(prep.candidate), regression: prep.regression,
      conflict_files: outcome.files || [], evidence_file: evRel, mutations: outcome.mutations || [],
      files: prep.candidate.kind === 'shared' ? prep.candidate.files : null, notes,
    };
    touch(ctx, t);
    if (passed && prep.strategy === 'worktree') ctx.run.workspace.integration_head = outcome.sha;
    if (passed) {
      move(ctx, t, 'COMPLETED', { reason: outcome.merged ? `merged as ${outcome.sha}` : 'integration checks passed' });
    } else if (outcome.kind === 'conflict') {
      move(ctx, t, 'BLOCKED', { kind: 'merge_conflict', reason: `merge conflict in ${outcome.files.join(', ') || 'unknown files'}; integration branch unchanged at ${outcome.before}` });
    } else if (outcome.kind === 'merge_failed') {
      move(ctx, t, 'BLOCKED', { kind: 'merge_failed', reason: oneLine(outcome.message, 300) });
    } else {
      move(ctx, t, 'CORRECTION_REQUIRED', { reason: `integration checks failed: ${(reasons || cr.commands.filter((c) => c.exit_code !== 0).map((c) => c.command)).join(', ')}` });
    }
    persist(ctx, { command: 'integrate', task_id: id, outcome: outcome.kind });
    const evAbs = absProject(env, evRel);
    if (passed) {
      say(env, `INTEGRATED: ${id} -> COMPLETED${outcome.merged ? ` (merge commit ${outcome.sha} on ${ctx.run.workspace.integration_branch})` : ''}`);
      if (cr.commands.length) say(env, 'Commands:', ...commandLines(cr.commands));
      for (const nn of notes) say(env, `Note: ${nn}`);
      say(env, `Evidence: ${evAbs}`);
      const done = ctx.tasks.every((x) => x.status === 'COMPLETED' || x.status === 'CANCELLED');
      say(env, `NEXT: ${done ? 'oo final-report, then oo deliver' : firstNext(ctx, 'oo next')}`);
      return 0;
    }
    if (outcome.kind === 'conflict') {
      say(env, `MERGE CONFLICT: ${id} -> BLOCKED (kind merge_conflict)`,
        `Conflicting files: ${outcome.files.join(', ') || '(not reported)'}`,
        `The merge was made in a separate checkout and aborted; the integration branch is unchanged at ${outcome.before}.`,
        `Evidence: ${evAbs}`,
        `NEXT: oo unblock ${id} --reason <text> to send it back to a worker, whose package merges the current integration head first (or amend, or ask the user)`);
      return 1;
    }
    if (outcome.kind === 'merge_failed') {
      say(env, `MERGE FAILED: ${id} -> BLOCKED (kind merge_failed): ${outcome.message}`, `Evidence: ${evAbs}`, `NEXT: inspect ${outcome.cwd}, then oo unblock ${id} --reason <text> or ask the user`);
      return 1;
    }
    say(env, `INTEGRATION FAILED: ${id} -> CORRECTION_REQUIRED${prep.strategy === 'worktree' ? '; the merge commit was never put on the integration branch, which is unchanged' : ''}`);
    for (const r of reasons || []) say(env, `  - ${r}`);
    for (const c of cr.commands.filter((x) => x.refused || x.timed_out || (!x.skipped && x.exit_code !== 0))) {
      say(env, `Failing command: ${c.command}`, `Exit code: ${c.refused ? 'refused' : c.timed_out ? 'timed out' : c.exit_code}`, 'Output tail:', ...indent(c.output_tail || '(no output)', '  | '));
    }
    say(env, `Evidence: ${evAbs}`, `NEXT: oo correct ${id} --stdin`);
    return 1;
  });
}

function cmdIntegrate(env, a) {
  cliargs.checkAllowed(a.opts, ['takeover'], 'integrate');
  const id = a.pos[0];
  if (!id) usage('integrate needs a task id: oo integrate <ID>');
  return runIntegrate(env, id, { takeover: a.opts.takeover });
}

// ---------------------------------------------------------------------------
// escalate and amend
// ---------------------------------------------------------------------------

function cmdEscalate(env, a) {
  cliargs.checkAllowed(a.opts, ['model', 'role', 'reason'], 'escalate');
  const id = a.pos[0];
  if (!id) usage('escalate needs a task id: oo escalate <ID> --model M | --role R --reason T');
  const reason = needReason(a);
  const model = a.opts.model;
  const role = a.opts.role;
  if (!model && !role) usage('escalate needs --model <haiku|sonnet|opus> or --role <logical role>');
  if (model && !MODEL_ORDER.includes(model)) usage(`--model must be one of ${MODEL_ORDER.join('|')}`);
  return locked(env, () => {
    const ctx = openRun(env);
    let t = getTask(ctx, id);
    if (!['FAILED', 'BLOCKED'].includes(t.status)) {
      refuse(`escalation of ${id} refused`, `${id} is ${t.status}; escalate applies to FAILED or BLOCKED tasks`, t.status === 'CORRECTION_REQUIRED' ? `oo correct ${id} --stdin, or oo fail ${id} --reason <text> first` : firstNext(ctx, 'oo status'));
    }
    const allowed = ctx.cfg.models.allowed || MODEL_ORDER;
    if (model && !allowed.includes(model)) refuse(`escalation of ${id} refused`, `model ${model} is not in models.allowed (${allowed.join(', ')})`, 'choose an allowed model');
    const roles = Object.keys(ctx.cfg.routing.roles || {});
    if (role && role !== 'orchestrator' && !roles.includes(role)) usage(`--role must be orchestrator or one of ${roles.join('|')}`);
    const cur = t.routing || {};
    const modelUp = model && MODEL_ORDER.indexOf(model) > MODEL_ORDER.indexOf(cur.model);
    const roleChange = role && role !== cur.role;
    if (model && MODEL_ORDER.indexOf(model) < MODEL_ORDER.indexOf(cur.model)) {
      refuse(`escalation of ${id} refused`, `${model} is weaker than the current model ${cur.model}`, 'escalate to a stronger model or change the role');
    }
    if (!modelUp && !roleChange) {
      refuse(`escalation of ${id} refused`, `it would repeat the unchanged strategy (model ${cur.model}, role ${cur.role})`, 'choose a stronger model or a different role, or amend the specification (oo amend), or ask the user');
    }
    const spec = Object.assign({}, t);
    if (model) spec.assigned_model = model;
    if (role) spec.assigned_role = role;
    const r = routeTask(ctx, spec, readStats(ctx));
    if (model && MODEL_ORDER.indexOf(r.model) < MODEL_ORDER.indexOf(model)) r.model = model;
    r.reasons = r.reasons.concat([`escalated: ${reason}`]);
    t.assigned_model = spec.assigned_model;
    t.assigned_role = spec.assigned_role;
    t.routing = r;
    t.escalations = (t.escalations || []).concat([{ ts: ctx.now, from_model: cur.model, to_model: r.model, from_role: cur.role, to_role: r.role, reason }]);
    archiveRound(ctx, t, 'escalated');
    touch(ctx, t);
    const deps = unmetDeps(ctx, t);
    if (t.status === 'BLOCKED' && deps.length) move(ctx, t, 'PENDING', { reason: `escalated: ${reason}` });
    else move(ctx, t, 'READY', { reason: `escalated: ${reason}`, escalated: true });
    persist(ctx, { command: 'escalate', task_id: id });
    const n = ctx.byId.get(id);
    say(env, `ESCALATED: ${id} -> ${n.status}: role ${cur.role} -> ${r.role}, model ${cur.role === 'orchestrator' ? 'self' : cur.model} -> ${r.role === 'orchestrator' ? 'self' : r.model}`, `NEXT: ${n.status === 'READY' ? 'oo next' : 'complete its dependencies, then oo next'}`);
    return 0;
  });
}

function cmdAmend(env, a) {
  cliargs.checkAllowed(a.opts, ['file', 'stdin', 'reason'], 'amend');
  const id = a.pos[0];
  if (!id) usage('amend needs a task id: oo amend <ID> --file F --reason T');
  const reason = needReason(a);
  const text = readInput(a);
  return locked(env, () => {
    const ctx = openRun(env);
    const t = getTask(ctx, id);
    const allowedStates = ['PENDING', 'READY', 'CORRECTION_REQUIRED', 'BLOCKED', 'FAILED'];
    if (!allowedStates.includes(t.status)) {
      refuse(`amendment of ${id} refused`, `${id} is ${t.status}; amend is allowed in ${allowedStates.join(', ')}`, firstNext(ctx, 'oo status'));
    }
    const rejected = `amendment of ${id} rejected; nothing changed`;
    let docs;
    try {
      docs = yaml.parseAll(text).filter((d) => d !== null && d !== undefined);
    } catch (e) {
      refuse(rejected, `YAML error at line ${e.line || '?'}: ${e.message}`, 'fix the file and repeat');
    }
    const raws = docs.flatMap((d) => (Array.isArray(d) ? d : [d]));
    if (raws.length !== 1) refuse(rejected, `the input must hold exactly one task specification (found ${raws.length})`, 'put only the amended specification in the file');
    const raw = raws[0];
    const v = specLib.validateSpec(raw, { config: ctx.cfg });
    const errors = v.errors.concat(mappingHints(raw));
    if (v.ok && v.spec.task_id !== id) errors.push(`the specification's task_id ${v.spec.task_id} does not match ${id}`);
    if (!errors.length) {
      const combined = ctx.tasks.filter((x) => x.task_id !== id).concat([v.spec]);
      errors.push(...specLib.validatePlan(combined).errors);
    }
    if (errors.length) refuse(rejected, errors, 'fix the specification and repeat oo amend');
    for (const k of SPEC_KEYS) t[k] = structuredClone(v.spec[k]);
    t.spec_revision = (t.spec_revision || 1) + 1;
    t.routing = routeTask(ctx, t, readStats(ctx));
    t.history = (t.history || []).concat([{ ts: ctx.now, from: t.status, to: t.status, reason: `amended (revision ${t.spec_revision}): ${reason}`, actor: 'orchestrator' }]);
    touch(ctx, t);
    store.saveSpecText(ctx.paths, ctx.run.run_id, id, yaml.stringify(raw));
    ctx.events.push({ type: 'amend', task_id: id, spec_revision: t.spec_revision, reason });
    persist(ctx, { command: 'amend', task_id: id });
    say(env, `AMENDED: ${id} spec revision ${t.spec_revision} (status ${t.status})`);
    printTaskPlan(env, t);
    for (const w of v.warnings) say(env, `Warning: ${w}`);
    say(env, `NEXT: ${firstNext(ctx, 'oo next')}`);
    return 0;
  });
}

// ---------------------------------------------------------------------------
// explicit transitions
// ---------------------------------------------------------------------------

function cmdBlock(env, a) {
  cliargs.checkAllowed(a.opts, ['reason', 'kind'], 'block');
  const id = a.pos[0];
  if (!id) usage('block needs a task id');
  const reason = needReason(a);
  return locked(env, () => {
    const ctx = openRun(env);
    const t = getTask(ctx, id);
    const wasInFlight = sm.IN_FLIGHT.includes(t.status);
    if (wasInFlight) closeAttempt(t, 'blocked', ctx.now, `blocked: ${reason}`);
    if (t.pending_op && store.ownerState(t.pending_op) !== 'alive') t.pending_op = null;
    move(ctx, t, 'BLOCKED', { reason, kind: a.opts.kind || 'manual' });
    persist(ctx, { command: 'block', task_id: id });
    say(env, `BLOCKED: ${id} (${reason})${wasInFlight ? '; its agent may still be running: ignore its output' : ''}`, `NEXT: resolve it, then oo unblock ${id} --reason <text>`);
    return 0;
  });
}

function cmdUnblock(env, a) {
  cliargs.checkAllowed(a.opts, ['reason'], 'unblock');
  const id = a.pos[0];
  if (!id) usage('unblock needs a task id');
  const reason = needReason(a);
  return locked(env, () => {
    const ctx = openRun(env);
    const t = getTask(ctx, id);
    if (t.status !== 'BLOCKED') refuse(`unblock of ${id} refused`, `${id} is ${t.status}, not BLOCKED`, firstNext(ctx, 'oo status'));
    archiveRound(ctx, t, 'unblocked');
    const to = unmetDeps(ctx, t).length ? 'PENDING' : 'READY';
    move(ctx, t, to, { reason });
    persist(ctx, { command: 'unblock', task_id: id });
    say(env, `UNBLOCKED: ${id} -> ${to}`, `NEXT: ${to === 'READY' ? 'oo next' : 'complete its dependencies, then oo next'}`);
    return 0;
  });
}

function cmdFail(env, a) {
  cliargs.checkAllowed(a.opts, ['reason', 'kind'], 'fail');
  const id = a.pos[0];
  if (!id) usage('fail needs a task id');
  const reason = needReason(a);
  return locked(env, () => {
    const ctx = openRun(env);
    const t = getTask(ctx, id);
    if (sm.IN_FLIGHT.includes(t.status)) closeAttempt(t, 'failed', ctx.now, `failed: ${reason}`);
    move(ctx, t, 'FAILED', { reason, kind: a.opts.kind || 'manual' });
    persist(ctx, { command: 'fail', task_id: id });
    say(env, `FAILED: ${id} (${reason})`, `NEXT: oo escalate ${id} --model <stronger model> --reason <text>, oo amend, or ask the user`);
    return 0;
  });
}

function cmdCancel(env, a) {
  cliargs.checkAllowed(a.opts, ['reason', 'all'], 'cancel');
  const reason = needReason(a);
  const id = a.pos[0];
  if (!id && !a.opts.all) usage('cancel needs a task id or --all');
  if (id && a.opts.all) usage('give either a task id or --all, not both');
  return locked(env, () => {
    const ctx = openRun(env);
    const targets = a.opts.all ? ctx.tasks.filter((t) => !sm.isTerminal(t.status)) : [getTask(ctx, id)];
    const inflight = [];
    for (const t of targets) {
      if (sm.IN_FLIGHT.includes(t.status)) {
        inflight.push(t.task_id);
        closeAttempt(t, 'cancelled', ctx.now, `cancelled: ${reason}`);
      }
      move(ctx, t, 'CANCELLED', { reason });
    }
    persist(ctx, { command: 'cancel', tasks: targets.map((t) => t.task_id) });
    say(env, `CANCELLED: ${targets.map((t) => t.task_id).join(', ') || '(no unfinished task)'}`);
    if (inflight.length) say(env, `Agents may still be running for ${inflight.join(', ')}; a late result for a cancelled task is refused.`);
    say(env, `NEXT: ${firstNext(ctx, 'oo final-report')}`);
    return 0;
  });
}

function cmdReopen(env, a) {
  cliargs.checkAllowed(a.opts, ['reason', 'user-authorized'], 'reopen');
  const id = a.pos[0];
  if (!id) usage('reopen needs a task id');
  const reason = needReason(a);
  return locked(env, () => {
    const ctx = openRun(env);
    const t = getTask(ctx, id);
    const to = t.status === 'FAILED' ? 'READY' : 'PENDING';
    if (!['FAILED', 'CANCELLED', 'COMPLETED'].includes(t.status)) {
      refuse(`reopen of ${id} refused`, `${id} is ${t.status}; reopen applies to FAILED, CANCELLED or COMPLETED tasks`, firstNext(ctx, 'oo status'));
    }
    const userAuthorized = a.opts['user-authorized'] === true;
    if (!userAuthorized) {
      refuse(`reopen of ${id} refused`, `NOT_AUTHORIZED: reopening a ${t.status} task needs the user's authorization`, 'ask the user; only when the user has said so, repeat with --user-authorized');
    }
    archiveRound(ctx, t, 'reopened');
    move(ctx, t, to, { reason, userAuthorized });
    persist(ctx, { command: 'reopen', task_id: id });
    say(env, `REOPENED: ${id} -> ${to}`, 'NEXT: oo next');
    return 0;
  });
}

function cmdDecision(env, a) {
  cliargs.checkAllowed(a.opts, ['stdin', 'file'], 'decision');
  const texts = a.pos.slice();
  const extra = readInput(a, false);
  if (extra && extra.trim()) texts.push(extra.trim());
  const clean = texts.map((x) => x.trim()).filter(Boolean);
  if (!clean.length) usage('decision needs text: oo decision "<text>" ["<text>" ...]');
  return locked(env, () => {
    const ctx = openRun(env);
    for (const text of clean) ctx.run.decisions.push({ ts: ctx.now, text });
    ctx.events.push({ type: 'decision', count: clean.length });
    persist(ctx, { command: 'decision' });
    say(env, `DECISION RECORDED (${clean.length}); ${ctx.run.decisions.length} decision(s) in the run`, `NEXT: ${firstNext(ctx, 'oo status')}`);
    return 0;
  });
}

// ---------------------------------------------------------------------------
// authorize and usage
// ---------------------------------------------------------------------------

function cmdAuthorize(env, a) {
  cliargs.checkAllowed(a.opts, ['limit', 'value', 'by', 'reason', 'task', 'side-effects'], 'authorize');
  if (a.opts.by === undefined) usage('--by is required (only --by user is accepted)');
  const reason = needReason(a);
  const sideEffects = a.opts['side-effects'] === true || a.opts.task !== undefined;
  if (sideEffects && (a.opts['side-effects'] !== true || !a.opts.task)) usage('authorizing an external-side-effect task needs --task <ID> --side-effects --by user --reason <text>');
  let limit = null;
  let value = null;
  if (!sideEffects) {
    limit = a.opts.limit;
    if (!AUTH_LIMITS.includes(limit)) usage(`--limit must be one of ${AUTH_LIMITS.join('|')}`);
    if (a.opts.value === undefined || !/^\d+(\.\d+)?$/.test(String(a.opts.value))) usage('--value must be a positive number');
    value = Number(a.opts.value);
    const integer = limit !== 'cost_limit_usd';
    if (integer && !Number.isInteger(value)) usage(`--value for ${limit} must be an integer`);
    if (!(value > 0)) usage('--value must be greater than 0');
    if ((limit === 'max_review_rounds' || limit === 'max_retries') && value > 10) usage(`--value for ${limit} must be at most 10`);
  }
  return locked(env, () => {
    const ctx = openRun(env);
    let list;
    const by = String(a.opts.by);
    if (sideEffects) {
      const t = getTask(ctx, a.opts.task);
      if (t.side_effects !== 'external') refuse(`authorization for ${t.task_id} not recorded`, `${t.task_id} has side_effects ${t.side_effects}; only external-side-effect tasks need it`, 'oo next');
      try {
        list = budget.authorize(ctx.run.authorizations, { limit: 'side_effects', value: t.task_id, by, reason, now: ctx.now });
      } catch (e) {
        refuse('authorization refused', `${e.code}: only the user can authorize an external side effect (--by user), and you may record it only when the user said so`, 'ask the user');
      }
      list[list.length - 1].task_id = t.task_id;
      list[list.length - 1].used_by_attempt = null;
    } else {
      try {
        list = budget.authorize(ctx.run.authorizations, { limit, value, by, reason, now: ctx.now });
      } catch (e) {
        refuse('authorization refused', `${e.code}: a limit is raised only by the user (--by user), and you may record it only when the user said so`, 'ask the user');
      }
      // Only a higher limit is a raise: a value at or below the effective limit changes nothing.
      const current = limit === 'max_review_rounds' || limit === 'max_retries'
        ? limits(ctx)[limit]
        : budget.effectiveLimit(limit, ctx.cfg.budget || {}, ctx.run.authorizations);
      if (current == null) {
        refuse('authorization refused', `${limit} has no limit set, so there is nothing to raise (--value ${value} would impose a limit)`, 'oo next');
      }
      if (!(value > current)) {
        refuse('authorization refused', `${limit} is already ${current}; --value ${value} is not higher, so the limit is not raised`, `repeat with a --value above ${current} if the user approved a higher limit`);
      }
    }
    ctx.run.authorizations = list;
    ctx.events.push({ type: 'authorize', limit: sideEffects ? 'side_effects' : limit, value: sideEffects ? a.opts.task : value });
    persist(ctx, { command: 'authorize' });
    say(env, sideEffects
      ? `AUTHORIZED: external side effects of ${a.opts.task} for its next dispatch (by user: ${reason})`
      : `AUTHORIZED: ${limit} raised to ${value} (by user: ${reason})`, 'NEXT: oo next');
    return 0;
  });
}

function cmdUsage(env, a) {
  cliargs.checkAllowed(a.opts, ['tokens', 'task', 'cost'], 'usage');
  if (a.opts.tokens === undefined && a.opts.cost === undefined) usage('usage needs --tokens N [--task ID] or --cost USD');
  if (a.opts.tokens !== undefined && !/^\d+$/.test(String(a.opts.tokens))) usage('--tokens must be a non-negative integer');
  if (a.opts.cost !== undefined && !/^\d+(\.\d+)?$/.test(String(a.opts.cost))) usage('--cost must be a non-negative number in US dollars');
  return locked(env, () => {
    const ctx = openRun(env);
    if (a.opts.task !== undefined) getTask(ctx, a.opts.task);
    if (a.opts.tokens !== undefined) {
      ctx.run.usage = budget.recordTokens(ctx.run.usage, { task_id: a.opts.task || null, total: Number(a.opts.tokens) });
      if (a.opts.task) {
        const t = ctx.byId.get(a.opts.task);
        t.tokens_recorded = (t.tokens_recorded || 0) + Number(a.opts.tokens);
        touch(ctx, t);
      }
    }
    if (a.opts.cost !== undefined) ctx.run.usage = budget.recordCost(ctx.run.usage, Number(a.opts.cost));
    ctx.events.push({ type: 'usage', tokens: a.opts.tokens !== undefined ? Number(a.opts.tokens) : null, task_id: a.opts.task || null, cost: a.opts.cost !== undefined ? Number(a.opts.cost) : null });
    persist(ctx, { command: 'usage' });
    say(env, `USAGE RECORDED: tokens ${reportgen.tokensText(ctx.run.usage)}; cost ${reportgen.costText(ctx.run.usage)}`, `NEXT: ${firstNext(ctx, 'oo status')}`);
    return 0;
  });
}

// ---------------------------------------------------------------------------
// status, checkpoint, resume, context
// ---------------------------------------------------------------------------

function contextInfo(paths, cfg) {
  const c = cfg.context || {};
  const u = checkpoint.readUtilization(paths, { now: new Date(), maxAgeSeconds: c.utilization_max_age_seconds });
  const target = configLib.contextTarget(cfg);
  const adv = checkpoint.contextAdvice(u.utilization, target);
  return { level: adv.level, message: adv.message, utilization: u.utilization, source: u.source, target };
}

function cmdStatus(env, a) {
  cliargs.checkAllowed(a.opts, ['json'], 'status');
  const ctx = openRun(env);
  const obj = reportgen.statusObject(ctx.run, ctx.tasks, {
    budgetCheck: budgetCheck(ctx), context: contextInfo(ctx.paths, ctx.cfg), nextActions: nextActionsFor(ctx),
  });
  if (a.opts.json) {
    say(env, JSON.stringify(obj, null, 2));
    return 0;
  }
  say(env, reportgen.statusText(obj));
  say(env, `NEXT: ${obj.next_actions[0] || (ctx.tasks.length ? 'oo final-report' : 'oo plan --file <specs.yaml>')}`);
  return 0;
}

function cmdCheckpoint(env, a) {
  cliargs.checkAllowed(a.opts, [], 'checkpoint');
  return locked(env, () => {
    const ctx = openRun(env);
    const file = writeCheckpointFor(ctx);
    store.appendEvent(ctx.paths, ctx.run.run_id, { type: 'command', command: 'checkpoint' });
    say(env, `CHECKPOINT WRITTEN: ${file}`, `NEXT: ${firstNext(ctx, 'oo status')}`);
    return 0;
  });
}

function cmdResume(env, a) {
  cliargs.checkAllowed(a.opts, ['requeue-running'], 'resume');
  return locked(env, () => {
    let runId = '';
    try {
      runId = fs.readFileSync(env.paths.currentFile, 'utf8').trim();
    } catch (_) { /* none */ }
    if (!runId) refuse('nothing to resume', 'there is no current run', 'start a run with: oo init <objective>');
    let integ;
    try {
      integ = store.checkIntegrity(env.paths, runId);
    } catch (e) {
      refuse('resume failed', `${e.code || 'ERROR'}: ${e.message}`, 'inspect the state directory with node manage_state.cjs integrity');
    }
    if (integ.problems.some((p) => p.startsWith('run.json'))) {
      refuse('resume failed: the run record is unreadable', integ.problems, `inspect ${path.join(runDir(env, runId), 'run.json')} and its .bak copy`);
    }
    if (!integ.ok) {
      say(env, 'INTEGRITY: PROBLEMS (files that could not be restored from a backup):');
      for (const r of integ.recovered) say(env, `  restored from backup: ${r}`);
      for (const p of integ.problems) say(env, `  PROBLEM: ${p}`);
      try {
        say(env, 'Last checkpoint (written before the damage; the task files above are unreadable):',
          checkpoint.renderResume(checkpoint.readCheckpoint(env.paths, runId), { maxLines: 120 }));
      } catch (_) {
        say(env, 'No readable checkpoint either.');
      }
      say(env, `NEXT: repair or remove the unreadable task files listed above (compare with ${path.join(runDir(env, runId), 'specs')} and node manage_state.cjs integrity), then oo resume`);
      return 1;
    }
    const ctx = openRun(env);
    const inflight = ctx.tasks.filter((t) => sm.IN_FLIGHT.includes(t.status));
    if (a.opts['requeue-running'] && inflight.length) {
      // Whether an agent is still working cannot be known from here: requeueing on a guess could
      // run the same work twice and accept a stale report. Each attempt is reconciled explicitly.
      refuse('nothing requeued', inflight.map((t) => `${t.task_id} attempt ${(t.dispatch && t.dispatch.attempt_id) || '?'} is ${t.status}; oo cannot tell whether its agent still runs`),
        `for each attempt whose agent you know has stopped: oo reconcile <ID> --attempt <attempt id> --agent-gone --reason <text>; an agent that still runs reports with oo result as usual`);
    }
    const pending = [];
    for (const t of ctx.tasks) {
      if (t.pending_op) pending.push({ t, op: t.pending_op, st: store.ownerState(t.pending_op) });
    }
    if (ctx.run.pending_op) pending.push({ t: null, op: ctx.run.pending_op, st: store.ownerState(ctx.run.pending_op) });
    ctx.events.push({ type: 'resume', recovered: integ.recovered, problems: integ.problems, in_flight: inflight.map((t) => (t.dispatch && t.dispatch.attempt_id) || t.task_id) });
    persist(ctx, { command: 'resume' });
    say(env, integ.recovered.length ? 'INTEGRITY: restored' : 'INTEGRITY: ok');
    for (const r of integ.recovered) say(env, `  restored from backup: ${r} (the backup holds the version before the last save; check that task's status below)`);
    if (inflight.length) {
      say(env, 'In flight (their agents may still be working; their reports are accepted only for the attempt shown):');
      for (const t of inflight) say(env, `  ${t.task_id} ${t.status} attempt ${(t.dispatch && t.dispatch.attempt_id) || '?'} dispatched ${t.dispatch && t.dispatch.at}${t.side_effects === 'external' ? ' (external side effects: check what its agent already did before anything else)' : ''}`);
      say(env, '  If you know an attempt\'s agent has stopped: oo reconcile <ID> --attempt <attempt id> --agent-gone --reason <text> (no retry is used; a late report of that attempt is then refused).');
    }
    for (const p of pending) {
      const what = p.t ? `${p.op.kind} of ${p.t.task_id}` : p.op.kind;
      const advice = p.st === 'alive' ? 'still running; wait for it'
        : p.st === 'dead' ? `interrupted (process ${p.op.pid} is gone); repeat oo ${p.op.kind === 'verify' ? 'verify' : p.op.kind === 'integrate' ? 'integrate' : 'deliver'}${p.t ? ` ${p.t.task_id}` : ''} to take it over`
          : `started by process ${p.op.pid} on host ${p.op.host}, liveness unknown; after confirming it stopped, repeat with --takeover ${p.op.id}`;
      say(env, `Operation ${what} (${p.op.id}): ${advice}`);
    }
    const maxLines = Number.isInteger(ctx.cfg.context && ctx.cfg.context.max_resume_lines) ? ctx.cfg.context.max_resume_lines : 120;
    say(env, checkpoint.renderResume(checkpoint.buildCheckpoint(ctx.run, ctx.tasks, ctx.now), { maxLines }));
    say(env, `NEXT: ${firstNext(ctx, ctx.tasks.length ? 'oo final-report' : 'oo plan --file <specs.yaml>')}`);
    return 0;
  });
}

function cmdReconcile(env, a) {
  cliargs.checkAllowed(a.opts, ['attempt', 'agent-gone', 'reason'], 'reconcile');
  const id = a.pos[0];
  if (!id || typeof a.opts.attempt !== 'string') usage('reconcile needs a task id and --attempt <attempt id>: oo reconcile <ID> --attempt <AID> --agent-gone --reason <text>');
  if (a.opts['agent-gone'] !== true) usage('reconcile needs --agent-gone: state that you know this attempt\'s agent has stopped');
  const reason = needReason(a);
  return locked(env, () => {
    const ctx = openRun(env);
    const t = getTask(ctx, id);
    const cur = t.dispatch && t.dispatch.attempt_id;
    if (!sm.IN_FLIGHT.includes(t.status) || cur !== a.opts.attempt) {
      refuse(`attempt ${a.opts.attempt} not reconciled`, `${id} is ${t.status}${cur ? ` and its current attempt is ${cur}` : ''}; only the current in-flight attempt can be reconciled (a finished result is kept)`, firstNext(ctx, 'oo status'));
    }
    if (t.side_effects === 'external') {
      refuse(`attempt ${a.opts.attempt} not reconciled`, `${id} has external side effects; it is never requeued automatically`, `check what its agent already did, then oo fail ${id} --reason <text> or oo block ${id} --reason <text>`);
    }
    logAttempt(t, cur, 'abandoned', ctx.now, { reason });
    touch(ctx, t);
    const retries = t.retries || 0;
    const lim = Object.assign({}, limits(ctx), { max_retries: retries + 1 });
    const n = move(ctx, t, 'READY', { reason: `attempt ${cur} reconciled: its agent is gone (${reason}); no retry consumed`, limits: lim });
    n.retries = retries;
    n.next_dispatch_kind = 'retry';
    ctx.events.push({ type: 'reconcile', task_id: id, attempt_id: cur, reason });
    persist(ctx, { command: 'reconcile', task_id: id, attempt_id: cur });
    say(env, `RECONCILED: ${id} attempt ${cur} abandoned -> READY (no retry used); a late report of that attempt is refused`, 'NEXT: oo next');
    return 0;
  });
}

function cmdRebaseline(env, a) {
  cliargs.checkAllowed(a.opts, ['reason', 'user-authorized'], 'rebaseline');
  const id = a.pos[0];
  if (!id) usage('rebaseline needs a task id: oo rebaseline <ID> --reason <text> --user-authorized');
  const reason = needReason(a);
  if (a.opts['user-authorized'] !== true) {
    refuse(`baseline of ${id} not reset`, 'NOT_AUTHORIZED: a new baseline accepts every change made since the old one as if it had been there before; only the user can decide that', 'ask the user; only when the user has said so, repeat with --user-authorized');
  }
  return locked(env, () => {
    const ctx = openRun(env);
    const t = getTask(ctx, id);
    const allowed = ['PENDING', 'READY', 'BLOCKED', 'CORRECTION_REQUIRED', 'FAILED'];
    if (!allowed.includes(t.status)) refuse(`baseline of ${id} not reset`, `${id} is ${t.status}; the baseline can be reset only in ${allowed.join(', ')}`, firstNext(ctx, 'oo status'));
    if ((ctx.run.workspace || {}).strategy === 'worktree') refuse(`baseline of ${id} not reset`, 'the worktree strategy has no file baseline (its evidence is the git diff of the candidate)', 'oo status');
    const old = t.baseline || null;
    t.baseline = null;
    t.history = (t.history || []).concat([{ ts: ctx.now, from: t.status, to: t.status, reason: `baseline reset by the user (${reason})${old ? `; previous baseline ${old.snapshot} of ${old.at}` : ''}`, actor: 'user' }]);
    touch(ctx, t);
    ctx.events.push({ type: 'rebaseline', task_id: id, reason, previous: old && old.snapshot });
    persist(ctx, { command: 'rebaseline', task_id: id });
    say(env, `BASELINE RESET: ${id}; the next dispatch takes a new baseline snapshot`, `NEXT: ${firstNext(ctx, 'oo next')}`);
    return 0;
  });
}

function cmdRepoGuard(env, a) {
  cliargs.checkAllowed(a.opts, ['accept', 'reason', 'user-authorized'], 'repo-guard');
  return locked(env, () => {
    const ctx = openRun(env);
    const ws = ctx.run.workspace || {};
    if (ws.strategy !== 'worktree') {
      say(env, 'REPO GUARD: shared workspace; the repository configuration is part of the snapshot evidence instead', 'NEXT: oo status');
      return 0;
    }
    const now = gitops.repoGuard(ctx.paths.projectDir);
    if (a.opts.accept === undefined) {
      say(env, `REPO GUARD: ${now === ws.repo_guard ? 'unchanged since the run started' : 'CHANGED since the run started (verification, integration and delivery are refused)'}`, `  recorded ${ws.repo_guard}`, `  current  ${now}`, 'NEXT: oo status');
      return 0;
    }
    const reason = needReason(a);
    if (a.opts['user-authorized'] !== true) refuse('repository guard not updated', 'NOT_AUTHORIZED: accepting changed git configuration or hooks is the user\'s decision', 'ask the user; only when the user has said so, repeat with --user-authorized');
    ctx.run.decisions.push({ ts: ctx.now, text: `repository configuration/hooks change accepted by the user: ${reason} (${ws.repo_guard} -> ${now})` });
    ws.repo_guard = now;
    ctx.events.push({ type: 'repo_guard', accepted: now, reason });
    persist(ctx, { command: 'repo-guard', accepted: true });
    say(env, 'REPO GUARD UPDATED (by user)', 'NEXT: oo status');
    return 0;
  });
}

function cmdContext(env, a) {
  cliargs.checkAllowed(a.opts, ['utilization'], 'context');
  let cfg;
  let hasRun = true;
  try {
    cfg = store.loadRun(env.paths).config;
  } catch (_) {
    hasRun = false;
  }
  if (!cfg || !cfg.context) cfg = configLib.loadConfig({ skillDir: SKILL_DIR, stateConfigFile: env.paths.configFile });
  if (a.opts.utilization !== undefined) {
    const raw = String(a.opts.utilization).replace(/%$/, '');
    if (!/^\d+(\.\d+)?$/.test(raw)) usage('--utilization must be a fraction (0.55) or a percentage (55 or 55%)');
    let x = Number(raw);
    if (x > 1 || String(a.opts.utilization).endsWith('%')) x /= 100;
    if (!(x >= 0 && x <= 1)) usage('--utilization must be between 0 and 1 (or 0% and 100%)');
    store.writeJson(env.paths.contextFile, { used_percentage: Math.round(x * 10000) / 100, context_window_size: null, ts: nowIso(), source: 'user' });
  }
  const info = contextInfo(env.paths, cfg);
  say(env, `CONTEXT: ${info.level}${info.utilization === null ? '' : ` (${Math.round(info.utilization * 100)}% used, target ${Math.round(info.target * 100)}%, source ${info.source})`}`, info.message);
  if (hasRun && a.opts.utilization !== undefined) {
    locked(env, () => {
      const ctx = openRun(env);
      ctx.events.push({ type: 'context', utilization: info.utilization });
      persist(ctx, { command: 'context' });
    });
  }
  say(env, `NEXT: ${info.level === 'over_target' ? 'reach a safe point (no worker mid-flight), run oo checkpoint, then ask the user to run /compact' : 'continue with the next action in oo status'}`);
  return 0;
}

// ---------------------------------------------------------------------------
// deliver, final-report, cleanup
// ---------------------------------------------------------------------------

function cmdDeliver(env, a) {
  cliargs.checkAllowed(a.opts, ['takeover'], 'deliver');
  const prep = locked(env, () => {
    const ctx = openRun(env);
    if (!ctx.tasks.length) refuse('nothing delivered', 'the run has no tasks', 'oo plan --file <specs.yaml>');
    const open = ctx.tasks.filter((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED');
    if (open.length) {
      refuse('nothing delivered', open.map((t) => `${t.task_id} is ${t.status}`), 'finish, cancel or escalate those tasks first (oo status), or report the partial result with oo final-report');
    }
    if (ctx.run.delivered) refuse('nothing delivered', `the run was already delivered at ${ctx.run.delivery && ctx.run.delivery.at}`, 'oo final-report');
    const takeoverNote = opGate(ctx.run.pending_op, 'delivery', a.opts.takeover);
    const ws = ctx.run.workspace || {};
    let sha = null;
    if (ws.strategy === 'worktree') {
      checkRepoGuard(ctx, 'delivery');
      if (!ws.integration_head) refuse('nothing delivered', 'this run predates integration-head tracking', `merge ${ws.integration_branch} yourself after checking it`);
      const tip = gitops.revParse(ctx.paths.projectDir, `refs/heads/${ws.integration_branch}`);
      if (tip !== ws.integration_head) {
        const foreign = foreignIntegrationCommits(ctx, ws.integration_head, tip);
        refuse('nothing delivered', `the integration branch ${ws.integration_branch} is at ${tip || '(missing)'}, but oo integrated up to ${ws.integration_head}${foreign.length ? `; commits oo did not make: ${foreign.join(', ')}` : ''}`,
          'find out who moved the branch; nothing was forced. Deliver by hand after checking, or ask the user');
      }
      sha = ws.integration_head;
    } else {
      const changed = [];
      for (const t of ctx.tasks.filter((x) => x.status === 'COMPLETED')) {
        const files = t.evidence && t.evidence.integration && t.evidence.integration.files;
        if (!files) continue;
        const intact = sharedCandidateIntact(ctx, { files });
        if (!intact.ok) changed.push(`${t.task_id}: ${intact.problem || intact.changed.join(', ')}`);
      }
      if (changed.length) {
        refuse('nothing delivered: files changed after their integration', changed, 'find out what changed them (oo never reverts anything); re-run the affected tasks (oo reopen <ID> --reason <text> --user-authorized) or ask the user');
      }
    }
    const mode = ((ctx.cfg.verification || {}).modes || {})[ctx.run.options.mode] || {};
    const rc = ctx.cfg.verification.regression_command;
    ctx.run.pending_op = newOp('deliver', { sha });
    if (takeoverNote) ctx.run.decisions.push({ ts: ctx.now, text: `oo: ${takeoverNote}` });
    persist(ctx, { command: 'deliver', phase: 'start', op: ctx.run.pending_op.id });
    return {
      opId: ctx.run.pending_op.id, sha, strategy: ws.strategy, audit: mode.final_audit === true, rc, modeName: ctx.run.options.mode,
      setup: setupCommands(ctx), copts: commandOpts(ctx), policy: generated(ctx),
    };
  });

  // Final audit outside the lock: on a clean checkout of exactly the commit to deliver (worktree)
  // or in place with a before/after snapshot (shared).
  let audit = null;
  const notes = [];
  if (prep.audit && prep.rc) {
    const view = openRun(env);
    if (prep.strategy === 'worktree') {
      let dir = null;
      try {
        dir = cleanCheckout(view, 'audit', prep.sha);
        const cr = runChecked(dir, prep.setup, [prep.rc], prep.copts);
        let mutations = [];
        let unreadable = null;
        try {
          mutations = checkoutMutations(dir, prep.policy);
        } catch (e) {
          unreadable = e.message;
        }
        const bad = mutations.filter((x) => !x.generated).map((x) => x.path);
        audit = { cwd: dir, cr, mutations, passed: cr.passed === true && !bad.length && !unreadable, reasons: bad.length ? [`the audit command changed ${bad.join(', ')}`] : unreadable ? [unreadable] : null };
        notes.push(`clean audit checkout ${relProject(env, dir)}: ${audit.passed ? dropCheckout(view, dir) : 'kept as evidence'}`);
      } catch (e) {
        audit = { cwd: dir, cr: { passed: null, shell: null, commands: [], env_removed: [] }, mutations: [], passed: false, reasons: [`the audit checkout could not be made: ${e.message}`] };
      }
    } else {
      const root = env.paths.projectDir;
      const pre = gitops.snapshot(root, { ignore: workspace.snapshotIgnore(env.paths) });
      const cr = runChecked(root, prep.setup, [prep.rc], prep.copts);
      const cmp = gitops.compareSnapshots(pre, gitops.snapshot(root, { ignore: workspace.snapshotIgnore(env.paths) }));
      const mutations = cmp.ok ? cmp.changed.map((p) => ({ path: p, generated: workspace.isGenerated(p, prep.policy) })) : [];
      const bad = mutations.filter((x) => !x.generated).map((x) => x.path);
      audit = { cwd: root, cr, mutations, passed: cmp.ok && cr.passed === true && !bad.length, reasons: !cmp.ok ? cmp.problems : bad.length ? [`the audit command changed ${bad.join(', ')}`] : null };
    }
  }

  return locked(env, () => {
    const ctx = openRun(env);
    if (!ctx.run.pending_op || ctx.run.pending_op.id !== prep.opId) {
      refuse('delivery result discarded', `the delivery ${prep.opId} is no longer current`, firstNext(ctx, 'oo status'));
    }
    ctx.run.pending_op = null;
    const ws = ctx.run.workspace || {};
    if (prep.audit && !prep.rc) {
      say(env, `FINAL AUDIT: mode ${prep.modeName} asks for a final audit, but no final audit command is configured (verification.regression_command is null); delivering without it`);
    }
    if (audit) {
      const evRel = store.writeEvidence(ctx.paths, ctx.run.run_id, 'final-audit.txt', evidenceText(
        `Final audit of run ${ctx.run.run_id} (mode ${prep.modeName}, ${prep.strategy === 'worktree' ? `clean checkout of ${prep.sha}` : 'project directory'})`,
        { at: ctx.now, cwd: audit.cwd, shell: audit.cr.shell, commands: audit.cr.commands, passed: audit.passed, reasons: audit.reasons, envRemoved: audit.cr.env_removed, mutations: audit.mutations, notes }));
      ctx.run.final_audit = { passed: audit.passed, run_at: ctx.now, command: prep.rc, commands: audit.cr.commands, evidence_file: evRel, commit: prep.sha };
      ctx.events.push({ type: 'final_audit', passed: audit.passed });
      const evAbs = absProject(env, evRel);
      if (!audit.passed) {
        persist(ctx, { command: 'deliver', outcome: 'final_audit_failed' });
        say(env, 'FINAL AUDIT FAILED: nothing delivered', ...commandLines(audit.cr.commands), ...(audit.reasons || []).map((r) => `  - ${r}`));
        for (const c of audit.cr.commands.filter((x) => x.refused || x.timed_out || (!x.skipped && x.exit_code !== 0))) {
          say(env, `Failing command: ${c.command}`, `Exit code: ${c.refused ? 'refused' : c.timed_out ? 'timed out' : c.exit_code}`, 'Output tail:', ...indent(c.output_tail || '(no output)', '  | '));
        }
        say(env, `Evidence: ${evAbs}`, 'NEXT: find what broke the integrated result, fix it with a new task (oo plan --file <specs.yaml>) or ask the user; oo deliver runs the audit again');
        return 1;
      }
      say(env, `FINAL AUDIT PASSED: ${prep.rc} (evidence ${evAbs})`);
    }
    if (prep.strategy === 'worktree') {
      const failDelivery = (why, next) => {
        persist(ctx, { command: 'deliver', outcome: 'refused' });
        refuse('nothing delivered', why, next);
      };
      const tip = gitops.revParse(ctx.paths.projectDir, `refs/heads/${ws.integration_branch}`);
      if (tip !== prep.sha) failDelivery(`the integration branch moved to ${tip} during the delivery; ${prep.sha} was audited`, 'find out who moved it; nothing was forced');
      // The audit ran candidate code; a hook it planted would run inside the fast-forward below.
      const guardNow = (() => { try { return gitops.repoGuard(ctx.paths.projectDir); } catch (e) { return `unreadable: ${e.message}`; } })();
      if (ws.repo_guard && guardNow !== ws.repo_guard) {
        failDelivery('the repository configuration, hooks or info files changed since the run started (possibly during the audit); nothing was moved', 'inspect .git/hooks, .git/config and .git/info, then oo repo-guard; only the user accepts such a change');
      }
      const cur = gitops.git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: ctx.paths.projectDir });
      const branch = cur.code === 0 ? cur.stdout.trim() : null;
      if (ws.base_branch && branch !== ws.base_branch) {
        failDelivery(`the main checkout is on ${branch || 'a detached HEAD'}, but the run started on ${ws.base_branch}`, `switch back to ${ws.base_branch} (or merge ${prep.sha} yourself), then oo deliver`);
      }
      let ops = [];
      try {
        ops = gitops.operationsInProgress(ctx.paths.projectDir);
      } catch (e) {
        failDelivery(`the main checkout cannot be inspected: ${e.message}`, 'fix the repository, then oo deliver');
      }
      if (ops.length) failDelivery(`a git operation is unfinished in the main checkout: ${ops.join(', ')}`, 'finish or abort it yourself, then oo deliver');
      const head = gitops.revParse(ctx.paths.projectDir, 'HEAD');
      if (head !== prep.sha && !gitops.isAncestor(ctx.paths.projectDir, 'HEAD', prep.sha)) {
        failDelivery(`${branch} and the integrated commit ${prep.sha} have diverged; a fast-forward is not possible`, `nothing was forced; ask the user how to bring ${prep.sha} into ${branch} (for example a manual merge)`);
      }
      if (head !== prep.sha) {
        const ff = gitops.git(['merge', '--ff-only', prep.sha], { cwd: ctx.paths.projectDir });
        if (ff.code !== 0) failDelivery(`the fast-forward to ${prep.sha} failed: ${(ff.stderr || ff.stdout).trim()}`, 'nothing was forced; resolve the cause in the main checkout (for example uncommitted changes to the same files), then oo deliver');
      }
      const after = gitops.revParse(ctx.paths.projectDir, 'HEAD');
      if (after !== prep.sha) failDelivery(`after the fast-forward HEAD is ${after}, not ${prep.sha}`, 'inspect the main checkout');
      ctx.run.delivered = true;
      ctx.run.delivery = { at: ctx.now, branch, head: after, from: ws.integration_branch, commit: prep.sha };
      ctx.events.push({ type: 'deliver', head: after });
      persist(ctx, { command: 'deliver' });
      say(env, `DELIVERED: ${branch} fast-forwarded to ${after} (exactly the integrated and audited commit of ${ws.integration_branch}); uncommitted files in the main checkout were not touched`, 'NEXT: oo final-report, then oo cleanup');
      return 0;
    }
    ctx.run.delivered = true;
    ctx.run.delivery = { at: ctx.now, branch: null, head: null, from: null };
    ctx.events.push({ type: 'deliver' });
    persist(ctx, { command: 'deliver' });
    say(env, 'DELIVERED: shared workspace, the changes are already in place (each integrated file still has its integrated content); nothing to move', 'NEXT: oo final-report');
    return 0;
  });
}

function cmdFinalReport(env, a) {
  cliargs.checkAllowed(a.opts, [], 'final-report');
  const ctx = openRun(env);
  const r = reportgen.finalReport(ctx.run, ctx.tasks, { now: ctx.now, budgetCheck: budgetCheck(ctx) });
  const file = writeRunFile(env, ctx.run.run_id, 'final-report.md', r.text);
  say(env, r.text, `Written to ${file}`);
  say(env, `NEXT: ${r.overall === 'COMPLETE' ? (ctx.run.delivered ? 'give the user this report' : 'oo deliver, then give the user this report') : 'give the user this report and say which tasks did not complete'}`);
  return 0;
}

function cmdCleanup(env, a) {
  cliargs.checkAllowed(a.opts, [], 'cleanup');
  return locked(env, () => {
    const ctx = openRun(env);
    const ws = ctx.run.workspace || {};
    if (ws.strategy !== 'worktree') {
      say(env, 'CLEANUP: shared workspace; oo created no worktree or branch', 'NEXT: done');
      return 0;
    }
    const lines = [];
    const dir = path.join(runDir(env, ctx.run.run_id), 'worktrees');
    const selfDir = path.join(ctx.paths.inboxDir, 'worktrees', ctx.run.run_id);
    const dirs = [dir, selfDir].filter((d) => fs.existsSync(d)).flatMap((d) => fs.readdirSync(d).map((n) => path.join(d, n)));
    for (const d of dirs) {
      const r = gitops.removeWorktree(ctx.paths.projectDir, d);
      lines.push(`worktree ${d}: ${r.ok ? 'removed' : `kept (${r.reason})`}`);
    }
    const list = gitops.git(['branch', '--list', `opus-orch/${ctx.run.run_id}/*`, '--format=%(refname:short)'], { cwd: ctx.paths.projectDir });
    for (const b of list.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
      const r = gitops.deleteMergedBranch(ctx.paths.projectDir, b);
      lines.push(`branch ${b}: ${r.ok ? 'deleted' : `kept (${r.reason})`}`);
    }
    ctx.run.cleanup = { at: ctx.now, results: lines };
    ctx.events.push({ type: 'cleanup', results: lines });
    persist(ctx, { command: 'cleanup' });
    say(env, 'CLEANUP (nothing is forced):', ...lines.map((l) => `  ${l}`), 'NEXT: done');
    return 0;
  });
}

// ---------------------------------------------------------------------------
// observations and proposals
// ---------------------------------------------------------------------------

function currentRunOrNull(env) {
  try {
    return store.loadRun(env.paths);
  } catch (_) {
    return null;
  }
}

function cmdObserve(env, a) {
  cliargs.checkAllowed(a.opts, ['category', 'text', 'task'], 'observe');
  if (!improve.CATEGORIES.includes(a.opts.category)) usage(`--category must be one of ${improve.CATEGORIES.join('|')}`);
  const text = typeof a.opts.text === 'string' ? a.opts.text.trim() : '';
  if (!text) usage('--text <observation> is required');
  const run = currentRunOrNull(env);
  store.ensureState(env.paths);
  const rec = improve.recordObservation(env.paths, { run_id: run ? run.run_id : null, task_id: a.opts.task || null, category: a.opts.category, text }, nowIso());
  say(env, `OBSERVATION RECORDED: ${rec.category}: ${oneLine(rec.text, 200)}`, 'NEXT: oo learn when the run is finished');
  return 0;
}

function cmdLearn(env, a) {
  cliargs.checkAllowed(a.opts, [], 'learn');
  const run = currentRunOrNull(env);
  const cfg = run && run.config && run.config.improvement ? run.config : configLib.loadConfig({ skillDir: SKILL_DIR, stateConfigFile: env.paths.configFile });
  store.ensureState(env.paths);
  let collected = 0;
  if (run && cfg.improvement.collect_observations !== false) {
    const tasks = store.listTasks(env.paths, run.run_id);
    // An observation already on record for this run (same category, task and text) is not appended again.
    const key = (o) => JSON.stringify([o.category, o.run_id, o.task_id, o.text]);
    const recorded = new Set(improve.readObservations(env.paths).map(key));
    for (const o of improve.collectRunObservations(run, tasks)) {
      if (recorded.has(key(o))) continue;
      improve.recordObservation(env.paths, o, o.ts || nowIso());
      recorded.add(key(o));
      collected += 1;
    }
  }
  const obs = improve.readObservations(env.paths);
  const existing = improve.listProposals(env.paths);
  const props = improve.generateProposals(obs, cfg, nowIso(), { existing });
  for (const p of props) improve.saveProposal(env.paths, p, { config: cfg });
  say(env, `LEARN: ${collected} observation(s) collected from the current run; ${obs.length} observation(s) on record`);
  if (!props.length) {
    say(env, `No proposal: not enough evidence for any rule (a rule needs at least ${cfg.improvement.min_samples} matching observations).`, 'NEXT: done');
    return 0;
  }
  for (const p of props) say(env, `PROPOSAL ${p.id} [${p.category}, ${p.change.kind}] ${p.title}`, ...p.evidence.map((e) => `  evidence: ${e}`));
  say(env, 'NEXT: show the proposals to the user (oo proposals show <ID>); apply one only after the user approves it (oo proposals approve <ID> --by user)');
  return 0;
}

function proposalRefusal(e, id) {
  const next = {
    NOT_USER: 'only the user can approve a proposal; ask them, and record it with --by user only when they said so',
    NOT_APPROVED: `ask the user; after their approval run oo proposals approve ${id} --by user, then apply`,
    MANUAL_ONLY: 'a person must make this change by hand',
    NO_PROPOSAL: 'oo proposals list',
    BAD_ID: 'oo proposals list',
  }[e.code] || 'oo proposals list';
  return new Refusal(`proposal ${id || ''} not changed`.replace(/ +/g, ' '), `${e.code}: ${e.message}`, next);
}

function cmdProposals(env, a) {
  cliargs.checkAllowed(a.opts, ['by'], 'proposals');
  const sub = a.pos[0] || 'list';
  const id = a.pos[1];
  const needId = () => { if (!id) usage(`proposals ${sub} needs a proposal id`); };
  const run = currentRunOrNull(env);
  const cfg = run && run.config && run.config.verification ? run.config : undefined;
  try {
    switch (sub) {
      case 'list': {
        const list = improve.listProposals(env.paths);
        say(env, `PROPOSALS (${list.length}):`, ...list.map((p) => `  ${p.id} ${p.status} [${p.category}] ${p.title}`));
        say(env, `NEXT: ${list.length ? 'oo proposals show <ID>' : 'oo learn'}`);
        return 0;
      }
      case 'show': {
        needId();
        say(env, yaml.stringify(improve.loadProposal(env.paths, id)).replace(/\n$/, ''), `NEXT: ask the user whether to approve ${id}`);
        return 0;
      }
      case 'approve': {
        needId();
        if (a.opts.by === undefined) usage('approve needs --by user (only the user can approve)');
        const p = improve.setProposalStatus(env.paths, id, 'approved', { by: String(a.opts.by), config: cfg });
        say(env, `APPROVED: ${p.id} (by user)`, `NEXT: oo proposals apply ${id}`);
        return 0;
      }
      case 'reject': {
        needId();
        const p = improve.setProposalStatus(env.paths, id, 'rejected', { by: a.opts.by ? String(a.opts.by) : 'orchestrator', config: cfg });
        say(env, `REJECTED: ${p.id}`, 'NEXT: done');
        return 0;
      }
      case 'apply': {
        needId();
        const r = improve.applyProposal(env.paths, SKILL_DIR, id, nowIso());
        say(env, `APPLIED: ${id}: ${r.changed_file} changed; backup ${r.backup}; VERSION ${r.previous_version} -> ${r.version}`, `NEXT: oo proposals rollback ${id} undoes it if needed`);
        return 0;
      }
      case 'rollback': {
        needId();
        const r = improve.rollbackProposal(env.paths, SKILL_DIR, id, nowIso());
        say(env, `ROLLED BACK: ${id}: ${r.restored_file} restored from ${r.backup}`, 'NEXT: done');
        return 0;
      }
      default:
        usage('proposals sub-command must be list, show, approve, reject, apply or rollback');
    }
  } catch (e) {
    if (e instanceof improve.ImproveError) throw proposalRefusal(e, id);
    throw e;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// doctor, version, help
// ---------------------------------------------------------------------------

function versionOf(cmd, args) {
  try {
    const r = cp.spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: process.platform === 'win32' });
    if (r.error || r.status !== 0) return null;
    return (r.stdout || '').trim().split(/\r?\n/)[0] || null;
  } catch (_) {
    return null;
  }
}

const AGENTS = ['opus-researcher', 'opus-implementer', 'opus-tester', 'opus-reviewer', 'opus-debugger'];

function cmdDoctor(env, a) {
  cliargs.checkAllowed(a.opts, [], 'doctor');
  const gitV = versionOf('git', ['--version']);
  const claudeV = versionOf('claude', ['--version']);
  let info;
  try {
    info = gitops.inspect(env.paths.projectDir);
  } catch (_) {
    info = { is_repo: false, has_commits: false, branch: null, dirty: [] };
  }
  let isolation = 'auto';
  try {
    isolation = configLib.loadConfig({ skillDir: SKILL_DIR, stateConfigFile: env.paths.configFile }).execution.isolation;
  } catch (_) { /* default */ }
  const sh = verify.findShell();
  const gv = gitops.gitVersion();
  const gitOld = gv && !(gv[0] > 2 || (gv[0] === 2 && gv[1] >= 31));
  say(env,
    `DOCTOR (opus-orchestrator ${readVersion()})`,
    `Node: ${process.version}`,
    `git: ${gitV || 'not found'}${gitOld ? ' (older than 2.31: the worktree strategy is not used)' : ''}`,
    `Claude Code: ${claudeV || 'not found on PATH'}`,
    `Project: ${env.paths.projectDir}`,
    `Workspace strategy: ${gitops.chooseStrategy(info, isolation)} (${info.is_repo ? `git repository${info.has_commits ? `, branch ${info.branch || 'detached'}` : ', no commits'}` : 'no git repository'})`,
    'Agents:');
  for (const ag of AGENTS) {
    const where = [path.join(env.paths.projectDir, '.claude', 'agents', `${ag}.md`), path.join(env.home, '.claude', 'agents', `${ag}.md`)].find((f) => fs.existsSync(f));
    say(env, `  ${ag}: ${where ? `installed (${where})` : 'not installed (oo next falls back to general-purpose with the definition file)'}`);
  }
  say(env, `Verification shell: ${sh.shell} (${sh.source})`, `State directory: ${env.paths.stateRoot}`);
  say(env, `NEXT: ${AGENTS.every((ag) => agentInstalled(env, ag)) ? 'oo init <objective>' : `optionally install the agents with node ${path.join(SKILL_DIR, 'scripts', 'install.cjs')} --project <dir> --agents-only (restart Claude Code afterwards), then oo init <objective>`}`);
  return 0;
}

function readVersion() {
  try {
    return fs.readFileSync(path.join(SKILL_DIR, 'VERSION'), 'utf8').trim();
  } catch (_) {
    return 'unknown';
  }
}

function cmdVersion(env) {
  say(env, `opus-orchestrator ${readVersion()}`, 'NEXT: oo help');
  return 0;
}

const HELP = [
  'oo <command> [options]   (node <skill>/scripts/oo.cjs)',
  'Exit codes: 0 success; 1 refused (an invariant, limit or validation failed; the message says why and what next); 2 usage error.',
  '',
  'Run lifecycle:',
  '  init [--mode fast|balanced|thorough|maximum] [--max-workers N] [--review-rounds N] [--plan-only] [--] <objective>',
  '       options are read only before the objective; the objective starts at the first other word (or after a bare --)',
  '       and is kept verbatim, so later words such as --mode belong to it; the text may also come from --stdin or --file F',
  '       (also read only before the objective); init --status = status, init --resume = resume (only before the objective)',
  '  plan --file F | --stdin            validate, route and save task specifications (nothing is saved on any error)',
  '  next [--inline]                    dispatch ready tasks: Agent calls plus a short prompt naming the package file',
  '  started <ID> [<ID>...]             DISPATCHED -> RUNNING after the agents were launched',
  '  result <ID> --stdin [--tokens N] [--worktree P] [--agent-id A] [--verify]   the report must carry the attempt_id of its package',
  '  verify <ID> [--takeover OP]        run the verification commands (clean checkout or snapshot) and the scope check',
  '  check <ID> --name N --result pass|fail --note T',
  '  review-package <ID> [--inline]     independent reviewer call and package',
  '  review <ID> --stdin [--agent-id A] [--integrate]  record a review (independent: its review_id and the reviewer agent id); reviewer orchestrator is your own gate',
  '  correct <ID> --stdin               correction request (bounded by max_review_rounds) -> READY',
  '  integrate <ID> [--takeover OP]     merge the verified candidate in a clean checkout, check that commit, fast-forward the integration branch (worktree) or re-check (shared) -> COMPLETED',
  '  worker-failed <ID> --kind crash|invalid_output|permission|rate_limit|context|timeout|tool|budget --reason T',
  '  escalate <ID> --model M | --role R --reason T',
  '  amend <ID> --file F --reason T',
  '  block|unblock|fail|cancel|reopen <ID> --reason T [--user-authorized]    (cancel --all --reason T)',
  '  decision "<text>" ...',
  '  authorize --limit agent_call_limit|token_limit|cost_limit_usd|max_review_rounds|max_retries --value V --by user --reason T',
  '  authorize --task <ID> --side-effects --by user --reason T',
  '  usage --tokens N [--task ID] | --cost USD',
  '  reconcile <ID> --attempt AID --agent-gone --reason T   an in-flight attempt whose agent is known to have stopped -> READY',
  '  review-abandon <ID> --review RID --reason T   a lost reviewer; its late report is refused',
  '  rebaseline <ID> --reason T --user-authorized   shared workspace: take a new baseline at the next dispatch',
  '  repo-guard [--accept --reason T --user-authorized]   git configuration/hooks unchanged since init (worktree strategy)',
  '  status [--json]   checkpoint   resume   context [--utilization X]',
  '  deliver [--takeover OP]   final-report   cleanup',
  '  observe --category C --text T [--task ID]   learn',
  '  proposals [list | show ID | approve ID --by user | reject ID | apply ID | rollback ID]',
  '  doctor   version   help',
  '',
];

function cmdHelp(env) {
  say(env, HELP, sm.describe(), '', 'NEXT: oo doctor, then oo init <objective>');
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const COMMANDS = {
  plan: cmdPlan,
  next: cmdNext,
  started: cmdStarted,
  result: cmdResult,
  verify: cmdVerify,
  check: cmdCheck,
  'review-package': cmdReviewPackage,
  review: cmdReview,
  correct: cmdCorrect,
  integrate: cmdIntegrate,
  'review-abandon': cmdReviewAbandon,
  reconcile: cmdReconcile,
  rebaseline: cmdRebaseline,
  'repo-guard': cmdRepoGuard,
  'worker-failed': cmdWorkerFailed,
  escalate: cmdEscalate,
  amend: cmdAmend,
  block: cmdBlock,
  unblock: cmdUnblock,
  fail: cmdFail,
  cancel: cmdCancel,
  reopen: cmdReopen,
  decision: cmdDecision,
  authorize: cmdAuthorize,
  usage: cmdUsage,
  status: cmdStatus,
  checkpoint: cmdCheckpoint,
  resume: cmdResume,
  context: cmdContext,
  deliver: cmdDeliver,
  'final-report': cmdFinalReport,
  cleanup: cmdCleanup,
  observe: cmdObserve,
  learn: cmdLearn,
  proposals: cmdProposals,
  doctor: cmdDoctor,
  version: cmdVersion,
  help: cmdHelp,
};

function formatRefusal(e) {
  const lines = [`REFUSED: ${e.what}`];
  if (Array.isArray(e.why)) {
    lines.push('Reasons:', ...e.why.map((w) => `  - ${w}`));
  } else {
    lines.push(`Reason: ${e.why}`);
  }
  lines.push(`NEXT: ${e.next || 'oo status'}`);
  return lines;
}

function main(argv) {
  const env = makeEnv();
  let code;
  const cmd = argv[0];
  env.command = typeof cmd === 'string' ? cmd : null;
  try {
    if (!cmd || cmd === '--help' || cmd === '-h') code = cmdHelp(env);
    else if (cmd === 'init') code = cmdInit(env, argv.slice(1));
    else {
      const fn = COMMANDS[cmd];
      if (!fn) usage(`unknown command ${JSON.stringify(cmd)}`);
      code = fn(env, cliargs.parseArgv(argv.slice(1)));
    }
  } catch (e) {
    if (e instanceof Refusal) {
      say(env, formatRefusal(e));
      code = 1;
    } else if (e instanceof UsageError || e instanceof cliargs.ArgError) {
      say(env, `USAGE ERROR: ${e.message}`, 'NEXT: oo help lists every command and its options');
      code = 2;
    } else if (e && e.code === 'LOCK_TIMEOUT') {
      const unprovable = e.lockState !== 'ok' || store.ownerState(e.owner) === 'unknown';
      say(env, formatRefusal(new Refusal('command not run', e.message,
        unprovable
          ? 'the lock owner cannot be proven alive or dead; inspect it with node manage_state.cjs lock and break it only after confirming no oo process of this project runs'
          : 'wait for that oo command to finish and repeat this one (a lock is never taken from a live owner)')));
      code = 1;
    } else if (e && (e.code === 'LOCK_LOST' || e.code === 'LOCK_RECONCILIATION_REQUIRED' || e.code === 'LOCK_REENTRANT')) {
      say(env, formatRefusal(new Refusal('state lock problem', `${e.code}: ${e.message}`, 'node manage_state.cjs lock, then oo resume')));
      code = 1;
    } else {
      say(env, `ERROR: ${e && e.code ? `${e.code}: ` : ''}${e && e.message ? e.message : String(e)}`,
        'The command stopped; state on disk is unchanged unless the output above says otherwise.',
        'NEXT: oo status (and node manage_state.cjs integrity if the state looks damaged)');
      if (process.env.OPUS_ORCH_DEBUG && e && e.stack) say(env, e.stack);
      code = 1;
    }
  }
  const text = env.out.join('\n');
  process.stdout.write(text.endsWith('\n') || !text ? text : `${text}\n`);
  return code;
}

module.exports = { main, COMMANDS };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
