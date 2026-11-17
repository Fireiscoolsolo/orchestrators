#!/usr/bin/env node
'use strict';
/**
 * fo - command line of the fable-orchestrator skill.
 *
 * The orchestrating model decides WHAT to do (decomposition, review judgement,
 * correction wording). fo decides what is ALLOWED and records what HAPPENED:
 * contract validation, routing, scheduling, the task state machine, command
 * execution with captured exit codes, git integration, budgets, recovery.
 *
 * Usage: node fo.cjs <command> [args]      (run `node fo.cjs help` for the list)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const yaml = require('./miniyaml.cjs');
const V = require('./validate.cjs');
const sched = require('./dependency_scheduler.cjs');
const routing = require('./routing.cjs');
const gitops = require('./gitops.cjs');
const sm = require('./state_manager.cjs');
const { readConfig, deepMerge } = require('./config.cjs');

const { OrchError, nowIso } = sm;
const SKILL_DIR = path.resolve(__dirname, '..');
const RUNTIME = path.join('.claude', 'fable-orchestrator');
// Drafts the orchestrator writes with its file tools. Claude Code treats .claude/ as a
// sensitive path and refuses model writes there, which helps prevent accidental edits to run state.
const INBOX = '.fable-inbox';
const INBOX_FILES = ['contracts.yaml', 'report.yaml', 'review.yaml', 'correction.yaml', 'request.txt'];
const BOOL_FLAGS = new Set(['json', 'verify', 'integrate', 'reverify', 'user-authorized', 'all', 'plan-only', 'resume', 'status', 'help', 'stdin', 'force']);
const MULTI_FLAGS = new Set(['cmd']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (sha) => (sha ? String(sha).slice(0, 10) : '');
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 3)}...` : String(s));

// ------------------------------------------------------------ arguments

function parseCli(argv) {
  const out = { _: [], flags: {}, rest: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.rest = argv.slice(i + 1); break; }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      let val;
      if (eq > 0) val = a.slice(eq + 1);
      else if (BOOL_FLAGS.has(key)) val = true;
      else {
        if (i + 1 >= argv.length) throw new OrchError('BAD_ARGUMENTS', `--${key} needs a value`, 1);
        val = argv[++i];
      }
      if (MULTI_FLAGS.has(key)) (out.flags[key] = out.flags[key] || []).push(val);
      else out.flags[key] = val;
    } else {
      out._.push(a);
    }
  }
  return out;
}

const INT_OPTS = { 'max-workers': ['max_workers', 1, 20], 'review-rounds': ['review_rounds', 0, 10], 'max-retries': ['max_retries', 0, 10] };

/** Parse the text typed after /fable-orchestrator: options anywhere, everything else is the request. */
function parseInvocation(raw) {
  const out = { mode: null, max_workers: null, review_rounds: null, max_retries: null, plan_only: false, resume: false, status: false, request: '', errors: [], warnings: [] };
  let text = String(raw || '').replace(/^﻿/, '');
  text = text.replace(/(^|\s)--mode(?:=|[ \t]+)(\S+)/g, (m, pre, v) => {
    const mode = v.toLowerCase();
    if (Object.hasOwn(routing.MODES, mode)) out.mode = mode;
    else out.errors.push(`--mode ${v}: expected fast, balanced, thorough or maximum`);
    return pre;
  });
  for (const [flag, [key, lo, hi]] of Object.entries(INT_OPTS)) {
    text = text.replace(new RegExp(`(^|\\s)--${flag}(?:=|[ \\t]+)(\\S+)`, 'g'), (m, pre, v) => {
      const n = Number(v);
      if (Number.isInteger(n) && n >= lo && n <= hi) out[key] = n;
      else out.errors.push(`--${flag} ${v}: expected an integer from ${lo} to ${hi}`);
      return pre;
    });
  }
  for (const [flag, key] of [['plan-only', 'plan_only'], ['resume', 'resume'], ['status', 'status']]) {
    text = text.replace(new RegExp(`(^|\\s)--${flag}(?=\\s|$)`, 'g'), (m, pre) => { out[key] = true; return pre; });
  }
  for (const m of text.matchAll(/(?:^|\s)--(mode|max-workers|review-rounds|max-retries)(?=\s|$)/g)) out.errors.push(`--${m[1]} needs a value`);
  // Only option-looking words that lead the text are suspicious; "--test" inside a sentence is prose.
  for (const word of text.trim().split(/\s+/)) {
    if (!/^--[a-z][\w-]*$/.test(word)) break;
    if (!/^--(mode|max-workers|review-rounds|max-retries)$/.test(word)) out.warnings.push(`unrecognized option ${word} was left in the request text`);
  }
  out.request = text.trim();
  return out;
}

// --------------------------------------------------------------- context

function findRoot(explicit) {
  const start = path.resolve(explicit || process.cwd());
  if (!gitops.available()) return start;
  // From inside a worktree this still resolves to the main checkout.
  const r = gitops.git(start, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.code === 0 && r.out && path.basename(r.out) === '.git') return path.resolve(path.dirname(r.out));
  return gitops.toplevel(start) || start;
}

function ctx(args) {
  const root = findRoot(args.flags.project);
  const rt = path.join(root, RUNTIME);
  let runId = args.flags.run;
  if (!runId) { try { runId = fs.readFileSync(path.join(rt, 'current'), 'utf8').trim(); } catch (e) { /* none */ } }
  if (!runId) throw new OrchError('NO_RUN', `no orchestration run in ${root}; start one with /fable-orchestrator <request>`, 1);
  if (typeof runId !== 'string' || !/^\d{8}-\d{6}-[a-f0-9]{4}$/.test(runId)) {
    throw new OrchError('BAD_RUN_ID', 'expected a run ID in YYYYMMDD-HHMMSS-xxxx format', 1);
  }
  const runDir = path.join(rt, 'runs', runId);
  if (!fs.existsSync(runDir)) throw new OrchError('NO_RUN', `run ${runId} not found in ${rt}`, 1);
  return { root, rt, runId, runDir, store: new sm.Store(runDir) };
}

function loadConfig(root) {
  try {
    return readConfig(path.join(SKILL_DIR, 'config.default.yaml'), path.join(root, RUNTIME, 'config.yaml'));
  } catch (error) {
    throw new OrchError('BAD_CONFIG', error.message, 1);
  }
}

function ensureRuntime(rt) {
  fs.mkdirSync(rt, { recursive: true });
  const gi = path.join(rt, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# fable-orchestrator runtime state - never commit\n*\n');
}

/** A fresh, git-ignored inbox for each run: drafts from an earlier run must never be planned into this one. */
function resetInbox(root) {
  const dir = path.join(root, INBOX);
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# fable-orchestrator drafts - never commit\n*\n');
  for (const f of INBOX_FILES) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* not there */ }
  }
  return dir;
}

function newRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

function normalizeFsPath(p) {
  if (!p) return '';
  let s = String(p).trim().replace(/^["']|["']$/g, '');
  if (process.platform === 'win32') {
    const m = /^\/([a-zA-Z])\/(.*)$/.exec(s); // Git Bash style /c/Users/...
    if (m) s = `${m[1].toUpperCase()}:/${m[2]}`;
  }
  return path.resolve(s);
}

function need(args, i, what) {
  const v = args._[i];
  if (!v) throw new OrchError('BAD_ARGUMENTS', `missing ${what}`, 1);
  return v;
}

function needFlag(args, name) {
  const v = args.flags[name];
  if (v === undefined || v === true || String(v).trim() === '') throw new OrchError('BAD_ARGUMENTS', `--${name} is required`, 1);
  return String(v);
}

/**
 * Text supplied by the orchestrator: --file <path> or --stdin.
 * Standard input is the preferred route: it needs no file write, and file edits
 * under .claude/ are a protected path in Claude Code.
 */
function readInput(args, what) {
  if (args.flags.file !== undefined && args.flags.file !== true) return fs.readFileSync(path.resolve(String(args.flags.file)), 'utf8');
  if (args.flags.stdin) {
    const s = fs.readFileSync(0, 'utf8');
    if (!s.trim()) throw new OrchError('BAD_ARGUMENTS', `--stdin was given but no ${what} arrived on standard input`, 1);
    return s;
  }
  throw new OrchError('BAD_ARGUMENTS', `${what} required: --stdin (pipe or heredoc) or --file <path>`, 1);
}

/** Flags to pass on when one command chains into the next. */
const chained = (args) => {
  const flags = Object.assign({}, args.flags);
  delete flags.file;
  delete flags.stdin;
  delete flags.cmd;
  return flags;
};

function agentStatus(root) {
  const dirs = [path.join(root, '.claude', 'agents'), path.join(os.homedir(), '.claude', 'agents')];
  const missing = [];
  for (const role of V.ROLES.filter((r) => r !== 'orchestrator')) {
    if (!dirs.some((d) => fs.existsSync(path.join(d, `fable-orchestrator-${role}.md`)))) missing.push(role);
  }
  return missing;
}

function loadStats(rt) {
  try { return JSON.parse(fs.readFileSync(path.join(rt, 'learning', 'routing-stats.json'), 'utf8')); } catch (e) { return {}; }
}

function observe(c, entry) {
  try {
    const dir = path.join(c.rt, 'learning');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'observations.jsonl'), JSON.stringify(Object.assign({ at: nowIso(), run: c.runId }, entry)) + '\n');
  } catch (e) { /* learning is best effort */ }
}

function recordOutcome(c, state, t, completed) {
  if (!state.config.learning.enabled || !t.attempts.length) return;
  try {
    const file = path.join(c.rt, 'learning', 'routing-stats.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stats = routing.recordOutcome(loadStats(c.rt), {
      tier: t.attempts[0].route.tier, band: routing.bandOf(t.contract.complexity_score),
      dispatches: t.attempts.length, corrections: t.review_round, escalations: t.escalations.length, completed,
    });
    sm.writeAtomic(file, JSON.stringify(stats, null, 1));
  } catch (e) { /* learning is best effort */ }
}

// ------------------------------------------------------------------ init

function cmdInit(args) {
  let raw = args._.join(' ');
  if (args.flags['request-file']) raw = fs.readFileSync(path.resolve(String(args.flags['request-file'])), 'utf8');
  else if (args.flags.stdin) raw = fs.readFileSync(0, 'utf8');
  const inv = parseInvocation(raw);
  // options given to fo itself win over options found in the request text
  if (args.flags.mode) {
    const m = String(args.flags.mode).toLowerCase();
    if (routing.MODES[m]) inv.mode = m; else inv.errors.push(`--mode ${args.flags.mode}: expected fast, balanced, thorough or maximum`);
  }
  for (const [flag, [key, lo, hi]] of Object.entries(INT_OPTS)) {
    if (args.flags[flag] === undefined) continue;
    const n = Number(args.flags[flag]);
    if (Number.isInteger(n) && n >= lo && n <= hi) inv[key] = n; else inv.errors.push(`--${flag} ${args.flags[flag]}: expected an integer from ${lo} to ${hi}`);
  }
  if (args.flags['plan-only']) inv.plan_only = true;
  if (args.flags.resume) inv.resume = true;
  if (args.flags.status) inv.status = true;
  if (inv.errors.length) throw new OrchError('BAD_ARGUMENTS', inv.errors.join('; '), 2);
  if (inv.status) return cmdStatus(args);
  if (inv.resume) return cmdResume(args);
  if (!inv.request) throw new OrchError('NO_REQUEST', 'no request text. Usage: /fable-orchestrator [--mode fast|balanced|thorough|maximum] [--max-workers N] [--review-rounds N] [--plan-only] <what you want done>   |   --resume   |   --status', 2);

  const root = findRoot(args.flags.project);
  const rt = path.join(root, RUNTIME);
  const cfg = loadConfig(root);
  const options = {
    mode: inv.mode || cfg.execution.mode,
    max_workers: inv.max_workers ?? cfg.execution.max_workers,
    max_review_rounds: inv.review_rounds ?? cfg.execution.max_review_rounds,
    max_task_retries: inv.max_retries ?? cfg.execution.max_task_retries,
    plan_only: inv.plan_only,
  };
  const warnings = inv.warnings.slice();
  const g = gitops.available() ? gitops.inspect(root) : { enabled: false, reason: 'git is not installed' };
  let strategy = cfg.isolation.strategy;
  if (strategy === 'auto') strategy = g.enabled ? 'native' : 'shared';
  if (!g.enabled && strategy !== 'shared') { warnings.push(`isolation "${strategy}" needs git (${g.reason}); using the shared workspace`); strategy = 'shared'; }
  if (strategy === 'shared') warnings.push(`shared workspace (${g.enabled ? 'configured' : g.reason}): no worktree isolation; tasks are serialized and integration happens in place`);
  const dirty = g.enabled ? g.dirty.filter((f) => !f.replace(/\\/g, '/').startsWith('.claude/')) : [];
  if (dirty.length && strategy !== 'shared') warnings.push(`uncommitted changes (${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ', ...' : ''}) stay untouched in your checkout and are NOT visible to workers in worktrees`);
  const missing = agentStatus(root);
  if (missing.length) warnings.push(`agent definitions not installed (${missing.join(', ')}): dispatches fall back to general-purpose plus the role file. Install with: node "${path.join(SKILL_DIR, 'scripts', 'install.cjs')}" --project "${root}"`);

  const runId = newRunId();
  const runDir = path.join(rt, 'runs', runId);
  ensureRuntime(rt);
  for (const d of ['tasks', 'reports', 'reviews', 'corrections', 'evidence', 'snapshots']) fs.mkdirSync(path.join(runDir, d), { recursive: true });
  const state = {
    schema: 1, run_id: runId, created_at: nowIso(), updated_at: nowIso(), phase: 'INTAKE',
    request: inv.request, options, config: cfg,
    project: {
      root, isolation: strategy,
      git: g.enabled && strategy !== 'shared' ? { base_sha: g.base_sha, base_branch: g.base_branch, dirty, integration_branch: null, integration_path: null } : null,
    },
    tasks: {}, order: [], decisions: [], delivery: null, seq: 0,
    budget: { agent_calls: 0, tokens_reported: 0, extra_agent_calls: 0 },
  };
  new sm.Store(runDir).create(state);
  fs.writeFileSync(path.join(runDir, 'request.md'), `${inv.request}\n`);
  fs.writeFileSync(path.join(rt, 'current'), `${runId}\n`);
  const inbox = resetInbox(root);

  const L = [`RUN ${runId} created`];
  L.push(`  mode ${options.mode} (${routing.MODES[options.mode].description})`);
  L.push(`  max_workers ${options.max_workers} | correction rounds ${options.max_review_rounds} | task retries ${options.max_task_retries}${options.plan_only ? ' | PLAN-ONLY' : ''}`);
  L.push(`  workspace: ${strategy}${state.project.git ? ` (base ${g.base_branch || 'detached HEAD'} @ ${short(g.base_sha)})` : ''}`);
  L.push(`  run_dir: ${runDir}`);
  L.push(`  contracts: write them all into ${path.join(inbox, 'contracts.yaml')} (YAML documents separated by a line holding only ---), then: fo plan --file "${path.join(inbox, 'contracts.yaml').replace(/\\/g, '/')}"`);
  L.push(`  template: ${path.join(SKILL_DIR, 'templates', 'task-contract.yaml')}`);
  for (const w of warnings) L.push(`WARNING: ${w}`);
  L.push('REQUEST:', ...inv.request.split('\n').map((l) => `  ${l}`));
  L.push('NEXT: inspect the project, write the task contracts, then run `fo plan --file <contracts file>`.');
  console.log(L.join('\n'));
}

