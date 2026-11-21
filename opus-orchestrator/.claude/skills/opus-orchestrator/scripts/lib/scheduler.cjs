'use strict';
// Pure dependency-aware scheduler. No I/O, no clock.
const { scopesOverlap } = require('./security.cjs');

// Same values as statemachine.cjs (DESIGN 4.4); defined locally to stay independent.
const IN_FLIGHT = ['DISPATCHED', 'RUNNING'];
const OWNS_WORK = ['DISPATCHED', 'RUNNING', 'IMPLEMENTED', 'VERIFYING', 'REVIEWING',
  'CORRECTION_REQUIRED', 'APPROVED', 'INTEGRATING'];
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const PRIORITY_RANK = { critical: 3, high: 2, medium: 1, low: 0 };

class SchedulerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function deps(t) { return Array.isArray(t.dependencies) ? t.dependencies : []; }
function scope(t) { return Array.isArray(t.authorized_files) ? t.authorized_files : []; }
function rank(t) { return t.priority in PRIORITY_RANK ? PRIORITY_RANK[t.priority] : PRIORITY_RANK.medium; }
function indexById(tasks) {
  const m = new Map();
  for (const t of tasks) m.set(t.task_id, t);
  return m;
}
function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function missingDependencies(tasks) {
  const byId = indexById(tasks);
  const out = [];
  for (const t of tasks) {
    const missing = deps(t).filter((d) => !byId.has(d));
    if (missing.length) out.push({ task_id: t.task_id, missing });
  }
  return out;
}

// Each cycle follows dependency edges and is rotated to start at its smallest id.
function findCycles(tasks) {
  const byId = indexById(tasks);
  const ids = [...byId.keys()].sort(cmpStr);
  const color = new Map();
  const stack = [];
  const seen = new Set();
  const cycles = [];
  function visit(id) {
    color.set(id, 1);
    stack.push(id);
    const t = byId.get(id);
    for (const d of [...deps(t)].sort(cmpStr)) {
      if (!byId.has(d)) continue;
      const c = color.get(d) || 0;
      if (c === 0) visit(d);
      else if (c === 1) {
        const cyc = stack.slice(stack.indexOf(d));
        const start = cyc.indexOf([...cyc].sort(cmpStr)[0]);
        const rot = cyc.slice(start).concat(cyc.slice(0, start));
        const key = rot.join('>');
        if (!seen.has(key)) { seen.add(key); cycles.push(rot); }
      }
    }
    stack.pop();
    color.set(id, 2);
  }
  for (const id of ids) if (!color.get(id)) visit(id);
  return cycles;
}

// Dependencies first; ties by id. Unknown dependency ids are ignored here.
function topoOrder(tasks) {
  const byId = indexById(tasks);
  const indeg = new Map();
  const out = new Map();
  for (const id of byId.keys()) { indeg.set(id, 0); out.set(id, []); }
  for (const t of byId.values()) {
    for (const d of new Set(deps(t))) {
      if (!byId.has(d)) continue;
      indeg.set(t.task_id, indeg.get(t.task_id) + 1);
      out.get(d).push(t.task_id);
    }
  }
  const ready = [...byId.keys()].filter((id) => indeg.get(id) === 0).sort(cmpStr);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const n of out.get(id)) {
      indeg.set(n, indeg.get(n) - 1);
      if (indeg.get(n) === 0) { ready.push(n); ready.sort(cmpStr); }
    }
  }
  if (order.length !== byId.size) {
    const cycles = findCycles(tasks);
    throw new SchedulerError('CYCLE',
      `dependency cycle: ${cycles.map((c) => c.concat(c[0]).join(' -> ')).join('; ')}`, { cycles });
  }
  return order;
}

function dependents(tasks) {
  const byId = indexById(tasks);
  const res = {};
  for (const id of byId.keys()) res[id] = [];
  for (const t of byId.values()) {
    for (const d of new Set(deps(t))) if (byId.has(d)) res[d].push(t.task_id);
  }
  for (const id of Object.keys(res)) res[id].sort(cmpStr);
  return res;
}

// downstream: transitive non-terminal dependents; chain: longest chain of non-terminal dependents.
function criticalPath(tasks) {
  const byId = indexById(tasks);
  const direct = dependents(tasks);
  const live = (id) => !TERMINAL.includes(byId.get(id).status);
  const chainMemo = new Map();
  const onPath = new Set();
  function chain(id) {
    if (chainMemo.has(id)) return chainMemo.get(id);
    if (onPath.has(id)) return 0; // cycle guard
    onPath.add(id);
    let best = 0;
    for (const n of direct[id]) if (live(n)) best = Math.max(best, 1 + chain(n));
    onPath.delete(id);
    chainMemo.set(id, best);
    return best;
  }
  const res = {};
  for (const id of byId.keys()) {
    const seen = new Set();
    const todo = [id];
    while (todo.length) {
      const cur = todo.pop();
      for (const n of direct[cur]) {
        if (n !== id && !seen.has(n) && live(n)) { seen.add(n); todo.push(n); }
      }
    }
    res[id] = { downstream: seen.size, chain: chain(id) };
  }
  return res;
}

function depsCompleted(task, byId) {
  const get = byId instanceof Map ? (id) => byId.get(id) : (id) => byId[id];
  return deps(task).every((d) => {
    const t = get(d);
    return !!t && t.status === 'COMPLETED';
  });
}

