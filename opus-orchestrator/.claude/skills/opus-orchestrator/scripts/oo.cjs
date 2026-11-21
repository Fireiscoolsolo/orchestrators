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
  return store.withLock(env.paths, fn);
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
    if (strategy === 'worktree') {
      const dir = path.join(runDir(env, run.run_id), 'worktrees', 'integration');
      try {
        const r = gitops.ensureIntegration(projectDir, run.run_id, dir);
        run.workspace.integration_branch = r.branch;
        run.workspace.integration_worktree = relProject(env, dir);
        run.workspace.base_commit = r.base;
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
  return Object.assign(base, { mode: 'readonly', isolated: false, snapshotRoot: intDir });
}

function depSummaries(ctx, t) {
  return (t.dependencies || []).map((d) => {
    const dep = ctx.byId.get(d) || {};
    return { task_id: d, title: dep.title, summary: dep.result ? oneLine(dep.result.summary, 300) : null };
  });
}

function cmdNext(env, a) {
  cliargs.checkAllowed(a.opts, ['inline'], 'next');
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
    const batch = scheduler.selectBatch(schedTasks, {
      max_workers: lim.max_workers,
      parallel: ctx.cfg.execution.parallel_execution !== false,
      call_budget: remaining,
    });

    let snap = null;
    const snapshotFor = (root) => {
      if (snap && snap.root === root) return snap.rel;
      const data = gitops.snapshot(root, { ignore: workspace.snapshotIgnore(ctx.paths) });
      const name = `snapshots/dispatch-${ctx.now.replace(/[-:.]/g, '')}-${process.pid}.json`;
      const file = path.join(runDir(env, ctx.run.run_id), ...name.split('/'));
      store.writeJson(file, data);
      snap = { root, rel: relProject(env, file) };
      return snap.rel;
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
      const roleCfg = (ctx.cfg.routing.roles || {})[t.routing.role] || {};
      const text = packages.workerPackage(t, {
        brief: roleCfg.brief, agent: t.routing.agent, deps: depSummaries(ctx, t), orchestrator: isOrch, workspace: ws,
      });
      const pkgFile = writeRunFile(env, ctx.run.run_id, `packages/${id}-d${t.attempts}.md`, text);
      t.dispatch = {
        attempt: t.attempts, at: ctx.now, kind, package: relProject(env, pkgFile), mode: ws.mode, isolated: ws.isolated,
        integration_head: ws.integrationHead || null, snapshot: ws.snapshotRoot ? snapshotFor(ws.snapshotRoot) : null,
        snapshot_root: ws.snapshotRoot ? relProject(env, ws.snapshotRoot) : null,
        self_worktree: ws.selfWorktree ? { dir: relProject(env, ws.selfWorktree.dir), branch: ws.selfWorktree.branch } : null,
      };
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
  t.failures = (t.failures || []).concat([{ kind, reason, ts: ctx.now, attempt: t.attempts || 0 }]);
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
  cliargs.checkAllowed(a.opts, ['kind', 'reason'], 'worker-failed');
  const id = a.pos[0];
  if (!id) usage('worker-failed needs a task id: oo worker-failed <ID> --kind K --reason T');
  const kind = a.opts.kind;
  if (!FAILURE_KINDS.includes(kind)) usage(`--kind must be one of ${FAILURE_KINDS.join('|')}`);
  const reason = needReason(a);
  return locked(env, () => {
    const ctx = openRun(env);
    const t = getTask(ctx, id);
    if (!sm.IN_FLIGHT.includes(t.status)) {
      refuse(`worker failure for ${id} not recorded`, `${id} is ${t.status}; worker failures apply to DISPATCHED or RUNNING tasks`, 'check oo status; for a finished task use block, fail or cancel');
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
  cliargs.checkAllowed(a.opts, ['stdin', 'file', 'tokens', 'worktree', 'branch', 'verify'], 'result');
  const id = a.pos[0];
  if (!id) usage('result needs a task id: oo result <ID> --stdin');
  let tokens = null;
  if (a.opts.tokens !== undefined) {
    if (!/^\d+$/.test(String(a.opts.tokens))) usage('--tokens must be a non-negative integer');
    tokens = Number(a.opts.tokens);
  }
  const text = readInput(a);
  let completed = false;
  const code = locked(env, () => {
    const ctx = openRun(env);
    let t = getTask(ctx, id);
    const unchanged = `result for ${id} rejected; task state unchanged`;
    if (t.status === 'CANCELLED') {
      refuse(`result for ${id} refused`, `${id} was cancelled; a late result for a cancelled task is never applied`, 'ignore that worker\'s output; reopen the task only if the user asks (oo reopen <ID> --reason <text> --user-authorized)');
    }
    if (!sm.IN_FLIGHT.includes(t.status)) {
      refuse(`result for ${id} refused`, `${id} is ${t.status}; a worker result is accepted only while the task is DISPATCHED or RUNNING`, firstNext(ctx, 'oo status'));
    }
    const failNext = `send the errors back to the worker, or record oo worker-failed ${id} --kind invalid_output --reason <text>`;
    const obj = parseReportBlock(text, 'result', id, failNext);
    const v = reports.validateAgentResult(obj, t);
    if (!v.ok) refuse(unchanged, v.errors, failNext);
    const r = v.result;
    const notes = [];

    let worktree = null;
    let branch = r.branch || null;
    let commit = r.commit || null;
    const ws = ctx.run.workspace || {};
    if (r.status === 'completed' && ws.strategy === 'worktree' && t.dispatch && t.dispatch.isolated) {
      const given = a.opts.worktree || (t.dispatch.self_worktree ? absProject(env, t.dispatch.self_worktree.dir) : null);
      if (!given) {
        if (commit || r.files_changed.length) {
          refuse(unchanged, 'worktree strategy: the worker changed files in its own worktree, so oo needs the worktree path to verify them', `repeat with --worktree <path> --branch <branch> taken from the Agent result`);
        }
        notes.push('no worktree given and no change reported: the result is verified in the integration worktree');
      } else {
        worktree = path.resolve(String(given));
        if (!fs.existsSync(worktree)) refuse(unchanged, `worktree ${worktree} does not exist`, 'pass the worktree path from the Agent result with --worktree');
        const head = gitops.git(['rev-parse', 'HEAD'], { cwd: worktree });
        if (head.code !== 0) refuse(unchanged, `${worktree} is not a git worktree: ${head.stderr.trim()}`, 'pass the worktree path from the Agent result with --worktree');
        const sha = head.stdout.trim();
        if (commit && !sha.startsWith(commit)) notes.push(`the reported commit ${commit} differs from the worktree HEAD ${sha}; HEAD is used`);
        commit = sha;
        if (a.opts.branch) branch = String(a.opts.branch);
        if (!branch) {
          const b = gitops.git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: worktree });
          branch = b.code === 0 ? b.stdout.trim() : null;
        }
      }
    }

    r.files_changed = relativizeReported(env, r.files_changed, [worktree, t.dispatch && t.dispatch.self_worktree ? absProject(env, t.dispatch.self_worktree.dir) : null]);
    const reportFile = writeRunFile(env, ctx.run.run_id, `reports/${id}-d${t.attempts || 0}.yaml`, yaml.stringify(r));
    if (tokens !== null) ctx.run.usage = budget.recordTokens(ctx.run.usage, { task_id: id, total: tokens });
    if (t.status === 'DISPATCHED') t = move(ctx, t, 'RUNNING', { reason: 'result received before oo started' });

    if (r.status === 'completed') {
      t = move(ctx, t, 'IMPLEMENTED', { reason: 'worker reported completed' });
      t.result = {
        summary: r.summary, files_changed: r.files_changed, commit, branch,
        worktree: worktree ? relProject(env, worktree) : null, tokens, reported_at: ctx.now,
        report_file: relProject(env, reportFile), issues: r.issues || [], commands_run: r.commands_run || [],
      };
      t.evidence = t.evidence || {};
      t.evidence.self_check = r.self_check;
      t.correction = null;
      persist(ctx, { command: 'result', task_id: id, status: r.status });
      completed = true;
      const unmet = (r.self_check || []).map((c, i) => (c.met ? null : i + 1)).filter(Boolean);
      say(env, `RESULT ACCEPTED: ${id} -> IMPLEMENTED (${oneLine(r.summary, 160)})`);
      say(env, `Files reported: ${r.files_changed.length ? r.files_changed.join(', ') : 'none'}`);
      if (worktree) say(env, `Worktree: ${worktree} | branch ${branch || '?'} | commit ${commit}`);
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
    const outcome = workerFailure(ctx, t, kind, reason);
    persist(ctx, { command: 'result', task_id: id, status: r.status, outcome });
    say(env, `RESULT RECORDED: ${id} reported ${r.status}: ${reason}`);
    if (kind === 'needs_decomposition') say(env, 'Proposed subtasks:', ...indent(yaml.stringify(r.proposed_subtasks).trimEnd()));
    sayFailureOutcome(env, ctx, id, kind, outcome);
    return 0;
  });
  if (code === 0 && completed && a.opts.verify) return runVerify(env, id);
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

/** Where the task's work lives and which files it changed, with the scope verdict. */
function computeChanges(ctx, t) {
  const env = ctx.env;
  const ws = ctx.run.workspace || {};
  const d = t.dispatch || {};
  if (ws.strategy === 'worktree' && t.result && t.result.worktree) {
    const dir = absProject(env, t.result.worktree);
    if (!fs.existsSync(dir)) {
      refuse(`verification of ${t.task_id} not started`, `the task's worktree ${dir} no longer exists`, `ask for the work again: oo block ${t.task_id} --reason <text> then oo unblock, or oo fail it`);
    }
    const ch = workspace.worktreeChanges(dir, d.integration_head, t.result.commit || 'HEAD');
    const uncommitted = workspace.uncommittedFiles(dir);
    const scope = verify.checkScope(ch.files, t.authorized_files || []);
    return {
      cwd: dir, files: ch.files, scope: Object.assign(scope, { ignored: [], basis: `git diff ${ch.base ? ch.base.slice(0, 12) : '?'}..${String(t.result.commit).slice(0, 12)}` }),
      extraChecks: uncommitted.length ? [{ name: 'work committed', result: 'fail', note: `uncommitted changes in the worktree: ${uncommitted.join(', ')}` }] : [],
      diff: { cwd: dir, base: ch.base, commit: t.result.commit },
    };
  }
  if (ws.strategy === 'worktree' && d.isolated) {
    return { cwd: integrationDir(ctx), files: [], scope: { ok: true, violations: [], ignored: [], basis: 'no change reported and no worktree' }, extraChecks: [] };
  }
  const root = d.snapshot_root ? absProject(env, d.snapshot_root) : ctx.paths.projectDir;
  const before = d.snapshot ? readSnapshotFile(env, d.snapshot) : null;
  if (!before) {
    const files = (t.result && t.result.files_changed) || [];
    const scope = verify.checkScope(files, t.authorized_files || []);
    return { cwd: root, files, scope: Object.assign(scope, { ignored: [], basis: 'files reported by the worker (no dispatch snapshot recorded)' }), extraChecks: [] };
  }
  const after = gitops.snapshot(root, { ignore: workspace.snapshotIgnore(ctx.paths) });
  const changed = gitops.diffSnapshot(before, after);
  const att = workspace.attributeShared(t, changed, ctx.tasks, d.at || '');
  return {
    cwd: root, files: att.own.concat(att.violations),
    scope: { ok: att.ok, violations: att.violations, ignored: att.ignored, basis: 'file snapshot diff since dispatch' },
    extraChecks: [],
  };
}

function commandLines(cmds) {
  const out = [];
  for (const c of cmds || []) {
    const status = c.refused ? 'refused' : c.timed_out ? 'timed out' : `exit ${c.exit_code === null ? 'none' : c.exit_code}`;
    out.push(`  [${status}] ${c.command} (${c.duration_ms} ms)${c.reason ? ` - ${c.reason}` : ''}`);
  }
  return out;
}

function evidenceText(title, info) {
  const L = [title, `Run at: ${info.at}`, `Workspace: ${info.cwd}`, `Shell: ${info.shell || '(no command run)'}`];
  if (info.basis) L.push(`Scope basis: ${info.basis}`);
  if ((info.correctionCommands || []).length) L.push(`Correction-round commands (from the correction request): ${info.correctionCommands.join(' ; ')}`);
  if (info.files) L.push(`Changed files: ${info.files.length ? info.files.join(', ') : 'none'}`);
  if (info.scope) {
    L.push(`Scope: ${info.scope.ok ? 'ok' : `VIOLATIONS: ${info.scope.violations.join(', ')}`}`);
    for (const g of info.scope.ignored || []) L.push(`Ignored (inside the scope of ${g.owner}, which owned work since this dispatch): ${g.file}`);
  }
  for (const c of info.checks || []) L.push(`Check ${c.name}: ${c.result}${c.note ? ` (${c.note})` : ''}`);
  for (const c of info.commands || []) {
    L.push('', `$ ${c.command}`, `exit ${c.exit_code === null ? 'none' : c.exit_code} | ${c.duration_ms} ms${c.timed_out ? ' | timed out' : ''}${c.refused ? ' | refused' : ''}${c.reason ? ` | ${c.reason}` : ''}`);
    if (c.output_tail) L.push(c.output_tail);
  }
  L.push('', `Verdict: ${info.passed ? 'passed' : 'failed'}${info.reasons ? ` - ${info.reasons.join('; ')}` : ''}`);
  return L.join('\n') + '\n';
}

function runVerify(env, id) {
  const prep = locked(env, () => {
    const ctx = openRun(env);
    let t = getTask(ctx, id);
    if (!['IMPLEMENTED', 'VERIFYING'].includes(t.status)) {
      const why = `${id} is ${t.status}; verification runs on IMPLEMENTED tasks (or re-runs on VERIFYING)`;
      refuse(`verification of ${id} not started`, why, firstNext(ctx, 'oo status'));
    }
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
    const changes = computeChanges(ctx, t);
    if (t.status === 'IMPLEMENTED') {
      t = move(ctx, t, 'VERIFYING', { reason: 'verification started' });
      persist(ctx, { command: 'verify', task_id: id, phase: 'start' });
    }
    return {
      cmds, changes, correctionCmds,
      timeout: (Number(ctx.cfg.execution.command_timeout_seconds) || 600) * 1000,
      extraUnsafe: (ctx.cfg.security && ctx.cfg.security.extra_unsafe_patterns) || [],
    };
  });
  const cr = prep.cmds.length
    ? verify.runCommands(prep.cmds, { cwd: prep.changes.cwd, timeout_ms: prep.timeout, extraUnsafe: prep.extraUnsafe })
    : { passed: null, shell: null, commands: [] };

  return locked(env, () => {
    const ctx = openRun(env);
    let t = getTask(ctx, id);
    if (t.status !== 'VERIFYING') {
      refuse(`verification result for ${id} discarded`, `${id} moved to ${t.status} while the commands ran`, firstNext(ctx, 'oo status'));
    }
    const ch = prep.changes;
    const storedChecks = (t.evidence && t.evidence.checks) || [];
    const allChecks = storedChecks.concat(ch.extraChecks);
    const v = verify.verdict({ commandsResult: cr, checks: allChecks, scope: ch.scope });
    const n = (t.verification_runs || 0) + 1;
    const evRel = store.writeEvidence(ctx.paths, ctx.run.run_id, `${id}-verify-${n}.txt`, evidenceText(
      `Verification ${n} of ${id} (round ${t.review_round || 0}, attempt ${t.attempts || 0})`,
      { at: ctx.now, cwd: ch.cwd, shell: cr.shell, basis: ch.scope.basis, files: ch.files, scope: ch.scope, checks: allChecks, commands: cr.commands, passed: v.passed, reasons: v.reasons, correctionCommands: prep.correctionCmds }));
    t.verification_runs = n;
    t.evidence.verification = {
      passed: v.passed, run_at: ctx.now, shell: cr.shell, workspace: relProject(env, ch.cwd),
      commands: cr.commands, checks: allChecks, scope: { ok: ch.scope.ok, violations: ch.scope.violations, ignored: ch.scope.ignored || [], basis: ch.scope.basis },
      changed_files: ch.files, reasons: v.reasons, evidence_file: evRel, correction_commands: prep.correctionCmds,
      diff: ch.diff ? { cwd: relProject(env, ch.diff.cwd), base: ch.diff.base, commit: ch.diff.commit } : null,
    };
    touch(ctx, t);
    ctx.run.usage = budget.recordVerification(ctx.run.usage, id);
    if (v.passed) t = move(ctx, t, 'REVIEWING', { reason: 'verification passed' });
    else t = move(ctx, t, 'CORRECTION_REQUIRED', { reason: `verification failed: ${v.reasons.join('; ')}` });
    persist(ctx, { command: 'verify', task_id: id, passed: v.passed });

    const evAbs = absProject(env, evRel);
    if (v.passed) {
      say(env, `VERIFICATION PASSED: ${id} -> REVIEWING`, ...v.reasons.map((r) => `  ${r}`));
      if (cr.commands.length) say(env, 'Commands:', ...commandLines(cr.commands));
      say(env, `Changed files: ${ch.files.length ? ch.files.join(', ') : 'none'}`);
      for (const g of ch.scope.ignored || []) say(env, `Ignored: ${g.file} (inside the scope of ${g.owner}, which owned work since this dispatch)`);
      say(env, `Evidence: ${evAbs}`);
      const needsIndependent = t.routing && (t.routing.independent_review || t.routing.role === 'orchestrator');
      say(env, needsIndependent
        ? `NEXT: oo review-package ${id} (an independent review is required), then oo review ${id} --stdin for each review`
        : `NEXT: oo review ${id} --stdin with your own review (reviewer: orchestrator)`);
      return 0;
    }
    say(env, `VERIFICATION FAILED: ${id} -> CORRECTION_REQUIRED`, ...v.reasons.map((r) => `  - ${r}`));
    const failing = cr.commands.filter((c) => c.refused || c.timed_out || c.exit_code !== 0);
    for (const c of failing) {
      say(env, `Failing command: ${c.command}`, `Exit code: ${c.refused ? 'refused' : c.timed_out ? 'timed out' : c.exit_code}${c.reason ? ` (${c.reason})` : ''}`, 'Output tail:', ...indent(c.output_tail || '(no output)', '  | '));
    }
    if (!ch.scope.ok) say(env, `Scope violations (changed outside the authorized files): ${ch.scope.violations.join(', ')}`);
    for (const g of ch.scope.ignored || []) say(env, `Ignored: ${g.file} (inside the scope of ${g.owner})`);
    say(env, `Evidence: ${evAbs}`);
    say(env, `NEXT: oo correct ${id} --stdin with a correction request (failure, evidence, expected_behavior, required_change, verification, verification_commands (a command that fails before the fix and passes after it, when one exists)${(t.review_round || 0) >= 1 ? ', strategy_change' : ''})`);
    return 1;
  });
}

function cmdVerify(env, a) {
  cliargs.checkAllowed(a.opts, [], 'verify');
  const id = a.pos[0];
  if (!id) usage('verify needs a task id: oo verify <ID>');
  return runVerify(env, id);
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

function cmdReviewPackage(env, a) {
  cliargs.checkAllowed(a.opts, ['inline'], 'review-package');
  const id = a.pos[0];
  if (!id) usage('review-package needs a task id');
  return locked(env, () => {
    const ctx = openRun(env);
    const t = getTask(ctx, id);
    if (t.status !== 'REVIEWING') {
      refuse(`no review package for ${id}`, `${id} is ${t.status}; an independent review starts after verification passed (REVIEWING)`, firstNext(ctx, 'oo status'));
    }
    const chk = budgetCheck(ctx);
    const remaining = budget.remainingCalls(ctx.run.usage, ctx.cfg.budget, ctx.run.authorizations);
    if (chk.state === 'exceeded' || remaining < 1) {
      refuse(`no review package for ${id}: the budget is exceeded`, chk.messages.length ? chk.messages : ['no agent calls remain'], 'ask the user; a higher limit is recorded only with oo authorize --limit agent_call_limit --value <n> --by user --reason <text>');
    }
    const role = t.security_sensitive ? 'security-worker' : 'review-worker';
    const floor = t.routing && MODEL_ORDER.includes(t.routing.model) ? t.routing.model : 'auto';
    const rspec = Object.assign({}, t, { kind: 'review', assigned_role: role, assigned_model: floor });
    const rr = routing.route(rspec, ctx.cfg, readStats(ctx), ctx.run.options.mode);
    const agent = rr.agent || 'opus-reviewer';
    const v = t.evidence.verification || {};
    const changes = v.diff && v.diff.base
      ? { kind: 'diff', cwd: absProject(env, v.diff.cwd || '.'), command: `git diff ${v.diff.base} ${v.diff.commit}`, files: v.changed_files || [] }
      : { kind: 'files', files: v.changed_files || [] };
    changes.reported = (t.result && t.result.files_changed) || [];
    const evidenceFiles = [v.evidence_file, t.result && t.result.report_file].filter(Boolean).map((f) => absProject(env, f));
    const n = (t.review_packages || 0) + 1;
    const text = packages.reviewPackage(t, {
      reviewer: agent, changes, evidenceFiles,
      verificationSummary: v.passed ? `passed at ${v.run_at}: ${(v.reasons || []).join('; ')}` : 'not passed',
    });
    const file = writeRunFile(env, ctx.run.run_id, `packages/${id}-review-${n}.md`, text);
    t.review_packages = n;
    // The current round's evidence records the package; a correction archives it, so each round needs its own.
    t.evidence.review_packages = (t.evidence.review_packages || []).concat([{ n, at: ctx.now, round: t.review_round || 0, file: relProject(env, file) }]);
    touch(ctx, t);
    ctx.run.usage = budget.recordCall(ctx.run.usage, { task_id: id, kind: 'review' });
    persist(ctx, { command: 'review-package', task_id: id, n });
    const target = agentTarget(env, agent);
    say(env, `REVIEW PACKAGE ${id} #${n} (independent review; model routed for a review of complexity ${t.complexity}, at least the worker's model)`);
    say(env, packages.agentCallLine({ subagentType: target.subagentType, model: rr.model, description: packages.describeTask({ task_id: `${id} review`, title: t.title }) }));
    if (target.agentFile) say(env, `(agent ${agent} is not installed in .claude/agents; the prompt tells general-purpose to read its definition first)`);
    if (a.opts.inline) printPrompt(env, (target.agentFile ? `First read ${target.agentFile} and follow it as your role definition.\n\n` : '') + text);
    else printPrompt(env, packages.shortPrompt(file, target.agentFile));
    say(env, `NEXT: launch the reviewer, then oo review ${id} --stdin with its report`);
    return 0;
  });
}

/** Approving independent reviews a high-risk task needs in this round (mode setting reviewers_high_risk); 1 for other tasks. */
function highRiskReviewers(ctx, t) {
  if (t.risk !== 'high') return 1;
  const mode = ((ctx.cfg.verification || {}).modes || {})[ctx.run.options.mode] || {};
  return Number.isInteger(mode.reviewers_high_risk) && mode.reviewers_high_risk > 1 ? mode.reviewers_high_risk : 1;
}

function cmdReview(env, a) {
  cliargs.checkAllowed(a.opts, ['stdin', 'file', 'integrate'], 'review');
  const id = a.pos[0];
  if (!id) usage('review needs a task id: oo review <ID> --stdin');
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
    if (independent && !(t.evidence.review_packages || []).length) {
      refuse(`review of ${id} refused; task state unchanged`,
        `the reviewer is ${JSON.stringify(rv.reviewer)}, not orchestrator, and no review package was issued for ${id} in the current round (round ${round}); an independent review is accepted only from a reviewer launched with oo review-package in this round`,
        `oo review-package ${id}, launch the reviewer it prints, then oo review ${id} --stdin with that reviewer's report (for your own quality gate use reviewer: orchestrator)`);
    }
    const n = ((t.evidence.reviews || []).length) + 1;
    const entry = {
      reviewer: rv.reviewer, independent, verdict: rv.verdict, criteria: rv.criteria, findings: rv.findings || [],
      checks: rv.checks || {}, recorded_at: ctx.now, round, report_file: null,
    };
    t.evidence.reviews = (t.evidence.reviews || []).concat([entry]);
    touch(ctx, t);
    let outcome;
    if (rv.verdict === 'approve') {
      if (independent) {
        outcome = 'independent_approve';
      } else {
        const requires = !!(t.routing && (t.routing.independent_review || t.routing.role === 'orchestrator'));
        const needed = highRiskReviewers(ctx, t);
        const have = (t.evidence.reviews || []).filter((x) => x.independent && x.verdict === 'approve').length;
        if (needed > 1 && have < needed) {
          refuse(`approval of ${id} refused; task state unchanged`,
            `${id} is high risk and mode ${ctx.run.options.mode} requires ${needed} approving independent reviews in the current round (round ${round}); ${have} recorded`,
            `oo review-package ${id}, launch the next reviewer, record its report with oo review ${id} --stdin until ${needed} approve, then approve again`);
        }
        t = move(ctx, t, 'APPROVED', { reason: 'approved by the orchestrator', requiresIndependentReview: requires });
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
    ctx.events.push({ type: 'review', task_id: id, reviewer: rv.reviewer, verdict: rv.verdict, independent });
    persist(ctx, { command: 'review', task_id: id, outcome });

    if (outcome === 'independent_approve') {
      const needed = highRiskReviewers(ctx, ctx.byId.get(id));
      const have = (ctx.byId.get(id).evidence.reviews || []).filter((x) => x.independent && x.verdict === 'approve').length;
      say(env, `INDEPENDENT REVIEW RECORDED: ${id} approved by ${rv.reviewer}; ${id} stays REVIEWING until your own gate`,
        have < needed
          ? `NEXT: ${id} is high risk and needs ${needed} approving independent reviews in this round (${have} so far): oo review-package ${id}, launch the next reviewer, then oo review ${id} --stdin`
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
  if (code === 0 && approved && a.opts.integrate) return runIntegrate(env, id);
  return code;
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

function runIntegrate(env, id) {
  const prep = locked(env, () => {
    const ctx = openRun(env);
    let t = getTask(ctx, id);
    if (!['APPROVED', 'INTEGRATING'].includes(t.status)) {
      refuse(`integration of ${id} not started`, `${id} is ${t.status}; integration needs an APPROVED task`, firstNext(ctx, 'oo status'));
    }
    const ws = ctx.run.workspace || {};
    if (ws.strategy === 'worktree') {
      const other = ctx.tasks.find((x) => x.status === 'INTEGRATING' && x.task_id !== id);
      if (other) refuse(`integration of ${id} not started`, `${other.task_id} is being integrated into the same branch`, `finish it first: oo integrate ${other.task_id}`);
    }
    if (t.status === 'APPROVED') {
      t = move(ctx, t, 'INTEGRATING', { reason: 'integration started' });
      persist(ctx, { command: 'integrate', task_id: id, phase: 'start' });
    }
    const { cmds, regression } = integrationCommands(ctx, t);
    return {
      strategy: ws.strategy, intDir: integrationDir(ctx), commit: t.result && t.result.worktree ? t.result.commit : null,
      title: t.title, cmds, regression,
      timeout: (Number(ctx.cfg.execution.command_timeout_seconds) || 600) * 1000,
      extraUnsafe: (ctx.cfg.security && ctx.cfg.security.extra_unsafe_patterns) || [],
    };
  });

  let outcome;
  const run = (cwd) => (prep.cmds.length
    ? verify.runCommands(prep.cmds, { cwd, timeout_ms: prep.timeout, extraUnsafe: prep.extraUnsafe })
    : { passed: null, shell: null, commands: [] });
  if (prep.strategy === 'worktree' && prep.commit) {
    const cwd = prep.intDir;
    try {
      gitops.abortMerge(cwd);
      const before = gitops.git(['rev-parse', 'HEAD'], { cwd }).stdout.trim();
      const m = gitops.mergeNoCommit(cwd, prep.commit);
      if (m.conflict) {
        gitops.abortMerge(cwd);
        outcome = { kind: 'conflict', cwd, files: m.files, before, cr: { passed: null, shell: null, commands: [] } };
      } else {
        const cr = run(cwd);
        if (cr.passed !== false) {
          const sha = gitops.commitMerge(cwd, `opus-orch: integrate ${id}: ${prep.title}`);
          outcome = { kind: 'ok', cwd, sha, before, cr };
        } else {
          gitops.abortMerge(cwd);
          outcome = { kind: 'failed', cwd, before, cr };
        }
      }
    } catch (e) {
      try { gitops.abortMerge(cwd); } catch (_) { /* nothing to abort */ }
      outcome = { kind: 'merge_failed', cwd, message: e.message, cr: { passed: null, shell: null, commands: [] } };
    }
  } else {
    const cwd = prep.strategy === 'worktree' ? prep.intDir : env.paths.projectDir;
    const cr = run(cwd);
    outcome = { kind: cr.passed !== false ? 'ok' : 'failed', cwd, sha: null, cr };
  }

  return locked(env, () => {
    const ctx = openRun(env);
    let t = getTask(ctx, id);
    if (t.status !== 'INTEGRATING') {
      refuse(`integration result for ${id} discarded`, `${id} moved to ${t.status} while integration ran`, firstNext(ctx, 'oo status'));
    }
    const cr = outcome.cr;
    const passed = outcome.kind === 'ok';
    const n = (t.integration_runs || 0) + 1;
    const evRel = store.writeEvidence(ctx.paths, ctx.run.run_id, `${id}-integrate-${n}.txt`, evidenceText(
      `Integration ${n} of ${id} (${prep.strategy} workspace${prep.commit ? `, merge of ${prep.commit}` : ''})`,
      { at: ctx.now, cwd: outcome.cwd, shell: cr.shell, commands: cr.commands, passed, reasons: outcome.kind === 'conflict' ? [`merge conflict in ${outcome.files.join(', ')}`] : outcome.kind === 'merge_failed' ? [outcome.message] : null }));
    t.integration_runs = n;
    t.evidence.integration = {
      passed, run_at: ctx.now, commands: cr.commands, merged_commit: outcome.sha || null, regression: prep.regression,
      conflict_files: outcome.files || [], evidence_file: evRel,
    };
    touch(ctx, t);
    if (passed) {
      move(ctx, t, 'COMPLETED', { reason: outcome.sha ? `merged as ${outcome.sha}` : 'integration checks passed' });
    } else if (outcome.kind === 'conflict') {
      move(ctx, t, 'BLOCKED', { kind: 'merge_conflict', reason: `merge conflict in ${outcome.files.join(', ') || 'unknown files'}; integration branch unchanged at ${outcome.before}` });
    } else if (outcome.kind === 'merge_failed') {
      move(ctx, t, 'BLOCKED', { kind: 'merge_failed', reason: oneLine(outcome.message, 300) });
    } else {
      move(ctx, t, 'CORRECTION_REQUIRED', { reason: `integration checks failed: ${cr.commands.filter((c) => c.exit_code !== 0).map((c) => c.command).join(', ')}` });
    }
    persist(ctx, { command: 'integrate', task_id: id, outcome: outcome.kind });
    const evAbs = absProject(env, evRel);
    if (passed) {
      say(env, `INTEGRATED: ${id} -> COMPLETED${outcome.sha ? ` (merge commit ${outcome.sha} on ${ctx.run.workspace.integration_branch})` : ''}`);
      if (cr.commands.length) say(env, 'Commands:', ...commandLines(cr.commands));
      say(env, `Evidence: ${evAbs}`);
      const done = ctx.tasks.every((x) => x.status === 'COMPLETED' || x.status === 'CANCELLED');
      say(env, `NEXT: ${done ? 'oo final-report, then oo deliver' : firstNext(ctx, 'oo next')}`);
      return 0;
    }
    if (outcome.kind === 'conflict') {
      say(env, `MERGE CONFLICT: ${id} -> BLOCKED (kind merge_conflict)`,
        `Conflicting files: ${outcome.files.join(', ') || '(not reported)'}`,
        `The merge was aborted; the integration branch is unchanged at ${outcome.before}.`,
        `Evidence: ${evAbs}`,
        `NEXT: oo unblock ${id} --reason <text> to send it back to a worker, whose package merges the current integration head first (or amend, or ask the user)`);
      return 1;
    }
    if (outcome.kind === 'merge_failed') {
      say(env, `MERGE FAILED: ${id} -> BLOCKED (kind merge_failed): ${outcome.message}`, `Evidence: ${evAbs}`, `NEXT: inspect ${outcome.cwd}, then oo unblock ${id} --reason <text> or ask the user`);
      return 1;
    }
    say(env, `INTEGRATION FAILED: ${id} -> CORRECTION_REQUIRED${prep.strategy === 'worktree' && prep.commit ? '; the merge was aborted and the integration branch is unchanged' : ''}`);
    for (const c of cr.commands.filter((x) => x.refused || x.timed_out || x.exit_code !== 0)) {
      say(env, `Failing command: ${c.command}`, `Exit code: ${c.refused ? 'refused' : c.timed_out ? 'timed out' : c.exit_code}`, 'Output tail:', ...indent(c.output_tail || '(no output)', '  | '));
    }
    say(env, `Evidence: ${evAbs}`, `NEXT: oo correct ${id} --stdin`);
    return 1;
  });
}

function cmdIntegrate(env, a) {
  cliargs.checkAllowed(a.opts, [], 'integrate');
  const id = a.pos[0];
  if (!id) usage('integrate needs a task id: oo integrate <ID>');
  return runIntegrate(env, id);
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
      if (sm.IN_FLIGHT.includes(t.status)) inflight.push(t.task_id);
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
    const requeued = [];
    const notRequeued = [];
    if (a.opts['requeue-running']) {
      for (const t of ctx.tasks.filter((x) => sm.IN_FLIGHT.includes(x.status))) {
        if (t.side_effects === 'external') {
          notRequeued.push(`${t.task_id} (external side effects: check what its agent already did, then oo fail or oo block it)`);
          continue;
        }
        const retries = t.retries || 0;
        const lim = Object.assign({}, limits(ctx), { max_retries: retries + 1 });
        const n = move(ctx, t, 'READY', { reason: 'requeued on resume: its agent is gone (no retry consumed)', limits: lim });
        n.retries = retries;
        requeued.push(`${t.task_id} (${t.status} -> READY)`);
      }
    }
    ctx.events.push({ type: 'resume', recovered: integ.recovered, problems: integ.problems, requeued });
    persist(ctx, { command: 'resume' });
    say(env, integ.recovered.length ? 'INTEGRITY: restored' : 'INTEGRITY: ok');
    for (const r of integ.recovered) say(env, `  restored from backup: ${r} (the backup holds the version before the last save; check that task's status below)`);
    if (requeued.length) say(env, `REQUEUED: ${requeued.join(', ')}`);
    if (notRequeued.length) say(env, `NOT REQUEUED: ${notRequeued.join('; ')}`);
    const inflight = ctx.tasks.filter((t) => sm.IN_FLIGHT.includes(t.status)).map((t) => t.task_id);
    if (inflight.length && !a.opts['requeue-running']) say(env, `In flight: ${inflight.join(', ')}. If their agents are gone, run oo resume --requeue-running.`);
    const maxLines = Number.isInteger(ctx.cfg.context && ctx.cfg.context.max_resume_lines) ? ctx.cfg.context.max_resume_lines : 120;
    say(env, checkpoint.renderResume(checkpoint.buildCheckpoint(ctx.run, ctx.tasks, ctx.now), { maxLines }));
    say(env, `NEXT: ${firstNext(ctx, ctx.tasks.length ? 'oo final-report' : 'oo plan --file <specs.yaml>')}`);
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
  cliargs.checkAllowed(a.opts, [], 'deliver');
  return locked(env, () => {
    const ctx = openRun(env);
    if (!ctx.tasks.length) refuse('nothing delivered', 'the run has no tasks', 'oo plan --file <specs.yaml>');
    const open = ctx.tasks.filter((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED');
    if (open.length) {
      refuse('nothing delivered', open.map((t) => `${t.task_id} is ${t.status}`), 'finish, cancel or escalate those tasks first (oo status), or report the partial result with oo final-report');
    }
    const ws = ctx.run.workspace || {};
    // Final audit: in a mode whose final_audit setting is true, the regression command runs on the
    // integrated result before anything is delivered.
    const mode = ((ctx.cfg.verification || {}).modes || {})[ctx.run.options.mode] || {};
    let auditNote = null;
    if (mode.final_audit === true) {
      const rc = ctx.cfg.verification.regression_command;
      if (!rc) {
        auditNote = `FINAL AUDIT: mode ${ctx.run.options.mode} asks for a final audit, but no final audit command is configured (verification.regression_command is null); delivering without it`;
      } else {
        const cwd = ws.strategy === 'worktree' && integrationDir(ctx) ? integrationDir(ctx) : ctx.paths.projectDir;
        const cr = verify.runCommands([rc], {
          cwd, timeout_ms: (Number(ctx.cfg.execution.command_timeout_seconds) || 600) * 1000,
          extraUnsafe: (ctx.cfg.security && ctx.cfg.security.extra_unsafe_patterns) || [],
        });
        const passed = cr.passed === true;
        const evRel = store.writeEvidence(ctx.paths, ctx.run.run_id, 'final-audit.txt', evidenceText(
          `Final audit of run ${ctx.run.run_id} (mode ${ctx.run.options.mode}, ${ws.strategy === 'worktree' ? 'integration worktree' : 'project directory'})`,
          { at: ctx.now, cwd, shell: cr.shell, commands: cr.commands, passed }));
        ctx.run.final_audit = { passed, run_at: ctx.now, command: rc, commands: cr.commands, evidence_file: evRel };
        ctx.events.push({ type: 'final_audit', passed });
        const evAbs = absProject(env, evRel);
        if (!passed) {
          persist(ctx, { command: 'deliver', outcome: 'final_audit_failed' });
          say(env, 'FINAL AUDIT FAILED: nothing delivered', ...commandLines(cr.commands));
          for (const c of cr.commands.filter((x) => x.refused || x.timed_out || x.exit_code !== 0)) {
            say(env, `Failing command: ${c.command}`, `Exit code: ${c.refused ? 'refused' : c.timed_out ? 'timed out' : c.exit_code}`, 'Output tail:', ...indent(c.output_tail || '(no output)', '  | '));
          }
          say(env, `Evidence: ${evAbs}`, 'NEXT: find what broke the integrated result, fix it with a new task (oo plan --file <specs.yaml>) or ask the user; oo deliver runs the audit again');
          return 1;
        }
        auditNote = `FINAL AUDIT PASSED: ${rc} (evidence ${evAbs})`;
      }
    }
    if (auditNote) say(env, auditNote);
    if (ws.strategy === 'worktree') {
      const cur = gitops.git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: ctx.paths.projectDir });
      const branch = cur.code === 0 ? cur.stdout.trim() : null;
      if (ws.base_branch && branch !== ws.base_branch) {
        refuse('nothing delivered', `the main checkout is on ${branch || 'a detached HEAD'}, but the run started on ${ws.base_branch}`, `switch back to ${ws.base_branch} (or merge ${ws.integration_branch} yourself), then oo deliver`);
      }
      const ff = gitops.fastForward(ctx.paths.projectDir, ws.integration_branch);
      if (!ff.ok) {
        refuse('nothing delivered: the fast-forward was not possible', ff.reason, `nothing was forced; ask the user how to bring ${ws.integration_branch} into ${ws.base_branch} (for example a manual merge)`);
      }
      const head = gitops.git(['rev-parse', 'HEAD'], { cwd: ctx.paths.projectDir }).stdout.trim();
      ctx.run.delivered = true;
      ctx.run.delivery = { at: ctx.now, branch, head, from: ws.integration_branch };
      ctx.events.push({ type: 'deliver', head });
      persist(ctx, { command: 'deliver' });
      say(env, `DELIVERED: ${branch} fast-forwarded to ${head} (${ws.integration_branch}); uncommitted files in the main checkout were not touched`, 'NEXT: oo final-report, then oo cleanup');
      return 0;
    }
    ctx.run.delivered = true;
    ctx.run.delivery = { at: ctx.now, branch: null, head: null, from: null };
    ctx.events.push({ type: 'deliver' });
    persist(ctx, { command: 'deliver' });
    say(env, 'DELIVERED: shared workspace, the changes are already in place; nothing to move', 'NEXT: oo final-report');
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
  say(env,
    `DOCTOR (opus-orchestrator ${readVersion()})`,
    `Node: ${process.version}`,
    `git: ${gitV || 'not found'}`,
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
  '  result <ID> --stdin [--tokens N] [--worktree P --branch B] [--verify]',
  '  verify <ID>                        run the verification commands and the scope check',
  '  check <ID> --name N --result pass|fail --note T',
  '  review-package <ID> [--inline]     independent reviewer call and package',
  '  review <ID> --stdin [--integrate]  record a review; reviewer orchestrator is your own quality gate',
  '  correct <ID> --stdin               correction request (bounded by max_review_rounds) -> READY',
  '  integrate <ID>                     merge (worktree) or re-check (shared) -> COMPLETED',
  '  worker-failed <ID> --kind crash|invalid_output|permission|rate_limit|context|timeout|tool|budget --reason T',
  '  escalate <ID> --model M | --role R --reason T',
  '  amend <ID> --file F --reason T',
  '  block|unblock|fail|cancel|reopen <ID> --reason T [--user-authorized]    (cancel --all --reason T)',
  '  decision "<text>" ...',
  '  authorize --limit agent_call_limit|token_limit|cost_limit_usd|max_review_rounds|max_retries --value V --by user --reason T',
  '  authorize --task <ID> --side-effects --by user --reason T',
  '  usage --tokens N [--task ID] | --cost USD',
  '  status [--json]   checkpoint   resume [--requeue-running]   context [--utilization X]',
  '  deliver   final-report   cleanup',
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
      say(env, formatRefusal(new Refusal('command not run', 'another oo process holds the state lock', 'wait for it to finish and repeat the command')));
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