// ------------------------------------------------------------------ plan

function readContractFiles(dir, documents) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(ya?ml|json)$/i.test(f)).sort() : [];
  return [...new Set([...files, ...Object.keys(documents)])].map((f) => {
    try {
      const content = Object.hasOwn(documents, f) ? documents[f] : fs.readFileSync(path.join(dir, f), 'utf8');
      const res = V.validateContract(yaml.parse(content));
      return { file: f, errors: res.errors, warnings: res.warnings, contract: res.contract };
    } catch (e) {
      return { file: f, errors: [e.message], warnings: [], contract: null };
    }
  });
}

function planInto(state, c, submitted) {
  const documents = { ...state.plan_documents, ...submitted };
  const found = readContractFiles(path.join(c.runDir, 'tasks'), documents);
  if (!found.length) throw new OrchError('NO_CONTRACTS', `no task contracts yet: write them to ${path.join(c.root, INBOX, 'contracts.yaml')} and run fo plan --file <that file>`);
  const errors = [];
  const warnings = [];
  const incoming = new Map();
  for (const f of found) {
    f.errors.forEach((e) => errors.push(`${f.file}: ${e}`));
    f.warnings.forEach((w) => warnings.push(`${f.file}: ${w}`));
    if (f.errors.length || !f.contract) continue;
    if (incoming.has(f.contract.task_id)) errors.push(`${f.file}: duplicate task_id ${f.contract.task_id}`);
    else incoming.set(f.contract.task_id, f.contract);
  }
  const started = (t) => t.attempts.length > 0 || !['PENDING', 'READY', 'BLOCKED'].includes(t.state);
  const union = new Map();
  for (const id of state.order) if (started(state.tasks[id])) union.set(id, state.tasks[id].contract);
  for (const [id, contract] of incoming) {
    const ex = state.tasks[id];
    if (ex && started(ex)) {
      if (JSON.stringify(ex.contract) !== JSON.stringify(contract)) warnings.push(`${id} is already under way: contract file changes are ignored (use \`fo amend ${id}\`)`);
    } else {
      union.set(id, contract);
    }
  }
  errors.push(...sched.validateGraph([...union].map(([id, k]) => ({ id, deps: k.dependencies }))).errors);
  if (errors.length) {
    throw new OrchError('PLAN_INVALID', ['the plan was not accepted:'].concat(errors.map((e) => `  - ${e}`), warnings.map((w) => `  (warning) ${w}`)).join('\n'));
  }

  const stats = state.config.learning.enabled ? loadStats(c.rt) : null;
  for (const [id, contract] of incoming) {
    const ex = state.tasks[id];
    if (ex && started(ex)) continue;
    const route = routing.route(contract, state.config, state.options.mode, stats);
    if (!ex) {
      state.tasks[id] = sm.newTask(contract, route);
      state.order.push(id);
      sm.emit(state, { type: 'task_added', task: id });
    } else {
      ex.contract = contract;
      ex.route = route;
      if (ex.state === 'READY') sm.transition(state, id, 'PENDING', { replan: true, reason: 'plan revised' });
    }
  }
  for (const id of state.order.slice()) {
    if (!incoming.has(id) && !started(state.tasks[id])) {
      delete state.tasks[id];
      state.order = state.order.filter((x) => x !== id);
      sm.emit(state, { type: 'task_removed', task: id });
    }
  }
  const graph = state.order.map((id) => ({ id, deps: state.tasks[id].contract.dependencies }));
  const lv = sched.levels(graph);
  state.order = lv.flat();
  if (state.phase === 'INTAKE') state.phase = 'PLANNED';
  sm.refresh(state);

  // advisory warnings
  const ancestors = new Map();
  const anc = (id) => {
    if (ancestors.has(id)) return ancestors.get(id);
    const set = new Set();
    ancestors.set(id, set);
    for (const d of state.tasks[id].contract.dependencies) { set.add(d); for (const x of anc(d)) set.add(x); }
    return set;
  };
  for (let i = 0; i < state.order.length; i++) {
    for (let j = i + 1; j < state.order.length; j++) {
      const a = state.tasks[state.order[i]];
      const b = state.tasks[state.order[j]];
      if (anc(a.id).has(b.id) || anc(b.id).has(a.id)) continue;
      if (sched.scopesConflict(a.contract.file_scope, b.contract.file_scope)) warnings.push(`${a.id} and ${b.id} share file scope and have no dependency: they will run one after the other`);
    }
  }
  const g = state.project.git;
  if (g && g.dirty.length) {
    for (const id of state.order) {
      const hit = g.dirty.filter((f) => state.tasks[id].contract.file_scope.some((p) => sched.matchPath(p, f)));
      if (hit.length) warnings.push(`${id}: your uncommitted changes to ${hit.join(', ')} are inside its file scope and are not visible to its worker; commit them first or confirm with the user`);
    }
  }

  const L = [`PLAN for run ${state.run_id} - ${state.order.length} task(s), mode ${state.options.mode}`];
  lv.forEach((ids, i) => L.push(`  level ${i}: ${ids.join(', ')}${ids.length > 1 ? '   (parallel candidates)' : ''}`));
  L.push('');
  const rows = [['task', 'cx', 'risk', 'tier', 'role', 'model', 'review', 'depends on', 'title']];
  for (const id of state.order) {
    const t = state.tasks[id];
    const rv = t.route.review.independent ? `orchestrator + ${t.route.review.independent} independent` : 'orchestrator';
    rows.push([id, String(t.contract.complexity_score), t.contract.risk_level, t.route.tier, t.route.role, t.route.model + (t.route.effort ? `/${t.route.effort}` : ''), rv, t.contract.dependencies.join(',') || '-', clip(t.contract.title, 48)]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) L.push('  ' + r.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd());
  const notes = state.order.flatMap((id) => state.tasks[id].route.notes.map((n) => `${id}: ${n}`));
  if (notes.length) L.push('', 'ROUTING NOTES (basis: transparent heuristics; observed data only where stated):', ...notes.map((n) => `  - ${n}`));
  if (warnings.length) L.push('', 'WARNINGS:', ...warnings.map((w) => `  - ${w}`));
  const text = L.join('\n');
  state.plan_documents = documents;
  state.plan_summary = text;
  return `${text}\n\n${state.options.plan_only
    ? 'PLAN-ONLY: present this plan to the user and stop. Nothing is dispatched until they run /fable-orchestrator --resume.'
    : 'NEXT: `fo next` returns the first batch to dispatch.'}`;
}

/** Parse submitted drafts without writing until the entire graph is accepted. */
function parseContracts(text, where) {
  const docs = text.split(/^---[ \t]*$/m).map((d) => d.trim()).filter(Boolean);
  if (!docs.length) throw new OrchError('BAD_ARGUMENTS', `no contracts found in ${where}`, 1);
  const out = [];
  docs.forEach((doc, i) => {
    let parsed;
    try { parsed = yaml.parse(doc); } catch (e) { throw new OrchError('PLAN_INVALID', `contract ${i + 1} in ${where}: ${e.message}`); }
    const id = isObj(parsed) ? String(parsed.task_id || '').trim() : '';
    if (!V.TASK_ID.test(id)) throw new OrchError('PLAN_INVALID', `contract ${i + 1} in ${where}: task_id "${id}" must look like AUTH-001`);
    if (out.some((o) => o.id === id)) throw new OrchError('PLAN_INVALID', `contract ${i + 1} in ${where}: duplicate task_id ${id}`);
    out.push({ id, doc });
  });
  return Object.fromEntries(out.map((o) => [`${o.id}.yaml`, o.doc]));
}

function cmdPlan(args) {
  const c = ctx(args);
  let submitted = {};
  if (args.flags.file !== undefined && args.flags.file !== true) {
    const file = path.resolve(String(args.flags.file));
    submitted = parseContracts(fs.readFileSync(file, 'utf8'), file);
  } else if (args.flags.stdin) {
    submitted = parseContracts(fs.readFileSync(0, 'utf8'), 'standard input');
  }
  console.log(c.store.transact((state) => planInto(state, c, submitted)));
}

// -------------------------------------------------------------- dispatch

function ensureIntegration(state, c) {
  const g = state.project.git;
  if (!g) return;
  const root = state.project.root;
  if (g.integration_branch) {
    if (!gitops.isWorktree(g.integration_path) || !sameRepo(root, g.integration_path) ||
        gitops.currentBranch(g.integration_path) !== g.integration_branch) {
      throw new OrchError('INTEGRATION_OWNERSHIP', 'integration worktree is absent or has changed identity; reconcile it before continuing');
    }
    return;
  }
  const head = gitops.revParse(root, 'HEAD');
  if (head !== g.base_sha || gitops.currentBranch(root) !== g.base_branch) {
    throw new OrchError('BASE_CHANGED', 'the project branch moved since planning; start a new run on the current base');
  }
  const branch = `fable/${state.run_id}/integration`;
  const dir = path.join(c.runDir, 'integration');
  gitops.worktreeAdd(root, dir, { branch, start: head });
  g.base_sha = head;
  g.integration_branch = branch;
  g.integration_path = dir;
  sm.emit(state, { type: 'integration_created', branch, base: head });
}

function newAttempt(state, c, t) {
  const g = state.project.git;
  const root = state.project.root;
  const reader = V.READER_ROLES.includes(t.route.role);
  const direct = t.route.role === 'orchestrator';
  const n = t.attempts.length + 1;
  const a = {
    n, attempt_id: crypto.randomUUID(), dispatched_at: nowIso(),
    route: { tier: t.route.tier, role: t.route.role, model: t.route.model, effort: t.route.effort },
    isolation: reader ? 'none' : state.project.isolation,
    start_refs: [], base: null, workdir: null, read_path: null, snapshot: null,
    report: null, commit: null, branch: null, worktree_path: null, changed_files: null, out_of_scope: [],
    outcome: null, tokens: null, agent_id: null,
  };
  if (reader) {
    a.read_path = g && g.integration_path ? g.integration_path : root;
    if (g) a.base = gitops.revParse(root, g.integration_branch);
  } else if (g) {
    const tip = gitops.revParse(root, g.integration_branch);
    const prev = [...t.attempts].reverse().find((p) => p.commit);
    a.base = tip;
    a.repository = gitops.repository(root);
    if (prev) a.start_refs.push(prev.commit);
    a.start_refs.push(tip);
    if (state.project.isolation === 'managed' || direct) {
      a.isolation = 'managed';
      a.branch = `fable/${state.run_id}/${t.id}-a${n}`;
      a.workdir = path.join(c.runDir, 'wt', `${t.id}-a${n}`);
      gitops.worktreeAdd(root, a.workdir, { branch: a.branch, start: a.start_refs[0] });
      a.worktree_path = a.workdir;
      a.ownership = 'managed';
    } else {
      a.preexisting_worktrees = gitops.registeredWorktrees(root);
    }
  } else {
    const snap = gitops.fsSnapshot(root);
    a.snapshot = path.join(c.runDir, 'snapshots', `${t.id}-a${n}.fs.json`);
    fs.writeFileSync(a.snapshot, JSON.stringify(snap));
  }
  t.attempts.push(a);
  return a;
}

function buildPackage(state, t, a) {
  const k = t.contract;
  const reader = V.READER_ROLES.includes(a.route.role);
  const L = [];
  L.push(`# Task ${t.id}: ${k.title}`);
  L.push(`Run ${state.run_id} | dispatch ${a.n} | role ${a.route.role} | priority ${k.priority} | risk ${k.risk_level}`);
  L.push('', '## Objective', k.objective);
  L.push('', '## Acceptance criteria (every one must hold)');
  k.acceptance_criteria.forEach((x, i) => L.push(`${i + 1}. ${x}`));
  if (!reader) {
    L.push('', '## Authorized file scope (create or modify nothing outside it)');
    k.file_scope.forEach((p) => L.push(`- ${p}`));
  }
  if (k.inputs.length) L.push('', '## Inputs', ...k.inputs.map((x) => `- ${x}`));
  if (k.outputs.length) L.push('', '## Expected outputs', ...k.outputs.map((x) => `- ${x}`));
  if (k.dependencies.length) {
    L.push('', '## Completed dependencies (already integrated into your starting point)');
    for (const d of k.dependencies) {
      const dep = state.tasks[d];
      const rep = dep && sm.lastAttempt(dep) && sm.lastAttempt(dep).report;
      L.push(`- ${d}: ${dep ? dep.contract.title : ''}${rep ? ` - ${clip(rep.summary, 240)}` : ''}`);
    }
  }
  if (k.context) L.push('', '## Context', k.context);
  const decisions = (state.decisions || []).slice(-6);
  if (decisions.length) L.push('', '## Decisions already made (do not reopen)', ...decisions.map((d) => `- ${d.text}`));

  L.push('', '## Verification to run before you report');
  k.verification.forEach((x) => L.push(`- ${x}`));
  if (k.verification_commands.length) {
    L.push('The orchestrator will independently run these afterwards and act on the exit codes:');
    k.verification_commands.forEach((x) => L.push(`- \`${x}\``));
  }

  L.push('', '## Workspace');
  if (reader) {
    L.push(`Read-only task. Inspect the project under: ${a.read_path}`, 'Do not create, modify or delete files.');
  } else if (a.isolation === 'native') {
    L.push('You are in your own git worktree, isolated from other workers.');
    L.push(`1. Before anything else, bring in the work integrated so far:${a.start_refs.map((r) => ` \`git merge --no-edit ${r}\``).join(' then')}. If a merge conflicts on files outside your scope, stop and report status: blocked.`);
    L.push('2. Do the work inside the authorized file scope.');
    L.push(`3. Commit everything on the current branch: \`git add -A && git commit -m "${t.id}: <summary>"\`.`);
    L.push('4. Never push, never switch or delete branches, never touch another worktree or the main checkout.');
  } else if (a.isolation === 'managed') {
    L.push(`Your workspace is the dedicated git worktree at: ${a.workdir}  (branch ${a.branch})`);
    L.push('Work only there: use absolute paths under it for every file operation and prefix commands with `cd "<that path>" &&`.');
    const extra = a.start_refs.slice(1);
    if (extra.length) L.push(`1. First bring in the latest integrated work:${extra.map((r) => ` \`git merge --no-edit ${r}\``).join(' then')}.`);
    L.push(`${extra.length ? '2' : '1'}. Do the work inside the authorized file scope, then commit on that branch: \`git add -A && git commit -m "${t.id}: <summary>"\`.`);
    L.push('Never push, never switch branches, never modify anything outside that worktree.');
  } else {
    L.push(`You are working directly in the shared project directory ${state.project.root}, possibly alongside other workers.`);
    L.push('Modify only files in your scope. Do not run git commands that change state (no commit, checkout, stash, reset).');
  }

  const corr = t.corrections[t.corrections.length - 1];
  if (corr && corr.round === t.review_round && a.n > 1) {
    L.push('', `## Correction request (round ${corr.round}) - fix exactly this, do not rewrite what already works`);
    L.push(`- Failure: ${corr.failure}`, `- Evidence: ${corr.evidence}`, `- Expected behaviour: ${corr.expected_behavior}`, `- Required change: ${corr.required_change}`);
    L.push(`- Re-verify with: ${corr.verification.join('; ')}`);
    if (corr.scope.length) L.push(`- Limit your changes to: ${corr.scope.join(', ')}`);
    if (corr.strategy_change) L.push(`- Change of approach: ${corr.strategy_change.detail}`);
  } else if (a.n > 1) {
    const f = t.failures[t.failures.length - 1];
    if (f) L.push('', '## Previous dispatch did not finish', `- ${f.kind}: ${f.reason}`);
  }

  L.push('', '## Completion report');
  L.push('End your final message with ONE fenced yaml block in exactly this shape. Every value must be what you actually observed. Never report a test as passed unless you ran it and saw it pass. If you cannot finish, say so with status blocked or failed and a reason.');
  L.push('```yaml', `task_id: ${t.id}`, 'status: implemented        # implemented | blocked | failed | needs_decomposition', 'summary: <one or two sentences on what now exists>');
  if (reader) {
    L.push('findings:', '  - <finding with its evidence: file:line, command output, or source>');
    L.push('verification:', '  tests_run: false', '  tests_passed: null', '  build_passed: null');
  } else {
    L.push('files_changed:', '  - <path relative to the repository root>');
    L.push('verification:', '  tests_run: true', '  tests_passed: true', '  build_passed: null      # true | false | null when not applicable', '  commands:', '    - cmd: <command you ran>', '      exit_code: 0');
  }
  L.push(`attempt_id: ${a.attempt_id}`, 'known_issues: []');
  if (!reader && a.isolation !== 'shared') L.push('commit: <output of git rev-parse HEAD>', 'branch: <output of git branch --show-current>', 'worktree_path: <output of git rev-parse --show-toplevel>');
  L.push('reason: <only when status is blocked or failed>', '```');
  return L.join('\n');
}