function promotable(tasks) {
  const byId = indexById(tasks);
  return tasks.filter((t) => t.status === 'PENDING' && depsCompleted(t, byId)).map((t) => t.task_id);
}

function orderCandidates(cands, cp) {
  return [...cands].sort((a, b) =>
    (rank(b) - rank(a)) ||
    (cp[b.task_id].downstream - cp[a.task_id].downstream) ||
    (cp[b.task_id].chain - cp[a.task_id].chain) ||
    cmpStr(a.task_id, b.task_id));
}

function conflicts(task, others) {
  const s = scope(task);
  if (!s.length) return false;
  return others.some((o) => scope(o).length && scopesOverlap(s, scope(o)));
}

function selectBatch(tasks, opts = {}) {
  const { max_workers = 1, parallel = true } = opts;
  const call_budget = opts.call_budget === undefined || opts.call_budget === null ? Infinity : opts.call_budget;
  const byId = indexById(tasks);
  const cp = criticalPath(tasks);
  const inFlight = tasks.filter((t) => IN_FLIGHT.includes(t.status));
  const owners = tasks.filter((t) => OWNS_WORK.includes(t.status));
  const cap = parallel === false ? 1 : max_workers;
  const slotsOpen = Math.max(0, cap - inFlight.length);
  const free = Math.max(0, Math.min(slotsOpen, call_budget));
  const budgetLimited = call_budget < slotsOpen;
  const cands = orderCandidates(
    tasks.filter((t) => t.status === 'READY' && depsCompleted(t, byId)), cp);

  const dispatch = [];
  const deferred = [];
  const chosen = [];
  const exclusiveInFlight = inFlight.some((t) => t.exclusive === true);
  for (const t of cands) {
    if (exclusiveInFlight) { deferred.push({ task_id: t.task_id, reason: 'exclusive' }); continue; }
    if (t.exclusive === true && (inFlight.length > 0 || chosen.length > 0)) {
      deferred.push({ task_id: t.task_id, reason: 'exclusive' }); continue;
    }
    if (chosen.some((c) => c.exclusive === true)) {
      deferred.push({ task_id: t.task_id, reason: 'exclusive' }); continue;
    }
    if (conflicts(t, owners) || conflicts(t, chosen)) {
      deferred.push({ task_id: t.task_id, reason: 'scope_conflict' }); continue;
    }
    if (chosen.length >= free) {
      deferred.push({ task_id: t.task_id, reason: budgetLimited ? 'budget' : 'no_slot' }); continue;
    }
    chosen.push(t);
    dispatch.push(t.task_id);
  }
  return { dispatch, deferred, slots_free: free };
}

// Static preview assuming every task succeeds; each wave honours deps, scope and max_workers.
function planWaves(tasks, max_workers = 1) {
  const missing = missingDependencies(tasks);
  if (missing.length) {
    throw new SchedulerError('MISSING_DEPENDENCY',
      `unknown dependencies: ${missing.map((m) => `${m.task_id} -> ${m.missing.join(', ')}`).join('; ')}`, { missing });
  }
  topoOrder(tasks); // throws CYCLE
  const cp = criticalPath(tasks);
  const done = new Set(tasks.filter((t) => t.status === 'COMPLETED').map((t) => t.task_id));
  let remaining = tasks.filter((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED');
  const waves = [];
  while (remaining.length) {
    const ready = orderCandidates(remaining.filter((t) => deps(t).every((d) => done.has(d))), cp);
    if (!ready.length) {
      throw new SchedulerError('DEADLOCK',
        `tasks cannot be scheduled: ${remaining.map((t) => t.task_id).join(', ')}`);
    }
    const wave = [];
    for (const t of ready) {
      if (t.exclusive === true) {
        if (!wave.length) { wave.push(t); break; }
        continue;
      }
      if (wave.length >= Math.max(1, max_workers)) break;
      if (conflicts(t, wave)) continue;
      wave.push(t);
    }
    const ids = wave.map((t) => t.task_id);
    waves.push(ids);
    for (const id of ids) done.add(id);
    remaining = remaining.filter((t) => !ids.includes(t.task_id));
  }
  return waves;
}

function explainIdle(tasks) {
  const open = tasks.filter((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED');
  if (!open.length) return 'all_done';
  if (open.some((t) => OWNS_WORK.includes(t.status))) return 'waiting_on_running';
  const stuck = open.filter((t) => t.status === 'BLOCKED' || t.status === 'FAILED');
  if (stuck.length) return `blocked: ${stuck.map((t) => t.task_id).sort(cmpStr).join(', ')}`;
  const byId = indexById(tasks);
  const runnable = open.filter((t) => (t.status === 'READY' || t.status === 'PENDING') && depsCompleted(t, byId));
  if (runnable.length) return `ready: ${runnable.map((t) => t.task_id).sort(cmpStr).join(', ')}`;
  return `deadlock: ${open.map((t) => t.task_id).sort(cmpStr).join(', ')}`;
}

module.exports = {
  findCycles, missingDependencies, topoOrder, dependents, criticalPath, depsCompleted,
  promotable, selectBatch, planWaves, explainIdle, SchedulerError,
  IN_FLIGHT, OWNS_WORK,
};