function cmdNext(args) {
  const c = ctx(args);
  const res = c.store.transact((state) => {
    if (!state.order.length) throw new OrchError('NO_PLAN', 'no accepted plan yet: write contracts and run `fo plan`');
    if (state.options.plan_only) throw new OrchError('PLAN_ONLY', 'this run is plan-only: present the plan and stop. Execution starts when the user runs /fable-orchestrator --resume', 3);
    sm.refresh(state);
    const budget = sm.budgetStatus(state);
    const cap = Math.min(state.options.max_workers, routing.MODES[state.options.mode].parallel_cap);
    let picked = { selected: [], deferred: [] };
    if (!budget.exceeded) {
      picked = sched.selectBatch(sm.schedulerViews(state), { maxWorkers: cap, maxNew: budget.remaining_calls });
      if (!state.project.git) {
        const held = Object.values(state.tasks).find((t) => sm.HOLD_STATES.includes(t.state));
        const allowed = held ? 0 : 1;
        for (const id of picked.selected.splice(allowed)) picked.deferred.push({ id, reason: 'shared workspace requires one active task at a time' });
      }
      if (picked.selected.length) ensureIntegration(state, c);
    }
    const specs = [];
    for (const id of picked.selected) {
      const t = state.tasks[id];
      if (t.contract.side_effects === 'external') {
        picked.deferred.push({ id, reason: 'external action requires a host-authorized execution path; this CLI cannot authenticate approval' });
        continue;
      }
      const a = newAttempt(state, c, t);
      sm.transition(state, id, 'DISPATCHED', { reason: `dispatch ${a.n} to ${a.route.role} on ${a.route.model}` });
      const direct = a.route.role === 'orchestrator';
      if (!direct) state.budget.agent_calls++;
      specs.push({
        task_id: id, attempt: a.n, attempt_id: a.attempt_id, direct, workdir: a.workdir,
        agent: direct ? null : {
          subagent_type: `fable-orchestrator-${a.route.role}`, model: a.route.model, effort: a.route.effort,
          isolation: a.isolation === 'native' ? 'worktree' : null,
          description: clip(`${id} ${t.contract.title}`, 60),
          fallback_role_file: path.join(SKILL_DIR, 'agents', `${a.route.role}.md`),
        },
        prompt: buildPackage(state, t, a),
      });
    }
    if (specs.length) state.phase = 'EXECUTING';
    return { specs, deferred: picked.deferred, budget: sm.budgetStatus(state), summary: sm.summary(state), actions: sm.nextActions(state) };
  });

  if (args.flags.json) { console.log(JSON.stringify(res, null, 1)); return; }
  const L = [];
  if (res.specs.length) {
    const ids = res.specs.map((s) => s.task_id);
    L.push(`DISPATCH ${res.specs.length} task(s). Issue every Agent call below in ONE message, together with: fo started ${ids.join(' ')}`);
    for (const s of res.specs) {
      L.push('', `=== ${s.task_id} (dispatch ${s.attempt}) ===`);
      if (s.direct) {
        L.push(`DIRECT: implement this task yourself${s.workdir ? ` in ${s.workdir}` : ''}, then save a completion report and run fo report as for any worker.`);
      } else {
        const g = s.agent;
        L.push(`Agent tool call (the tool is named Agent, or Task in some versions): subagent_type=${g.subagent_type} | model=${g.model} | effort=${g.effort || '(omit)'} | isolation=${g.isolation || '(omit)'} | description="${g.description}"`);
        L.push(`  if that agent type is unavailable: subagent_type=general-purpose and start the prompt with "First read ${g.fallback_role_file} and follow it."`);
      }
      L.push('--- prompt: pass verbatim ---', s.prompt, '--- end prompt ---');
    }
  } else {
    L.push(`NOTHING TO DISPATCH (${res.summary.run_state})`);
  }
  if (res.deferred.length) L.push('', 'WAITING:', ...res.deferred.map((d) => `  - ${d.id}: ${d.reason}`));
  for (const w of res.budget.warnings) L.push(`BUDGET WARNING: ${w}`);
  if (res.budget.exceeded) L.push(`BUDGET LIMIT: ${res.budget.notes[0]}. Stop dispatching and ask the user to authorize more (\`fo authorize --extra-agent-calls N --by user --reason "..."\`).`);
  if (!res.specs.length && res.actions.length) L.push('', 'OPEN ACTIONS:', ...res.actions.map((x) => `  - ${x}`));
  if (!res.specs.length && res.summary.run_state.startsWith('COMPLETE')) L.push('', 'All tasks are finished: run `fo deliver`, then `fo final-report`.');
  console.log(L.join('\n'));
}

function cmdStarted(args) {
  const c = ctx(args);
  if (!args._.length) throw new OrchError('BAD_ARGUMENTS', 'usage: fo started <task-id> [<task-id>...]', 1);
  c.store.transact((state) => {
    for (const id of args._) {
      const t = sm.getTask(state, id);
      if (t.state === 'RUNNING') continue;
      sm.transition(state, id, 'RUNNING', { reason: 'agent call issued' });
      if (args.flags['agent-id']) sm.lastAttempt(t).agent_id = String(args.flags['agent-id']);
    }
  });
  console.log(`RUNNING: ${args._.join(', ')}`);
}

// ---------------------------------------------------------------- report

function sameRepo(root, dir) {
  const a = gitops.repository(root);
  const b = gitops.repository(dir);
  return !!a && !!b && gitops.samePath(a, b);
}

function bindNativeWorktree(state, t, a, args) {
  const root = state.project.root;
  const dir = normalizeFsPath(needFlag(args, 'worktree'));
  const branch = needFlag(args, 'branch');
  const agent = needFlag(args, 'agent-id');
  if (a.isolation !== 'native' || a.ownership) throw new OrchError('WORKTREE_OWNERSHIP', 'this attempt cannot be assigned a native worktree');
  if (a.agent_id && a.agent_id !== agent) throw new OrchError('WORKTREE_OWNERSHIP', 'agent identity does not match the dispatch');
  const excluded = [root, state.project.git.integration_path, ...(a.preexisting_worktrees || [])];
  for (const task of Object.values(state.tasks)) {
    for (const prior of task.attempts) if (prior.worktree_path) excluded.push(prior.worktree_path);
  }
  if (!a.repository || !gitops.isWorktree(dir) || !sameRepo(root, dir) ||
      !gitops.samePath(a.repository, gitops.repository(dir)) ||
      !gitops.registeredWorktrees(root).some((p) => gitops.samePath(p, dir)) ||
      gitops.currentBranch(dir) !== branch || excluded.some((p) => p && gitops.samePath(p, dir))) {
    throw new OrchError('WORKTREE_OWNERSHIP', `${t.id}: host worktree metadata does not identify a new, unassigned worktree for this repository`);
  }
  a.worktree_path = fs.realpathSync.native(dir);
  a.branch = branch;
  a.agent_id = agent;
  a.ownership = 'host-recorded';
}

function cmdBindWorktree(args) {
  const c = ctx(args);
  const id = need(args, 0, 'task id');
  const attempt = needFlag(args, 'attempt-id');
  c.store.transact((state) => {
    const t = sm.getTask(state, id);
    const a = sm.lastAttempt(t);
    if (!a || a.attempt_id !== attempt || !['DISPATCHED', 'RUNNING'].includes(t.state)) {
      throw new OrchError('STALE_ATTEMPT', `${id}: no active dispatch matches ${attempt}`);
    }
    bindNativeWorktree(state, t, a, args);
  });
  console.log(`${id}: worktree ownership recorded`);
}

function locateWork(state, t, a, r, errors, warnings) {
  const root = state.project.root;
  const wt = a.worktree_path;
  if (!a.ownership || !wt || !gitops.isWorktree(wt) || !sameRepo(root, wt) ||
      !gitops.samePath(a.repository, gitops.repository(wt)) || gitops.currentBranch(wt) !== a.branch ||
      !r.worktree_path || !gitops.samePath(wt, normalizeFsPath(r.worktree_path)) || r.branch !== a.branch) {
    errors.push('report does not match the assigned worktree and branch; record native ownership from the host notification first');
    return;
  }
  if (gitops.dirtyFiles(wt).length) {
    errors.push('assigned worktree contains uncommitted changes; preserve it and reconcile with the worker');
    return;
  }
  const commit = gitops.revParse(wt, 'HEAD');
  if (!commit || r.commit.toLowerCase() !== commit || !a.start_refs.every((ref) => gitops.isAncestor(root, ref, commit))) {
    errors.push('reported commit does not match the worker HEAD or is missing an assigned base commit');
    return;
  }
  a.commit = commit;
  a.changed_files = gitops.changedFiles(root, a.base, commit);
  if (!a.changed_files.length && r.files_changed.length) warnings.push('the report lists changed files but the commit holds no changes relative to the integration branch');
}

function workerFailure(state, c, t, kind, reason) {
  const a = sm.lastAttempt(t);
  if (a) a.outcome = `failed:${kind}`;
  t.failures.push({ at: nowIso(), kind, reason, attempt: a ? a.n : null });
  const max = state.options.max_task_retries;
  if (['permission', 'missing_tool', 'unsupported_model'].includes(kind)) {
    sm.transition(state, t.id, 'BLOCKED', { kind, reason: `${reason} - retrying unchanged cannot succeed; change permissions, tools or model (\`fo escalate\`) first` });
  } else if (t.contract.side_effects === 'external') {
    sm.transition(state, t.id, 'BLOCKED', { kind: 'retry_unsafe', reason: `${reason} - the task has external side effects; confirm what already happened before re-running` });
  } else if (t.retries < max) {
    t.retries++;
    sm.transition(state, t.id, 'READY', { reason: `retry ${t.retries}/${max} after ${kind}: ${clip(reason, 160)}` });
  } else {
    sm.transition(state, t.id, 'BLOCKED', { kind: 'retries_exhausted', reason: `${kind}: ${reason} - ${max} retries used; escalate with a changed strategy or fail the task` });
  }
  return t.state;
}

function cmdReport(args) {
  const c = ctx(args);
  const id = need(args, 0, 'task id');
  const raw = yaml.parse(yaml.extractYamlBlock(readInput(args, 'the worker completion report')));
  const res = c.store.transact((state) => {
    const t = sm.getTask(state, id);
    if (!['DISPATCHED', 'RUNNING'].includes(t.state)) throw new OrchError('WRONG_STATE', `${id} is ${t.state}; a completion report is accepted only while DISPATCHED or RUNNING`);
    const a = sm.lastAttempt(t);
    if (!a || !a.attempt_id || !isObj(raw) || raw.attempt_id !== a.attempt_id ||
        (args.flags['agent-id'] && args.flags['agent-id'] !== a.agent_id)) {
      throw new OrchError('STALE_ATTEMPT', `${id}: report does not identify the current dispatch`);
    }
    const g = state.project.git;
    const v = V.validateReport(raw, t, { git: !!g && a.isolation !== 'none' });
    const errors = v.errors.slice();
    const warnings = v.warnings.slice();
    const r = v.report;
    if (!errors.length && r.status === 'implemented' && a.isolation !== 'none') {
      if (g) {
        locateWork(state, t, a, r, errors, warnings);
      } else if (a.snapshot) {
        const before = JSON.parse(fs.readFileSync(a.snapshot, 'utf8'));
        const after = gitops.fsSnapshot(state.project.root);
        if (before.truncated || after.truncated) throw new OrchError('INCOMPLETE_SCOPE', 'shared workspace snapshot was incomplete');
        const diff = gitops.snapshotDiff(before.files, after.files);
        const mine = (f) => t.contract.file_scope.some((p) => sched.matchPath(p, f));
        a.changed_files = diff.filter(mine);
        a.out_of_scope = diff.filter((f) => !mine(f));
      }
    }
    if (errors.length) {
      throw new OrchError('INVALID_REPORT', [`${id}: completion report rejected (state unchanged):`].concat(errors.map((e) => `  - ${e}`),
        [`Fix the report and resubmit, or after confirming the worker stopped record: fo worker-failed ${id} --attempt-id ${a.attempt_id} --kind invalid_output --reason "..."`]).join('\n'));
    }
    fs.writeFileSync(path.join(c.runDir, 'reports', `${id}-d${a.n}.yaml`), yaml.dump(r));
    a.report = r;
    a.reconciliation_required = false;
    a.reported_at = nowIso();
    const tokens = Number(args.flags.tokens);
    if (Number.isFinite(tokens) && tokens > 0) { a.tokens = tokens; state.budget.tokens_reported += tokens; }
    if (r.delegations) state.budget.agent_calls += r.delegations;
    if (t.state === 'DISPATCHED') sm.transition(state, id, 'RUNNING', { reason: 'report received' });
    if (r.status === 'implemented') {
      a.outcome = 'implemented';
      sm.transition(state, id, 'IMPLEMENTED', { reason: clip(r.summary, 200) });
    } else if (r.status === 'blocked') {
      a.outcome = 'blocked';
      sm.transition(state, id, 'BLOCKED', { kind: 'worker_blocked', reason: r.reason || r.known_issues.join('; ') });
    } else if (r.status === 'needs_decomposition') {
      a.outcome = 'needs_decomposition';
      sm.transition(state, id, 'BLOCKED', { kind: 'decomposition', reason: r.reason || r.summary });
    } else {
      workerFailure(state, c, t, 'worker_reported_failure', r.reason || r.known_issues.join('; '));
    }
    return { state: t.state, warnings, commit: a.commit, files: a.changed_files };
  });
  const L = [`${id}: report accepted -> ${res.state}${res.commit ? ` (commit ${short(res.commit)}, ${res.files.length} changed file(s))` : ''}`];
  for (const w of res.warnings) L.push(`  note: ${w}`);
  console.log(L.join('\n'));
  if (args.flags.verify && res.state === 'IMPLEMENTED') cmdVerify({ _: [id], flags: chained(args), rest: null });
}

function cmdWorkerFailed(args) {
  const c = ctx(args);
  const id = need(args, 0, 'task id');
  const attempt = needFlag(args, 'attempt-id');
  const kind = needFlag(args, 'kind');
  const reason = needFlag(args, 'reason');
  const kinds = ['crash', 'invalid_output', 'permission', 'rate_limit', 'context', 'missing_tool', 'unsupported_model', 'timeout', 'other'];
  if (!kinds.includes(kind)) throw new OrchError('BAD_ARGUMENTS', `--kind: one of ${kinds.join(', ')}`, 1);
  const st = c.store.transact((state) => {
    const t = sm.getTask(state, id);
    if (!['DISPATCHED', 'RUNNING'].includes(t.state)) throw new OrchError('WRONG_STATE', `${id} is ${t.state}; only a dispatched or running task can fail this way`);
    if (sm.lastAttempt(t).attempt_id !== attempt) throw new OrchError('STALE_ATTEMPT', `${id}: failure does not identify the current dispatch`);
    return workerFailure(state, c, t, kind, reason);
  });
  observe(c, { category: 'worker_failure', task: id, text: `${kind}: ${reason}` });
  console.log(`${id}: worker failure (${kind}) recorded -> ${st}`);
}

// ---------------------------------------------------------------- verify

const tail = (s, lines, chars) => {
  const t = String(s).split(/\r?\n/).slice(-lines).join('\n');
  return t.length > chars ? t.slice(-chars) : t;
};

function runAndRecord(c, id, cycle, tag, cmd, cwd, timeoutMs) {
  const r = gitops.runCommand(cmd, cwd, timeoutMs);
  const rel = path.join('evidence', `${id}-c${cycle}-${tag}.log`);
  const body = [`command: ${cmd}`, `cwd: ${cwd}`, `shell: ${r.shell}`, `exit_code: ${r.timed_out ? 'TIMEOUT' : r.exit_code}`, `duration_ms: ${r.duration_ms}`, `finished_at: ${nowIso()}`,
    r.error ? `error: ${r.error}` : '', '', '----- stdout -----', r.stdout.slice(-200000), '----- stderr -----', r.stderr.slice(-200000)].join('\n');
  fs.writeFileSync(path.join(c.runDir, rel), body);
  const passed = r.exit_code === 0 && !r.timed_out && !r.error;
  return {
    cycle, kind: 'command', name: cmd, cmd, cwd, exit_code: r.exit_code, timed_out: r.timed_out, passed,
    duration_ms: r.duration_ms, evidence: rel.replace(/\\/g, '/'), at: nowIso(),
    output_tail: passed ? '' : tail(`${r.stdout}\n${r.stderr}${r.error ? `\n${r.error}` : ''}`, 40, 2500),
  };
}

function withCandidateCheckout(c, root, commit, use) {
  const dir = fs.mkdtempSync(path.join(c.runDir, 'candidate-'));
  gitops.worktreeAdd(root, dir, { detach: true, start: commit });
  try {
    return use(dir);
  } finally {
    gitops.worktreeRemove(root, dir, false);
  }
}

function runCandidateChecks(c, id, cycle, tag, commands, dir, timeout, candidate, setup) {
  const actual = () => gitops.candidate(dir, 'HEAD');
  const intact = () => {
    const current = actual();
    return current.commit === candidate.commit && current.tree === candidate.tree && !gitops.dirtyFiles(dir).length;
  };
  const results = [];
  if (intact()) {
    const checks = [setup, ...commands].filter(Boolean);
    for (const [i, cmd] of checks.entries()) {
      const result = { ...runAndRecord(c, id, cycle, `${tag}${i + 1}`, cmd, dir, timeout), candidate };
      results.push(result);
      if (!intact() || i === 0 && setup && !result.passed) break;
    }
  }
  const passed = intact();
  results.push({ cycle, kind: 'candidate', name: 'candidate integrity', passed, at: nowIso(), candidate,
    detail: passed ? `${candidate.commit} tree ${candidate.tree}` : 'candidate checkout or HEAD changed during verification' });
  return results;
}

function extraCommands(args) {
  const extra = [].concat(args.flags.cmd || []);
  if (args.rest && args.rest.length) extra.push(args.rest.map((x) => (/[\s"']/.test(x) ? JSON.stringify(x) : x)).join(' '));
  for (const cmd of extra) {
    const why = V.dangerousCommand(cmd);
    if (why) throw new OrchError('COMMAND_REFUSED', `"${cmd}" refused (${why}); such operations need explicit user authorization and are never run as verification`, 3);
  }
  return extra;
}

function cmdVerify(args) {
  const c = ctx(args);
  const id = need(args, 0, 'task id');
  const extra = extraCommands(args);
  const plan = c.store.transact((state) => {
    const t = sm.getTask(state, id);
    if (t.state === 'IMPLEMENTED') {
      t.verify_cycle++;
      sm.transition(state, id, 'VERIFYING', { reason: `verification cycle ${t.verify_cycle}` });
    } else if (t.state === 'CORRECTION_REQUIRED' && args.flags.reverify) {
      const reason = needFlag(args, 'reason');
      t.review_round++; // re-verifying without a new attempt still consumes a correction round
      t.verify_cycle++;
      sm.transition(state, id, 'VERIFYING', { reason: `re-verification: ${reason}` });
    } else if (t.state === 'VERIFYING') {
      t.checks = t.checks.filter((x) => x.cycle !== t.verify_cycle || x.kind === 'manual');
    } else {
      throw new OrchError('WRONG_STATE', `${id} is ${t.state}; verification starts from IMPLEMENTED`);
    }
    const a = sm.lastAttempt(t);
    if (t.verification_operation) throw new OrchError('VERIFICATION_IN_PROGRESS', `${id}: a previous verifier may still be active`);
    t.verification_operation = { id: crypto.randomUUID(), pid: process.pid };
    const candidate = state.project.git ? gitops.candidate(state.project.root, a.commit || a.base) : null;
    return {
      cmds: t.contract.verification_commands.concat(extra), cwd: state.project.root, cycle: t.verify_cycle,
      setup: state.config.integration.setup_command, operation: t.verification_operation.id, candidate,
      timeout: state.config.verification.command_timeout_seconds * 1000,
    };
  });

  const results = plan.candidate
    ? withCandidateCheckout(c, plan.cwd, plan.candidate.commit, (dir) => runCandidateChecks(c, id, plan.cycle, 'v', plan.cmds, dir, plan.timeout, plan.candidate, plan.setup))
    : plan.cmds.map((cmd, i) => runAndRecord(c, id, plan.cycle, `v${i + 1}`, cmd, plan.cwd, plan.timeout));

  const out = c.store.transact((state) => {
    const t = sm.getTask(state, id);
    if (t.state !== 'VERIFYING' || t.verify_cycle !== plan.cycle || t.verification_operation?.id !== plan.operation) {
      throw new OrchError('STATE_CHANGED', `${id} changed state while verification ran; reconcile before retrying`);
    }
    delete t.verification_operation;
    const a = sm.lastAttempt(t);
    t.checks.push(...results);
    if (a && a.isolation !== 'none' && a.changed_files) {
      const outside = a.changed_files.filter((f) => !t.contract.file_scope.some((p) => sched.matchPath(p, f))).concat(a.out_of_scope || []);
      t.checks.push({
        cycle: plan.cycle, kind: 'scope', name: 'file scope', passed: outside.length === 0, at: nowIso(),
        detail: outside.length ? `modified outside the authorized scope: ${outside.join(', ')}` : `${a.changed_files.length} changed file(s), all inside the authorized scope`,
      });
    }
    const cur = sm.currentChecks(t);
    const failed = cur.filter((x) => !x.passed);
    if (!failed.length && !cur.some((x) => x.kind === 'manual' || x.kind === 'command' && plan.cmds.includes(x.cmd))) {
      return { noEvidence: true };
    }
    if (failed.length) {
      const claimed = a && a.report && a.report.verification && a.report.verification.tests_passed === true;
      if (claimed && failed.some((f) => f.kind === 'command')) observe(c, { category: 'claim_mismatch', task: id, text: 'worker reported passing tests; independent verification failed' });
      if (failed.some((f) => f.kind === 'scope')) observe(c, { category: 'scope_violation', task: id, text: failed.find((f) => f.kind === 'scope').detail });
      sm.transition(state, id, 'CORRECTION_REQUIRED', { reason: `verification failed: ${failed.map((f) => clip(f.name, 80)).join(', ')}` });
    } else {
      t.verified_candidate = plan.candidate;
      t.verified_commands = plan.cmds;
      sm.transition(state, id, 'REVIEWING', { reason: `${cur.length} check(s) passed` });
    }
    return { state: t.state, checks: cur, gate: sm.reviewGate(t), left: sm.maxRounds(state, t) - t.review_round, independent: t.route.review.independent };
  });
  if (out.noEvidence) throw new OrchError('NO_VERIFICATION_EVIDENCE', `${id}: record a manual check or add verification commands before review`);

  const L = [`${id}: verification cycle ${plan.cycle} in ${plan.cwd}`];
  for (const k of out.checks) {
    L.push(`  ${k.passed ? 'PASS' : 'FAIL'} [${k.kind}] ${k.name}${k.kind === 'command' ? ` (exit ${k.timed_out ? 'TIMEOUT' : k.exit_code}, ${k.evidence})` : ` - ${k.detail}`}`);
    if (!k.passed && k.output_tail) L.push(...k.output_tail.split('\n').map((l) => `      | ${l}`));
  }
  if (out.state === 'REVIEWING') {
    L.push(`-> REVIEWING. Review the diff and the evidence against every acceptance criterion, then: fo review ${id} --integrate --stdin`);
    if (out.independent) L.push(`   ${out.independent} independent review(s) required first: fo review-package ${id}`);
  } else {
    L.push(`-> CORRECTION_REQUIRED. ${out.left > 0 ? `Write a targeted correction request, then: fo correct ${id} --stdin  (${out.left} round(s) left)` : 'Correction limit reached: escalate to the user.'}`);
  }
  console.log(L.join('\n'));
}

function cmdCheck(args) {
  const c = ctx(args);
  const id = need(args, 0, 'task id');
  const name = needFlag(args, 'name');
  const result = needFlag(args, 'result').toLowerCase();
  const note = needFlag(args, 'note');
  if (!['pass', 'fail'].includes(result)) throw new OrchError('BAD_ARGUMENTS', '--result: pass or fail', 1);
  c.store.transact((state) => {
    const t = sm.getTask(state, id);
    if (t.state === 'IMPLEMENTED') {
      t.verify_cycle++;
      sm.transition(state, id, 'VERIFYING', { reason: `verification cycle ${t.verify_cycle}` });
    } else if (t.state !== 'VERIFYING') {
      throw new OrchError('WRONG_STATE', `${id} is ${t.state}; manual checks are recorded during verification`);
    }
    t.checks.push({ cycle: t.verify_cycle, kind: 'manual', name, passed: result === 'pass', detail: note, at: nowIso() });
  });
  console.log(`${id}: manual check recorded (${result}): ${name}. Run \`fo verify ${id}\` to finish verification.`);
}

// ---------------------------------------------------------------- review

function cmdReviewPackage(args) {
  const c = ctx(args);
  const id = need(args, 0, 'task id');
  const out = c.store.transact((state) => {
    const t = sm.getTask(state, id);
    if (t.state !== 'REVIEWING') throw new OrchError('WRONG_STATE', `${id} is ${t.state}; independent review happens in REVIEWING`);
    const done = new Set(sm.currentReviews(t).filter((r) => r.reviewer === 'review-worker').map((r) => r.perspective));
    const required = t.route.review.perspectives || [];
    const perspective = String(args.flags.perspective || required.find((p) => !done.has(p)) || '');
    if (!required.includes(perspective) || done.has(perspective)) throw new OrchError('INVALID_PERSPECTIVE', 'choose an outstanding required review perspective');
    if (sm.budgetStatus(state).exceeded) throw new OrchError('BUDGET_LIMIT', 'agent-call budget is exhausted');
    const a = sm.lastAttempt(t);
    const dispatch = { id: crypto.randomUUID(), perspective, cycle: t.verify_cycle, attempt: a.attempt_id,
      candidate: t.verified_candidate?.commit || null, agent_id: null };
    t.review_dispatches ||= [];
    if (t.review_dispatches.some((d) => d.cycle === dispatch.cycle && d.perspective === perspective)) {
      throw new OrchError('REVIEW_ALREADY_DISPATCHED', 'a review for this perspective has already been dispatched');
    }
    t.review_dispatches.push(dispatch);
    const k = t.contract;
    const where = state.project.root;
    const L = [`# Independent review of ${id}: ${k.title}   (perspective: ${perspective})`];
    L.push('You did not write this change. Judge it against the contract and the evidence, not against the author\'s summary. Do not modify any file.');
    L.push('', '## Contract', `Objective: ${k.objective}`, 'Acceptance criteria:');
    k.acceptance_criteria.forEach((x, i) => L.push(`${i + 1}. ${x}`));
    L.push(`Authorized file scope: ${k.file_scope.join(', ') || '(read-only task)'}`);
    L.push('', '## The change');
    if (a && a.commit) {
      const diff = gitops.git(where, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', `${a.base}...${a.commit}`, '--']);
      if (diff.code !== 0) throw new OrchError('DIFF_UNAVAILABLE', 'could not generate the candidate review diff');
      const evidence = path.join(c.runDir, 'evidence', `${id}-review-${dispatch.id}.diff`);
      sm.writeAtomic(evidence, diff.raw);
      L.push(`Read the diff at ${evidence} (generated by git diff ${a.base}...${a.commit}).`,
        `Verified commit: ${a.commit}`, `Changed files: ${(a.changed_files || []).join(', ') || '(none)'}`);
    }
    else L.push(`Project directory: ${where}`, `Changed files: ${(a && a.changed_files ? a.changed_files : []).join(', ') || '(see the worker summary)'}`);
    if (a && a.report) L.push(`Author summary (unverified): ${a.report.summary}`, `Known issues reported: ${a.report.known_issues.join('; ') || 'none'}`);
    L.push('', `## Verification already recorded (cycle ${t.verify_cycle})`);
    for (const x of sm.currentChecks(t)) L.push(`- ${x.passed ? 'PASS' : 'FAIL'} [${x.kind}] ${x.name}${x.evidence ? ` (${path.join(c.runDir, x.evidence)})` : ''}`);
    L.push('', '## What to examine');
    L.push(perspective === 'security'
      ? 'Trust boundaries, input validation, authentication and authorization paths, secrets handling, injection and path traversal, failure paths that leak data or fail open.'
      : 'Whether each criterion is really met; functional defects; regressions; files changed outside the scope; whether the tests would fail if the behaviour were wrong; error cases; maintainability; documentation accuracy.');
    L.push('Read the verification evidence already recorded. Report missing evidence instead of executing project code.');
    L.push('', '## Review report', 'End your final message with ONE fenced yaml block in exactly this shape:');
    L.push('```yaml', `task_id: ${id}`, 'reviewer: review-worker', `perspective: ${perspective}`, 'verdict: approve            # approve | reject', 'criteria:                   # one entry per acceptance criterion, in order');
    k.acceptance_criteria.forEach(() => L.push('  - met: true', '    evidence: <what you observed: file:line, command and result>'));
    L.push(`review_dispatch_id: ${dispatch.id}`, `attempt_id: ${dispatch.attempt}`);
    if (dispatch.candidate) L.push(`candidate_commit: ${dispatch.candidate}`);
    L.push('findings: []                # when rejecting: each defect, where it is, and why it matters', '```');
    state.budget.agent_calls++;
    sm.emit(state, { type: 'review_dispatched', task: id, perspective });
    return { text: L.join('\n'), model: t.route.tier.startsWith('lead') ? 'opus' : 'sonnet' };
  });
  console.log(`REVIEW DISPATCH for ${id}\nAgent call: subagent_type=fable-orchestrator-review-worker | model=${out.model} | description="Review ${id}"\n  If this restricted agent is unavailable, install it before dispatch.\n--- prompt: pass verbatim ---\n${out.text}\n--- end prompt ---\nThen pass the review YAML with the distinct host completion ID: fo review ${id} --agent-id <host ID> --stdin`);
}

function cmdReview(args) {
  const c = ctx(args);
  const id = need(args, 0, 'task id');
  const raw = yaml.parse(yaml.extractYamlBlock(readInput(args, 'the review report')));
  const out = c.store.transact((state) => {
    const t = sm.getTask(state, id);
    if (t.state !== 'REVIEWING') throw new OrchError('WRONG_STATE', `${id} is ${t.state}; reviews are recorded in REVIEWING (verification must pass first)`);
    const v = V.validateReview(raw, t);
    if (v.errors.length) throw new OrchError('INVALID_REVIEW', [`${id}: review rejected (state unchanged):`].concat(v.errors.map((e) => `  - ${e}`)).join('\n'));
    const r = Object.assign({ cycle: t.verify_cycle, at: nowIso() }, v.review);
    const candidate = t.verified_candidate?.commit || null;
    if (state.project.git && (!candidate || raw.candidate_commit !== candidate)) {
      throw new OrchError('STALE_EVIDENCE', 'review must identify the commit that passed verification');
    }
    if (r.reviewer === 'review-worker') {
      const agent = needFlag(args, 'agent-id');
      const dispatch = (t.review_dispatches || []).find((d) => d.id === raw.review_dispatch_id);
      const author = sm.lastAttempt(t);
      if (!dispatch || dispatch.agent_id || dispatch.cycle !== t.verify_cycle || dispatch.perspective !== r.perspective ||
          dispatch.attempt !== author.attempt_id || dispatch.attempt !== raw.attempt_id || dispatch.candidate !== candidate ||
          author.agent_id === agent || (t.review_dispatches || []).some((d) => d.agent_id === agent)) {
        throw new OrchError('INVALID_REVIEW_DISPATCH', 'reviewer or dispatch identity is missing, reused, or does not match this verification');
      }
      dispatch.agent_id = agent;
      r.reviewer_dispatch_id = dispatch.id;
      r.reviewer_agent_id = agent;
    }
    r.candidate_commit = candidate;
    t.reviews.push(r);
    fs.writeFileSync(path.join(c.runDir, 'reviews', `${id}-c${t.verify_cycle}-${sm.currentReviews(t).length}.yaml`), yaml.dump(v.review));
    const gate = sm.reviewGate(t);
    if (gate.rejected) sm.transition(state, id, 'CORRECTION_REQUIRED', { reason: `review rejected by ${r.reviewer}: ${clip(r.findings[0] || 'acceptance criteria not met', 160)}` });
    else if (gate.satisfied) sm.transition(state, id, 'APPROVED', { reason: 'verification passed and reviews approved' });
    return { state: t.state, missing: gate.missing, left: sm.maxRounds(state, t) - t.review_round };
  });
  if (out.state === 'APPROVED') {
    console.log(`${id}: APPROVED`);
    if (args.flags.integrate) cmdIntegrate({ _: [id], flags: chained(args), rest: null });
    else console.log(`NEXT: fo integrate ${id}`);
  } else if (out.state === 'CORRECTION_REQUIRED') {
    console.log(`${id}: review rejected -> CORRECTION_REQUIRED. ${out.left > 0 ? `fo correct ${id} --stdin  (${out.left} round(s) left)` : 'Correction limit reached: escalate to the user.'}`);
  } else {
    console.log(`${id}: review recorded; approval still needs ${out.missing.join(' and ')}.`);
  }
}

// ------------------------------------------------------------ correction

function applyStrategy(state, c, t, sc) {
  const before = { tier: t.route.tier, model: t.route.model, role: t.route.role };
  const tiers = state.config.routing.tiers;
  if (sc.kind === 'model') {
    if (!state.config.routing.allow_escalation) throw new OrchError('ESCALATION_DISABLED', 'routing.allow_escalation is off in the configuration', 3);
    let tier = t.route.tier;
    let model = sc.model;
    if (!model) {
      tier = routing.nextTier(t.route.tier);
      if (!tier) throw new OrchError('LADDER_EXHAUSTED', `${t.id}: already at the top worker tier. Implement it directly (\`fo escalate ${t.id} --kind strategy --role orchestrator --reason "..."\`) or escalate to the user`, 3);
      model = tiers[tier].model;
    } else {
      const from = routing.TIER_ORDER.indexOf(t.route.tier);
      const match = routing.TIER_ORDER.slice(from).find((x) => tiers[x].model === model);
      if (match) tier = match;
    }
    if (t.attempts.some((a) => a.route.tier === tier && a.route.model === model)) {
      throw new OrchError('NO_MEANINGFUL_CHANGE', `${t.id}: ${tier}/${model} was already tried; an escalation has to change something`);
    }
    t.route = Object.assign({}, t.route, { tier, model, effort: tiers[tier].effort || null, oversight: tier === 'lead_oversight', cost_units: state.config.routing.cost_weights[model] ?? null });
    if (t.route.role === 'implementation-worker' && routing.TIER_ORDER.indexOf(tier) >= 3) t.route.role = 'opus-executor';
  }
  if (sc.role) {
    if (!V.ROLES.includes(sc.role)) throw new OrchError('BAD_ARGUMENTS', `role: one of ${V.ROLES.join(', ')}`, 1);
    if (sc.role === t.route.role && sc.kind !== 'model') throw new OrchError('NO_MEANINGFUL_CHANGE', `${t.id}: already assigned to ${sc.role}`);
    t.route = Object.assign({}, t.route, { role: sc.role });
    if (sc.role === 'orchestrator') t.route.model = 'inherit';
  }
  t.route.review = routing.reviewPolicy(t.contract, state.options.mode, t.route.role);
  const after = { tier: t.route.tier, model: t.route.model, role: t.route.role };
  t.escalations.push({ at: nowIso(), kind: sc.kind, detail: sc.detail, from: before, to: after });
  sm.emit(state, { type: 'escalation', task: t.id, kind: sc.kind, from: before, to: after });
  observe(c, { category: 'escalation', task: t.id, text: `${sc.kind}: ${before.role}/${before.model} -> ${after.role}/${after.model}; ${sc.detail}` });
}

function cmdCorrect(args) {
  const c = ctx(args);
  const id = need(args, 0, 'task id');
  const raw = yaml.parse(yaml.extractYamlBlock(readInput(args, 'the correction request')));
  const out = c.store.transact((state) => {
    const t = sm.getTask(state, id);
    if (t.state !== 'CORRECTION_REQUIRED') throw new OrchError('WRONG_STATE', `${id} is ${t.state}; corrections apply to CORRECTION_REQUIRED tasks`);
    const max = sm.maxRounds(state, t);
    if (t.review_round >= max) {
      throw new OrchError('CORRECTION_LIMIT', `${id}: the limit of ${max} correction rounds is used up. Do not raise it yourself. Re-examine the specification, then escalate to the user: fo block ${id} --kind correction_limit --reason "..."  (the user may grant one more round with fo authorize ${id} --extra-rounds 1 --by user --reason "...") or fo fail ${id} --reason "..."`, 3);
    }
    const round = t.review_round + 1;
    const v = V.validateCorrection(raw, t, round);
    if (v.errors.length) throw new OrchError('INVALID_CORRECTION', [`${id}: correction request rejected (state unchanged):`].concat(v.errors.map((e) => `  - ${e}`)).join('\n'));
    const k = v.correction;
    if (k.scope_expansion.length) {
      t.spec_revisions.push({ at: nowIso(), reason: `scope widened for correction round ${round}: ${k.scope_expansion_reason}`, previous_scope: t.contract.file_scope.slice() });
      t.contract.file_scope = t.contract.file_scope.concat(k.scope_expansion.filter((p) => !t.contract.file_scope.includes(p)));
    }
    if (k.strategy_change && (k.strategy_change.kind === 'model' || k.assign_role)) applyStrategy(state, c, t, { kind: k.strategy_change.kind, detail: k.strategy_change.detail, model: k.strategy_change.model, role: k.assign_role || null });
    else if (k.assign_role) applyStrategy(state, c, t, { kind: 'strategy', detail: `reassigned to ${k.assign_role}`, role: k.assign_role });
    else if (k.strategy_change) t.escalations.push({ at: nowIso(), kind: k.strategy_change.kind, detail: k.strategy_change.detail, from: { tier: t.route.tier, model: t.route.model, role: t.route.role }, to: { tier: t.route.tier, model: t.route.model, role: t.route.role } });
    t.corrections.push(Object.assign({ round, cycle: t.verify_cycle, at: nowIso() }, k));
    fs.writeFileSync(path.join(c.runDir, 'corrections', `${id}-r${round}.yaml`), yaml.dump(k));
    t.review_round = round;
    sm.transition(state, id, 'READY', { reason: `correction round ${round}: ${clip(k.failure, 160)}` });
    return { round, max, route: t.route };
  });
  observe(c, { category: 'correction', task: id, text: `round ${out.round}: ${clip(raw.failure || '', 200)}` });
  console.log(`${id}: correction round ${out.round} of ${out.max} recorded -> READY (${out.route.role} on ${out.route.model}). NEXT: fo next`);
}

// ----------------------------------------------------------- integration

function cmdIntegrate(args) {
  const c = ctx(args);
  const id = need(args, 0, 'task id');
  const extra = extraCommands(args);
  const plan = c.store.transact((state) => {
    const t = sm.getTask(state, id);
    if (t.state !== 'APPROVED') throw new OrchError('WRONG_STATE', `${id} is ${t.state}; only APPROVED work is integrated`);
    if (state.delivery_operation || Object.values(state.tasks).some((other) => other.state === 'INTEGRATING')) {
      throw new OrchError('INTEGRATION_BUSY', 'another integration or delivery may still be active');
    }
    ensureIntegration(state, c);
    sm.transition(state, id, 'INTEGRATING', { reason: 'integration started' });
    t.integration_operation = { id: crypto.randomUUID(), pid: process.pid };
    const a = sm.lastAttempt(t);
    const g = state.project.git;
    if (g && (!t.verified_candidate || t.verified_candidate.commit !== (a.commit || a.base))) {
      throw new OrchError('STALE_EVIDENCE', 'approval lacks verification for the exact candidate; verify and review again');
    }
    if (g && (gitops.mergeInProgress(g.integration_path) || gitops.dirtyFiles(g.integration_path).length)) {
      throw new OrchError('DIRTY_INTEGRATION', 'integration worktree requires manual reconciliation');
    }
    if (g && gitops.revParse(g.integration_path, 'HEAD') !== (g.verified_integration?.commit || g.base_sha)) {
      throw new OrchError('INTEGRATION_MOVED', 'integration checkout contains code outside the last verified commit');
    }
    const cmds = (t.verified_commands || t.contract.verification_commands).slice();
    const policy = routing.MODES[state.options.mode].regression;
    const reg = state.config.integration.regression_command;
    const risky = t.contract.risk_level !== 'low' || t.contract.security_sensitive;
    if (reg && !cmds.includes(reg) && (policy === 'always' || (policy === 'risky' && risky))) cmds.push(reg);
    return {
      cmds: cmds.concat(extra), git: !!g, commit: a ? a.commit : null, dir: g ? g.integration_path : state.project.root,
      root: state.project.root, tip: g ? gitops.revParse(g.integration_path, 'HEAD') : null, branch: g ? g.integration_branch : null,
      setup: state.config.integration.setup_command, operation: t.integration_operation.id,
      cycle: t.verify_cycle, title: t.contract.title, timeout: state.config.verification.command_timeout_seconds * 1000,
    };
  });

  const trial = plan.git
    ? withCandidateCheckout(c, plan.root, plan.tip, (dir) => {
      const already = !!plan.commit && gitops.isAncestor(dir, plan.commit, plan.tip);
      if (plan.commit && !already) {
        const merge = gitops.mergeNoCommit(dir, plan.commit);
        if (!merge.ok) {
          gitops.mergeAbort(dir);
          return { conflict: merge, results: [] };
        }
        if (!merge.noop) gitops.mergeCommit(dir, `Integrate ${id}: ${plan.title}\n\nFable-Run: ${c.runId}\nFable-Task: ${id}`);
      }
      const candidate = gitops.candidate(dir, 'HEAD');
      const results = runCandidateChecks(c, id, plan.cycle, 'i', plan.cmds, dir, plan.timeout, candidate, plan.setup);
      return { candidate, results, already };
    })
    : { results: [plan.setup, ...plan.cmds].filter(Boolean).map((cmd, i) => runAndRecord(c, id, plan.cycle, `i${i + 1}`, cmd, plan.dir, plan.timeout)) };
  const { candidate, conflict, results, already } = trial;
  const failed = results.filter((r) => !r.passed);
  let mergeSha = null;

  const out = c.store.transact((state) => {
    const t = sm.getTask(state, id);
    if (t.state !== 'INTEGRATING' || t.integration_operation?.id !== plan.operation) throw new OrchError('STATE_CHANGED', `${id} changed state during integration`);
    if (candidate && !failed.length) {
      if (gitops.currentBranch(plan.dir) !== plan.branch || gitops.revParse(plan.dir, 'HEAD') !== plan.tip ||
          gitops.dirtyFiles(plan.dir).length) throw new OrchError('INTEGRATION_MOVED', 'integration checkout changed while checks ran');
      if (candidate.commit !== plan.tip) {
        const ff = gitops.fastForward(plan.dir, candidate.commit);
        if (!ff.ok || gitops.revParse(plan.dir, 'HEAD') !== candidate.commit) {
          throw new OrchError('INTEGRATION_MOVED', 'could not advance integration to the verified commit');
        }
        mergeSha = candidate.commit;
      }
      state.project.git.verified_integration = candidate;
    }
    t.integration = {
      cycle: plan.cycle, at: nowIso(), passed: !conflict && !failed.length, merge_commit: mergeSha, already_merged: already,
      conflict_files: conflict ? conflict.conflicts : [], checks: results, candidate: candidate || null, commands: plan.cmds,
    };
    delete t.integration_operation;
    if (t.integration.passed) {
      sm.transition(state, id, 'COMPLETED', { reason: mergeSha ? `merged into the integration branch as ${short(mergeSha)}` : already ? 'already on the integration branch; checks passed' : 'integration checks passed' });
      recordOutcome(c, state, t, true);
      sm.refresh(state);
    } else {
      const why = conflict ? `merge conflict in ${conflict.conflicts.join(', ') || 'unknown files'}` : `integration check failed: ${failed.map((f) => clip(f.name, 80)).join(', ')}${already ? ' (the work is already on the integration branch: fix forward)' : ''}`;
      if (conflict) observe(c, { category: 'integration_conflict', task: id, text: why });
      else observe(c, { category: 'integration_regression', task: id, text: why });
      sm.transition(state, id, 'CORRECTION_REQUIRED', { reason: why });
    }
    return { state: t.state, ready: state.order.filter((x) => state.tasks[x].state === 'READY'), summary: sm.summary(state) };
  });

  const L = [`${id}: integration in ${plan.dir}`];
  if (conflict) L.push(`  CONFLICT (merge aborted, nothing changed): ${conflict.conflicts.join(', ')}`);
  for (const k of results) {
    L.push(`  ${k.passed ? 'PASS' : 'FAIL'} ${k.name}${k.kind === 'command' ? ` (exit ${k.timed_out ? 'TIMEOUT' : k.exit_code}, ${k.evidence})` : ` - ${k.detail}`}`);
    if (!k.passed && k.output_tail) L.push(...k.output_tail.split('\n').map((l) => `      | ${l}`));
  }
  if (out.state === 'COMPLETED') {
    L.push(`-> COMPLETED${mergeSha ? ` (merge ${short(mergeSha)})` : ''}. ${out.ready.length ? `Now ready: ${out.ready.join(', ')} - run fo next.` : out.summary.run_state.startsWith('COMPLETE') ? 'All tasks finished: fo deliver, then fo final-report.' : 'Run fo next.'}`);
  } else {
    L.push(`-> CORRECTION_REQUIRED. The correction must make the work merge and pass on top of the integration branch: fo correct ${id} --stdin`);
  }
  console.log(L.join('\n'));
}

function cmdDeliver(args) {
  const c = ctx(args);
  const pre = c.store.transact((state) => {
    if (state.delivery_operation || Object.values(state.tasks).some((t) => t.state === 'INTEGRATING')) {
      throw new OrchError('INTEGRATION_BUSY', 'another integration or delivery may still be active');
    }
    state.delivery_operation = { id: crypto.randomUUID(), pid: process.pid };
    return state;
  });
  const g = pre.project.git;
  const target = g?.verified_integration;
  let audit = [];
  const reg = pre.config.integration.regression_command;
  if (target && gitops.revParse(pre.project.root, g.integration_branch) === target.commit) {
    const commands = pre.order.flatMap((id) => {
      const t = pre.tasks[id];
      return t.state === 'COMPLETED' ? (t.integration?.commands || t.contract.verification_commands) : [];
    });
    if (reg) commands.push(reg);
    const setup = pre.config.integration.setup_command;
    audit = withCandidateCheckout(c, pre.project.root, target.commit, (dir) => runCandidateChecks(c, 'RUN', 0, 'final-audit-', [...new Set(commands)], dir, pre.config.verification.command_timeout_seconds * 1000, target, setup));
  }
  const out = c.store.transact((state) => {
    if (state.delivery_operation?.id !== pre.delivery_operation.id) throw new OrchError('STATE_CHANGED', 'delivery state changed while checks ran');
    delete state.delivery_operation;
    const sum = sm.summary(state);
    const gg = state.project.git;
    const open = state.order.filter((id) => !sm.TERMINAL.includes(state.tasks[id].state));
    if (!gg) {
      state.delivery = { status: 'in_place', at: nowIso(), detail: 'shared workspace: changes were made directly in the project directory' };
    } else if (!gg.integration_branch) {
      state.delivery = { status: 'nothing_to_deliver', at: nowIso() };
    } else if (!target || !audit.length || gitops.revParse(state.project.root, gg.integration_branch) !== target.commit) {
      state.delivery = { status: 'not_delivered', at: nowIso(), branch: gg.integration_branch, reason: 'integration tip differs from the recorded verified commit or has no verification' };
    } else if (audit.some((check) => !check.passed)) {
      state.delivery = { status: 'not_delivered', at: nowIso(), branch: gg.integration_branch, reason: `final audit failed: ${audit.filter((check) => !check.passed).map((check) => check.name).join(', ')}`, checks: audit };
    } else if (!state.config.integration.auto_deliver && !args.flags.force) {
      state.delivery = { status: 'not_delivered', at: nowIso(), branch: gg.integration_branch, reason: 'integration.auto_deliver is off: merge the integration branch yourself' };
    } else {
      const root = state.project.root;
      const cur = gitops.git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).out || null;
      if (cur !== gg.base_branch) {
        state.delivery = { status: 'not_delivered', at: nowIso(), branch: gg.integration_branch, reason: `your checkout is on ${cur || 'a detached HEAD'} but the run started on ${gg.base_branch || 'a detached HEAD'}` };
      } else {
        const ff = gitops.fastForward(root, target.commit);
        state.delivery = ff.ok && gitops.revParse(root, 'HEAD') === target.commit
          ? { status: 'delivered', at: nowIso(), branch: gg.integration_branch, head: target.commit, verified: target, checks: audit }
          : { status: 'not_delivered', at: nowIso(), branch: gg.integration_branch, reason: `fast-forward refused (your branch moved, or local changes would be overwritten): ${clip(ff.output, 300)}` };
      }
    }
    if (state.delivery.status === 'delivered' || state.delivery.status === 'in_place') state.phase = open.length ? state.phase : 'DELIVERED';
    sm.emit(state, { type: 'delivery', status: state.delivery.status });
    return { d: state.delivery, open, sum };
  });
  const d = out.d;
  const L = [`DELIVERY: ${d.status}`];
  if (d.status === 'delivered') L.push(`  ${g.base_branch} fast-forwarded to ${short(d.head)} (${out.sum.counts.COMPLETED} completed task(s)). Uncommitted changes in your checkout were left as they were.`);
  if (d.reason) L.push(`  ${d.reason}`, `  Inspect integration branch ${d.branch} and its recorded evidence before any manual merge.`);
  if (d.detail) L.push(`  ${d.detail}`);
  if (out.open.length) L.push(`  note: ${out.open.length} task(s) are not finished (${out.open.join(', ')}); only completed work is on the integration branch.`);
  L.push('NEXT: fo final-report');
  console.log(L.join('\n'));
}

function cmdCleanup(args) {
  const c = ctx(args);
  const L = ['CLEANUP (non-destructive: unmerged branches and dirty worker worktrees are kept)'];
  c.store.transact((state) => {
    const g = state.project.git;
    if (!g) { L.push('  shared workspace: nothing to clean'); return; }
    if (state.delivery_operation || Object.values(state.tasks).some((t) => t.state === 'INTEGRATING' || t.verification_operation)) {
      throw new OrchError('WORKSPACE_BUSY', 'verification, integration, or delivery may still be active');
    }
    const root = state.project.root;
    for (const t of Object.values(state.tasks)) {
      if (!sm.TERMINAL.includes(t.state)) continue;
      for (const a of t.attempts) {
        const dir = a.worktree_path;
        if (!a.ownership || !a.report || !a.commit || !dir || !gitops.isWorktree(dir) ||
            !sameRepo(root, dir) || gitops.currentBranch(dir) !== a.branch ||
            gitops.revParse(dir, 'HEAD') !== a.commit || gitops.dirtyFiles(dir).length) {
          if (dir && fs.existsSync(dir)) L.push(`  kept ${dir} for reconciliation`);
          continue;
        }
        const r = gitops.worktreeRemove(root, dir, false);
        L.push(`  ${r.ok ? 'removed' : 'kept'} worker worktree ${dir}${r.ok ? '' : ` (${clip(r.message, 120)})`}`);
        if (r.ok && a.branch && gitops.branchExists(root, a.branch) &&
            gitops.revParse(root, a.branch) === a.commit && gitops.isAncestor(root, a.commit, gitops.revParse(root, 'HEAD'))) {
          const r = gitops.branchDeleteMerged(root, a.branch);
          L.push(`  ${r.ok ? 'deleted merged branch' : 'kept branch'} ${a.branch}${r.ok ? '' : ' (not merged into your branch, or still checked out)'}`);
        }
      }
    }
    if (state.delivery?.status === 'delivered' && g.integration_path && gitops.isWorktree(g.integration_path) &&
        sameRepo(root, g.integration_path) && gitops.currentBranch(g.integration_path) === g.integration_branch &&
        gitops.revParse(g.integration_path, 'HEAD') === state.delivery.head && !gitops.dirtyFiles(g.integration_path).length) {
      const r = gitops.worktreeRemove(root, g.integration_path, false);
      L.push(`  ${r.ok ? 'removed' : 'kept'} integration worktree${r.ok ? '' : ` (${clip(r.message, 120)})`}`);
      if (r.ok) {
        const b = gitops.branchDeleteMerged(root, g.integration_branch);
        L.push(`  ${b.ok ? 'deleted merged branch' : 'kept branch'} ${g.integration_branch}`);
      }
    } else if (g.integration_branch) {
      L.push(`  kept integration branch ${g.integration_branch} (not delivered)`);
    }
    sm.emit(state, { type: 'cleanup' });
  });
  console.log(L.join('\n'));
}

// ------------------------------------------------------- task management

function cmdBlock(args) {
  const c = ctx(args);
  const id = need(args, 0, 'task id');
  const reason = needFlag(args, 'reason');
  c.store.transact((state) => { sm.transition(state, id, 'BLOCKED', { kind: String(args.flags.kind || 'manual'), reason }); });
  console.log(`${id}: BLOCKED (${args.flags.kind || 'manual'}). It stays incomplete until resolved; say so in the final report.`);
}

function cmdUnblock(args) {
  const c = ctx(args);
  const id = need(args, 0, 'task id');
  const reason = needFlag(args, 'reason');
  const st = c.store.transact((state) => {
    const t = sm.getTask(state, id);
    if (t.state !== 'BLOCKED') throw new OrchError('WRONG_STATE', `${id} is ${t.state}, not BLOCKED`);
    let to = sm.UNBLOCK_TARGET[t.block ? t.block.from : 'READY'] || 'READY';
    if (to === 'READY' && t.contract.dependencies.some((d) => !state.tasks[d] || state.tasks[d].state !== 'COMPLETED')) to = 'PENDING';
    sm.transition(state, id, to, { reason: `unblocked: ${reason}` });
    sm.refresh(state);
    return t.state;
  });
  console.log(`${id}: unblocked -> ${st}`);
}

function cmdFail(args) {
  const c = ctx(args);
  const id = need(args, 0, 'task id');
  const reason = needFlag(args, 'reason');
  c.store.transact((state) => {
    const t = sm.transition(state, id, 'FAILED', { reason });
    recordOutcome(c, state, t, false);
    sm.refresh(state);
  });
  console.log(`${id}: FAILED. Dependent tasks are blocked. Report it as failed, never as done.`);
}

function cmdCancel(args) {
  const c = ctx(args);
  const reason = needFlag(args, 'reason');
  const ids = c.store.transact((state) => {
    const list = args.flags.all ? state.order.filter((id) => !sm.TERMINAL.includes(state.tasks[id].state) && state.tasks[id].state !== 'INTEGRATING') : [need(args, 0, 'task id (or --all)')];
    for (const id of list) sm.transition(state, id, 'CANCELLED', { reason });
    sm.refresh(state);
    return list;
  });
  console.log(`CANCELLED: ${ids.join(', ') || '(nothing)'}. Stop any agent still working on these; late reports for cancelled tasks are refused.`);
}

function cmdReopen(args) {
  const c = ctx(args);
  const id = need(args, 0, 'task id');
  const reason = needFlag(args, 'reason');
  const st = c.store.transact((state) => {
    const t = sm.getTask(state, id);
    if (t.state === 'CANCELLED') sm.transition(state, id, 'PENDING', { reason, userAuthorized: !!args.flags['user-authorized'] });
    else if (t.state === 'COMPLETED') sm.transition(state, id, 'READY', { reason: `reopened: ${reason}` });
    else throw new OrchError('WRONG_STATE', `${id} is ${t.state}; reopen applies to COMPLETED or CANCELLED tasks (FAILED tasks: fo escalate)`);
    sm.refresh(state);
    return t.state;
  });
  console.log(`${id}: reopened -> ${st}`);
}

function cmdEscalate(args) {
  const c = ctx(args);
  const id = need(args, 0, 'task id');
  const kind = needFlag(args, 'kind').toLowerCase();
  const reason = needFlag(args, 'reason');
  if (!['model', 'decomposition', 'context', 'strategy'].includes(kind)) throw new OrchError('BAD_ARGUMENTS', '--kind: model, decomposition, context or strategy', 1);
  let model = null;
  if (args.flags.model) {
    model = Object.keys(routing.MODEL_RANK).find((m) => String(args.flags.model).toLowerCase().includes(m)) || null;
    if (!model) throw new OrchError('BAD_ARGUMENTS', '--model: haiku, sonnet, opus or fable', 1);
  }
  const out = c.store.transact((state) => {
    const t = sm.getTask(state, id);
    if (!['BLOCKED', 'FAILED', 'READY', 'PENDING', 'CORRECTION_REQUIRED'].includes(t.state)) throw new OrchError('WRONG_STATE', `${id} is ${t.state}; escalate when it is blocked, failed, or waiting to be (re)dispatched`);
    applyStrategy(state, c, t, { kind, detail: reason, model, role: args.flags.role ? String(args.flags.role) : null });
    t.retries = 0; // the new strategy gets its own bounded retry allowance; the change is on record
    if (t.state === 'BLOCKED' || t.state === 'FAILED') {
      const waiting = t.contract.dependencies.some((d) => !state.tasks[d] || state.tasks[d].state !== 'COMPLETED');
      sm.transition(state, id, waiting && t.state === 'BLOCKED' ? 'PENDING' : 'READY', { reason: `escalation (${kind}): ${reason}`, strategyChange: true });
    }
    sm.refresh(state);
    return { state: t.state, route: t.route };
  });
  console.log(`${id}: escalated (${kind}) -> ${out.route.role} on ${out.route.model} (${out.route.tier}); state ${out.state}`);
}

function cmdAuthorize(args) {
  const c = ctx(args);
  const by = needFlag(args, 'by');
  const reason = needFlag(args, 'reason');
  if (by.toLowerCase() !== 'user') throw new OrchError('BAD_ARGUMENTS', '--by user: only the user can authorize, and only after actually being asked', 3);
  const msg = c.store.transact((state) => {
    const notes = [];
    if (args.flags['extra-agent-calls'] !== undefined) {
      const n = Number(args.flags['extra-agent-calls']);
      if (!Number.isInteger(n) || n < 1) throw new OrchError('BAD_ARGUMENTS', '--extra-agent-calls: positive integer', 1);
      state.budget.extra_agent_calls += n;
      notes.push(`${n} more agent call(s)`);
    }
    if (args._[0]) {
      const t = sm.getTask(state, args._[0]);
      if (args.flags['extra-rounds'] !== undefined) {
        const n = Number(args.flags['extra-rounds']);
        if (!Number.isInteger(n) || n < 1) throw new OrchError('BAD_ARGUMENTS', '--extra-rounds: positive integer', 1);
        t.extra_rounds += n;
        notes.push(`${n} more correction round(s) for ${t.id}`);
      } else {
        throw new OrchError('HOST_APPROVAL_REQUIRED', 'the CLI cannot authenticate approval for external actions; use the host permission flow', 3);
      }
    }
    if (!notes.length) throw new OrchError('BAD_ARGUMENTS', 'nothing to authorize: give a task id, --extra-rounds N, or --extra-agent-calls N', 1);
    state.decisions.push({ at: nowIso(), text: `User authorization: ${notes.join('; ')} (${reason})` });
    sm.emit(state, { type: 'authorization', detail: notes.join('; '), reason });
    return notes.join('; ');
  });
  console.log(`AUTHORIZED by user: ${msg}`);
}

function cmdAmend(args) {
  const c = ctx(args);
  const id = need(args, 0, 'task id');
  const reason = needFlag(args, 'reason');
  const res = V.validateContract(yaml.parse(readInput(args, 'the amended contract')));
  c.store.transact((state) => {
    const t = sm.getTask(state, id);
    if (!['PENDING', 'READY', 'CORRECTION_REQUIRED', 'BLOCKED'].includes(t.state)) throw new OrchError('WRONG_STATE', `${id} is ${t.state}; a contract is amended only while PENDING, READY, CORRECTION_REQUIRED or BLOCKED`);
    const errors = res.errors.slice();
    if (res.contract && res.contract.task_id !== id) errors.push('task_id cannot change');
    if (!errors.length) {
      const graph = state.order.map((x) => ({ id: x, deps: x === id ? res.contract.dependencies : state.tasks[x].contract.dependencies }));
      errors.push(...sched.validateGraph(graph).errors);
    }
    if (errors.length) throw new OrchError('INVALID_CONTRACT', [`${id}: amended contract rejected:`].concat(errors.map((e) => `  - ${e}`)).join('\n'));
    t.spec_revisions.push({ at: nowIso(), reason, previous: t.contract });
    t.contract = res.contract;
    const fresh = routing.route(res.contract, state.config, state.options.mode, null);
    const keep = routing.TIER_ORDER.indexOf(t.route.tier) > routing.TIER_ORDER.indexOf(fresh.tier);
    t.route = keep ? Object.assign({}, t.route, { review: routing.reviewPolicy(res.contract, state.options.mode, t.route.role) }) : fresh;
    sm.emit(state, { type: 'contract_amended', task: id, reason });
    observe(c, { category: 'spec_revision', task: id, text: reason });
  });
  console.log(`${id}: contract amended (${reason}).`);
}

function cmdDecision(args) {
  const c = ctx(args);
  // Several quoted decisions may be recorded in one call; bare words are joined into one.
  const quoted = args._.length > 1 && args._.every((a) => /\s/.test(a.trim()));
  const texts = (quoted ? args._ : [args._.join(' ')]).map((t) => t.trim()).filter(Boolean);
  if (!texts.length) throw new OrchError('BAD_ARGUMENTS', 'usage: fo decision "<assumption or decision>" ["<another>" ...]', 1);
  c.store.transact((state) => {
    for (const t of texts) {
      state.decisions.push({ at: nowIso(), text: t });
      sm.emit(state, { type: 'decision', text: t });
    }
  });
  console.log(`${texts.length} decision(s) recorded`);
}

function cmdGo(args) {
  const c = ctx(args);
  c.store.transact((state) => {
    state.options.plan_only = false;
    sm.emit(state, { type: 'plan_approved' });
  });
  console.log('plan-only cleared: `fo next` will dispatch.');
}

// ---------------------------------------------------------------- status

function statusText(state, c) {
  const sum = sm.summary(state);
  const g = state.project.git;
  const L = [`RUN ${state.run_id} | ${sum.run_state} | phase ${state.phase} | mode ${state.options.mode}${state.options.plan_only ? ' (plan-only)' : ''}`];
  L.push(`workspace: ${state.project.isolation}${g ? `, base ${g.base_branch || 'detached HEAD'} @ ${short(g.base_sha)}${g.integration_branch ? `, integration branch ${g.integration_branch}` : ''}` : ''}`);
  L.push(`tasks: ${sum.total}${sum.total ? ` (${sm.STATES.filter((s) => sum.counts[s]).map((s) => `${s} ${sum.counts[s]}`).join(', ')})` : ''}`);
  for (const id of state.order) {
    const t = state.tasks[id];
    L.push(`  ${id.padEnd(12)} ${t.state.padEnd(20)} ${`${t.route.role}/${t.route.model}`.padEnd(30)} dispatches ${t.attempts.length}, corrections ${t.review_round}, retries ${t.retries}  ${clip(t.contract.title, 44)}`);
  }
  const b = sm.budgetStatus(state);
  L.push(`budget: ${state.budget.agent_calls} agent dispatch(es)${state.budget.tokens_reported ? `, ${state.budget.tokens_reported} worker tokens reported` : ''}${b.exceeded ? ' - LIMIT REACHED' : ''}`);
  for (const w of b.warnings) L.push(`  warning: ${w}`);
  if (state.delivery) L.push(`delivery: ${state.delivery.status}${state.delivery.reason ? ` (${clip(state.delivery.reason, 160)})` : ''}`);
  const actions = sm.nextActions(state);
  if (actions.length) L.push('open actions:', ...actions.map((x) => `  - ${x}`));
  else if (sum.total && sum.run_state.startsWith('COMPLETE') && !state.delivery) L.push('open actions:', '  - all tasks finished: fo deliver, then fo final-report');
  L.push(`run_dir: ${c.runDir}`);
  return L.join('\n');
}

function cmdStatus(args) {
  const c = ctx(args);
  const state = c.store.read();
  if (args.flags.json) { console.log(JSON.stringify({ summary: sm.summary(state), checkpoint: sm.buildCheckpoint(state), recovered: c.store.recovered }, null, 1)); return; }
  if (c.store.recovered) console.log(`WARNING: state.json was unreadable; showing ${c.store.recovered.from}. Run \`fo recover\` to repair it.`);
  console.log(statusText(state, c));
}

function cmdResume(args) {
  const c = ctx(args);
  const out = c.store.transact((state) => {
    const notes = [];
    if (c.store.recovered) notes.push(`state was restored from ${c.store.recovered.from}; ${c.store.recovered.lost_events.length} later event(s) were not in it - reconcile them below before continuing`);
    if (state.options.plan_only && state.order.length) {
      state.options.plan_only = false;
      notes.push('this was a plan-only run: resuming executes the accepted plan');
      sm.emit(state, { type: 'plan_approved' });
    }
    for (const id of state.order) {
      const t = state.tasks[id];
      if (t.state === 'DISPATCHED' || t.state === 'RUNNING') {
        const a = sm.lastAttempt(t);
        if (a) a.reconciliation_required = true;
        notes.push(`${id}: worker liveness is unknown; dispatch ${a?.attempt_id || 'from an older release'} retained. Check the host before accepting completion or recording worker failure.`);
      } else if (t.state === 'VERIFYING' && t.verification_operation) {
        notes.push(`${id}: verification may still be active. Confirm it stopped before running fo reconcile.`);
      } else if (t.state === 'INTEGRATING') {
        notes.push(`${id}: integration may still be active. Inspect its worktree before running fo reconcile.`);
      }
    }
    if (state.delivery_operation) notes.push('Delivery may still be active. Inspect the destination checkout before running fo reconcile RUN.');
    sm.refresh(state);
    sm.emit(state, { type: 'resume' });
    return { notes, lost: c.store.recovered ? c.store.recovered.lost_events : [], text: statusText(state, c), request: state.request, decisions: state.decisions };
  });
  const L = ['RESUME'];
  for (const n of out.notes) L.push(`  - ${n}`);
  for (const e of out.lost) L.push(`  lost event: ${e.type} ${e.task || ''} ${e.from ? `${e.from} -> ${e.to}` : ''} ${e.reason || ''}`);
  L.push('', 'ORIGINAL REQUEST:', ...out.request.split('\n').map((l) => `  ${l}`));
  if (out.decisions.length) L.push('', 'DECISIONS SO FAR:', ...out.decisions.map((d) => `  - ${d.text}`));
  L.push('', out.text, '', `Contracts: ${path.join(c.runDir, 'tasks')}. Continue with the open actions; \`fo next\` returns dispatchable work.`);
  console.log(L.join('\n'));
}

function cmdReconcile(args) {
  const c = ctx(args);
  const id = need(args, 0, 'task id or RUN');
  const reason = needFlag(args, 'reason');
  const confirmStopped = (operation) => {
    if (!operation?.pid) return;
    try { process.kill(operation.pid, 0); } catch (e) { if (e.code === 'ESRCH') return; }
    throw new OrchError('OPERATION_ACTIVE', `process ${operation.pid} may still own this operation`);
  };
  c.store.transact((state) => {
    if (id === 'RUN') {
      if (!state.delivery_operation) throw new OrchError('WRONG_STATE', 'no interrupted delivery is recorded');
      confirmStopped(state.delivery_operation);
      delete state.delivery_operation;
    } else {
      const t = sm.getTask(state, id);
      if (t.state === 'VERIFYING' && t.verification_operation) {
        confirmStopped(t.verification_operation);
        delete t.verification_operation;
      } else if (t.state === 'INTEGRATING') {
        confirmStopped(t.integration_operation);
        const dir = state.project.git?.integration_path;
        if (dir && (gitops.mergeInProgress(dir) || gitops.dirtyFiles(dir).length)) {
          throw new OrchError('DIRTY_INTEGRATION', 'reconcile the integration worktree before clearing the interrupted operation');
        }
        delete t.integration_operation;
        sm.transition(state, id, 'APPROVED', { recovery: true, reason });
      } else {
        throw new OrchError('WRONG_STATE', `${id}: no interrupted verification or integration is recorded`);
      }
    }
    sm.emit(state, { type: 'operation_reconciled', task: id, reason });
  });
  console.log(`${id}: interrupted operation reconciled`);
}

function cmdRecover(args) {
  const c = ctx(args);
  const info = c.store.transact(() => c.store.recovered);
  if (!info) { console.log('state.json is readable; nothing to recover.'); return; }
  const L = [`RECOVERED from ${info.from} (sequence ${info.seq}). The unreadable file was kept beside it as evidence.`];
  for (const p of info.problems) L.push(`  problem: ${p}`);
  if (info.lost_events.length) {
    L.push(`${info.lost_events.length} event(s) happened after that copy and are not reflected in the restored state. Re-apply or re-check each:`);
    for (const e of info.lost_events) L.push(`  - #${e.seq} ${e.type} ${e.task || ''} ${e.from ? `${e.from} -> ${e.to}` : ''} ${e.reason || ''}`);
  } else {
    L.push('No later events were logged: nothing was lost.');
  }
  L.push('Run `fo resume` next.');
  console.log(L.join('\n'));
}

function cmdFinalReport(args) {
  const c = ctx(args);
  const state = c.store.read();
  const md = sm.finalReport(state, c.runDir);
  const file = path.join(c.runDir, 'final-report.md');
  fs.writeFileSync(file, md);
  console.log(md);
  console.log(`(saved to ${file})`);
}

function cmdRuns(args) {
  const root = findRoot(args.flags.project);
  const dir = path.join(root, RUNTIME, 'runs');
  const runs = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  let current = '';
  try { current = fs.readFileSync(path.join(root, RUNTIME, 'current'), 'utf8').trim(); } catch (e) { /* none */ }
  if (!runs.length) { console.log('no runs'); return; }
  for (const r of runs) {
    let line = r;
    try {
      const s = new sm.Store(path.join(dir, r)).read();
      line += `  ${sm.summary(s).run_state}  ${clip(s.request.replace(/\s+/g, ' '), 70)}`;
    } catch (e) { line += '  (unreadable)'; }
    console.log(`${r === current ? '* ' : '  '}${line}`);
  }
}

// -------------------------------------------------------------- learning

function cmdObserve(args) {
  const c = ctx(args);
  observe(c, { category: needFlag(args, 'category'), task: args.flags.task ? String(args.flags.task) : null, text: needFlag(args, 'text') });
  console.log('observation recorded');
}

function cmdLearn(args) {
  const root = findRoot(args.flags.project);
  const rt = path.join(root, RUNTIME);
  const cfg = loadConfig(root);
  const stats = loadStats(rt);
  let obs = [];
  try { obs = fs.readFileSync(path.join(rt, 'learning', 'observations.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { /* none */ }
  const props = routing.proposals(stats, cfg);
  const byCat = {};
  for (const o of obs) (byCat[o.category] = byCat[o.category] || []).push(o);
  const hints = {
    correction: 'Corrections recur: check whether contracts leave acceptance criteria or edge cases unstated.',
    claim_mismatch: 'Workers reported passing tests that failed independently: keep independent verification mandatory for the tiers involved.',
    scope_violation: 'Workers edited outside their scope: tighten scope wording or widen scopes that are routinely too narrow.',
    integration_conflict: 'Merge conflicts recur: add dependencies between tasks that touch neighbouring code.',
    integration_regression: 'Checks passed alone but failed after merging: set integration.regression_command.',
    spec_revision: 'Contracts were amended after dispatch: spend more of intake on the areas that changed.',
    worker_failure: 'Worker failures recur: check permissions and tool availability before routing work there.',
    escalation: 'Escalations recur: consider routing that kind of task one tier higher from the start.',
  };
  for (const [cat, list] of Object.entries(byCat)) {
    if (list.length >= 3 && hints[cat]) props.push({ kind: 'process', evidence: `${list.length} "${cat}" observations, e.g. ${clip(list[list.length - 1].text, 140)}`, proposal: hints[cat] });
  }
  const L = ['# Proposed improvements (not applied)', '', `Based on ${Object.values(stats).reduce((n, s) => n + s.tasks, 0)} finished task(s) and ${obs.length} observation(s) in this project.`, ''];
  if (!props.length) L.push(`No proposal meets the evidence threshold yet (routing needs ${cfg.routing.min_samples} tasks per tier; process patterns need 3 observations).`);
  for (const p of props) L.push(`- [${p.kind}] ${p.proposal}`, `  evidence: ${p.evidence}`);
  L.push('', 'Nothing here changes behaviour. To adopt a proposal, edit .claude/fable-orchestrator/config.yaml (routing) or the skill references yourself after reviewing the evidence. Proposals never relax verification or safety rules.');
  fs.mkdirSync(path.join(rt, 'learning'), { recursive: true });
  fs.writeFileSync(path.join(rt, 'learning', 'proposals.md'), L.join('\n') + '\n');
  console.log(L.join('\n'));
}

// ------------------------------------------------------------ self-check

function cmdSelfCheck(args) {
  const root = findRoot(args.flags.project);
  const rows = [];
  const add = (ok, what, detail) => rows.push({ ok, what, detail: detail || '' });
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 18, `node ${process.versions.node}`, major >= 18 ? '' : 'Node 18 or newer is required');
  add(gitops.available() ? true : null, 'git', gitops.available() ? gitops.git(root, ['--version']).out : 'not found: runs use the shared workspace fallback');
  for (const f of ['SKILL.md', 'config.default.yaml', 'templates/task-contract.yaml', 'templates/execution-report.yaml', 'templates/review-report.yaml', 'templates/correction-request.yaml']) {
    add(fs.existsSync(path.join(SKILL_DIR, f)), `skill file ${f}`);
  }
  try { loadConfig(root); add(true, 'configuration loads'); } catch (e) { add(false, 'configuration loads', e.message); }
  try {
    const res = V.validateContract(yaml.parse(fs.readFileSync(path.join(SKILL_DIR, 'templates', 'task-contract.yaml'), 'utf8')));
    add(res.errors.length === 0, 'task-contract template validates', res.errors.join('; '));
  } catch (e) { add(false, 'task-contract template validates', e.message); }
  const missing = agentStatus(root);
  add(missing.length ? null : true, 'agent definitions installed', missing.length ? `missing ${missing.join(', ')}: dispatch falls back to general-purpose + role file` : 'project or user level');
  const sh = gitops.findShell();
  add(sh ? true : null, 'shell for verification commands', sh ? `${sh.name} (${sh.file})` : 'system default shell');
  const gi = path.join(root, RUNTIME, '.gitignore');
  add(fs.existsSync(path.join(root, RUNTIME)) ? fs.existsSync(gi) : null, 'runtime state is git-ignored', fs.existsSync(gi) ? gi : 'created on first run');
  for (const r of rows) console.log(`${r.ok === true ? 'ok  ' : r.ok === null ? 'note' : 'FAIL'}  ${r.what}${r.detail ? ` - ${r.detail}` : ''}`);
  if (rows.some((r) => r.ok === false)) process.exit(2);
}

function cmdParseArgs(args) {
  const raw = args.flags['request-file'] ? fs.readFileSync(path.resolve(String(args.flags['request-file'])), 'utf8') : args._.join(' ');
  console.log(JSON.stringify(parseInvocation(raw), null, 1));
}

function cmdHelp() {
  console.log([
    'fo - fable-orchestrator command line',
    '  Text inputs (request, contracts, reports, reviews, corrections) arrive with --stdin or --file <path>.',
    '  init --stdin                   start a run (parses --mode, --max-workers, --review-rounds, --plan-only, --resume, --status)',
    '  plan --file F | --stdin        validate contracts (YAML documents separated by ---), build the dependency graph, route every task',
    '  next [--json]                  select and dispatch the next conflict-free batch',
    '  started ID...                  mark dispatched tasks as running',
    '  bind-worktree ID --attempt-id UUID --agent-id HOST_ID --worktree PATH --branch NAME   record native host ownership',
    '  report ID --stdin [--verify] [--tokens N]   ingest a worker completion report with its attempt ID',
    '  worker-failed ID --attempt-id UUID --kind K --reason R   record a confirmed failure',
    '  check ID --name N --result pass|fail --note T   record a manual verification check',
    '  verify ID [--cmd C]            run verification commands, check file scope, decide REVIEWING or CORRECTION_REQUIRED',
    '  review-package ID              prompt for an independent review-worker',
    '  review ID --stdin [--integrate]    record a review; approve only with evidence for every criterion',
    '  correct ID --stdin             record a targeted correction and re-queue the task (bounded rounds)',
    '  integrate ID                   merge approved work into the integration branch and run integration checks',
    '  deliver | cleanup              fast-forward your branch; remove finished worktrees and merged branches',
    '  block|unblock|fail|cancel|reopen|escalate|authorize|amend   task management (each needs --reason)',
    '  decision "text" | observe --category C --text T | learn',
    '  status [--json] | resume | reconcile ID --reason R | recover | final-report | runs | self-check | go | parse-args',
  ].join('\n'));
}

const COMMANDS = {
  init: cmdInit, plan: cmdPlan, next: cmdNext, started: cmdStarted, 'bind-worktree': cmdBindWorktree, report: cmdReport, 'worker-failed': cmdWorkerFailed,
  check: cmdCheck, verify: cmdVerify, 'review-package': cmdReviewPackage, review: cmdReview, correct: cmdCorrect,
  integrate: cmdIntegrate, deliver: cmdDeliver, cleanup: cmdCleanup, block: cmdBlock, unblock: cmdUnblock, fail: cmdFail,
  cancel: cmdCancel, reopen: cmdReopen, escalate: cmdEscalate, authorize: cmdAuthorize, amend: cmdAmend, decision: cmdDecision,
  go: cmdGo, status: cmdStatus, resume: cmdResume, reconcile: cmdReconcile, recover: cmdRecover, 'final-report': cmdFinalReport, runs: cmdRuns,
  observe: cmdObserve, learn: cmdLearn, 'self-check': cmdSelfCheck, 'parse-args': cmdParseArgs, help: cmdHelp,
};

function main() {
  const argv = process.argv.slice(2);
  const name = argv[0];
  try {
    if (!name || !COMMANDS[name]) {
      cmdHelp();
      process.exit(name ? 1 : 0);
    }
    COMMANDS[name](parseCli(argv.slice(1)));
  } catch (e) {
    if (e instanceof OrchError) {
      console.error(`${e.exit === 1 ? 'ERROR' : 'REFUSED'} [${e.code}]: ${e.message}`);
      process.exit(e.exit);
    }
    if (e instanceof yaml.YamlError) {
      console.error(`INVALID [YAML]: ${e.message}`);
      process.exit(2);
    }
    console.error(`ERROR: ${e.stack || e.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parseCli, parseInvocation, loadConfig, deepMerge, buildPackage, normalizeFsPath, SKILL_DIR };
