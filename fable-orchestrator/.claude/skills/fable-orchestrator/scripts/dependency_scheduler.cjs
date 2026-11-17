'use strict';
/**
 * dependency_scheduler - DAG validation and conflict-aware batch selection.
 * Pure functions: no file or process access.
 */

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

const clean = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const normPath = (p) => {
  const c = clean(p).replace(/\/+$/, '');
  return c === '.' ? '' : c;
};
const isGlob = (p) => /[*?]/.test(p);

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

/** Does `file` fall inside the scope entry `pattern` (exact file, directory prefix, or glob)? */
function matchPath(pattern, file) {
  const raw = clean(pattern);
  const f = normPath(file);
  if (isGlob(raw)) return globToRegex(raw.replace(/\/+$/, '')).test(f);
  const p = normPath(raw);
  if (p === '') return true; // "." = whole project
  return f === p || f.startsWith(p + '/');
}

function staticDir(glob) {
  const head = glob.slice(0, glob.search(/[*?]/));
  const j = head.lastIndexOf('/');
  return j < 0 ? '' : head.slice(0, j);
}

const dirsOverlap = (a, b) => a === b || a === '' || b === '' || a.startsWith(b + '/') || b.startsWith(a + '/');

/** Conservative: returns true whenever two scope entries could name the same file. */
function patternsConflict(a, b) {
  const ra = clean(a);
  const rb = clean(b);
  const ga = isGlob(ra);
  const gb = isGlob(rb);
  if (!ga && !gb) return dirsOverlap(normPath(ra), normPath(rb));
  if (ga && gb) return dirsOverlap(staticDir(ra), staticDir(rb));
  const g = ga ? ra : rb;
  const p = normPath(ga ? rb : ra);
  if (p === '') return true;
  if (matchPath(g, p)) return true; // the plain entry is a file the glob matches
  const sd = staticDir(g);
  if (g.includes('**')) return dirsOverlap(sd, p);
  const globDir = g.includes('/') ? g.slice(0, g.lastIndexOf('/')) : '';
  if (isGlob(globDir)) return dirsOverlap(sd, p);
  return globDir === p || globDir.startsWith(p + '/'); // p is, or contains, the directory the glob lists
}

function scopesConflict(scopeA, scopeB) {
  for (const a of scopeA || []) {
    for (const b of scopeB || []) {
      if (patternsConflict(a, b)) return true;
    }
  }
  return false;
}

/** tasks: [{id, deps}] -> {errors: string[], cycle: string[]|null} */
function validateGraph(tasks) {
  const errors = [];
  const ids = new Set();
  for (const t of tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task_id ${t.id}`);
    ids.add(t.id);
  }
  for (const t of tasks) {
    for (const d of t.deps || []) {
      if (d === t.id) errors.push(`${t.id}: depends on itself`);
      else if (!ids.has(d)) errors.push(`${t.id}: unknown dependency ${d}`);
    }
  }
  const cycle = findCycle(tasks);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  return { errors, cycle };
}

function findCycle(tasks) {
  const deps = new Map(tasks.map((t) => [t.id, (t.deps || []).filter((d) => d !== t.id)]));
  const color = new Map(); // undefined = unvisited, 1 = on stack, 2 = done
  const stack = [];
  let found = null;
  const visit = (id) => {
    if (found) return;
    color.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) || []) {
      if (!deps.has(d)) continue;
      if (color.get(d) === 1) {
        found = stack.slice(stack.indexOf(d)).concat(d);
        return;
      }
      if (!color.get(d)) visit(d);
      if (found) return;
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const t of tasks) {
    if (!color.get(t.id)) visit(t.id);
    if (found) return found;
  }
  return null;
}

/** Topological levels: level 0 has no dependencies. Assumes an acyclic graph. */
function levels(tasks) {
  const remaining = new Map(tasks.map((t) => [t.id, new Set((t.deps || []).filter((d) => d !== t.id))]));
  const out = [];
  while (remaining.size) {
    const level = [...remaining.entries()]
      .filter(([, deps]) => [...deps].every((d) => !remaining.has(d)))
      .map(([id]) => id);
    if (!level.length) break; // cycle: caller validates first
    level.sort();
    out.push(level);
    for (const id of level) remaining.delete(id);
  }
  return out;
}

function dependentCounts(tasks) {
  const count = new Map(tasks.map((t) => [t.id, 0]));
  for (const t of tasks) {
    for (const d of t.deps || []) if (count.has(d)) count.set(d, count.get(d) + 1);
  }
  return count;
}

/**
 * Choose the tasks to dispatch now.
 * tasks: [{id, state, deps, scope, priority, exclusive, holdsScope, usesSlot}]
 *   holdsScope: task currently owns its file scope (work in flight or awaiting review/integration)
 *   usesSlot:   task currently occupies a worker slot (DISPATCHED/RUNNING)
 * opts: {maxWorkers, maxNew}
 * Returns {selected: id[], deferred: [{id, reason}], freeSlots}
 */
function selectBatch(tasks, opts) {
  const maxWorkers = Math.max(1, opts.maxWorkers || 1);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const dependents = dependentCounts(tasks);
  const busy = tasks.filter((t) => t.usesSlot).length;
  let free = Math.max(0, maxWorkers - busy);
  if (Number.isFinite(opts.maxNew)) free = Math.min(free, Math.max(0, opts.maxNew));

  const holders = tasks.filter((t) => t.holdsScope);
  const exclusiveActive = holders.some((t) => t.exclusive);
  const candidates = tasks
    .filter((t) => t.state === 'READY')
    .sort(
      (a, b) =>
        (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2) ||
        (dependents.get(b.id) || 0) - (dependents.get(a.id) || 0) ||
        a.id.localeCompare(b.id),
    );

  const selected = [];
  const deferred = [];
  for (const t of candidates) {
    const unmet = (t.deps || []).filter((d) => !byId.has(d) || byId.get(d).state !== 'COMPLETED');
    if (unmet.length) { deferred.push({ id: t.id, reason: `dependencies not completed: ${unmet.join(', ')}` }); continue; }
    if (free <= 0) { deferred.push({ id: t.id, reason: 'no free worker slot' }); continue; }
    if (exclusiveActive) { deferred.push({ id: t.id, reason: 'an exclusive task is in flight' }); continue; }
    const others = holders.filter((h) => h.id !== t.id);
    const chosen = selected.map((id) => byId.get(id));
    if (t.exclusive && (others.length || chosen.length)) {
      deferred.push({ id: t.id, reason: 'exclusive task waits for all other work to finish' });
      continue;
    }
    if (chosen.some((c) => c.exclusive)) { deferred.push({ id: t.id, reason: 'batch already holds an exclusive task' }); continue; }
    const clash = others.concat(chosen).find((o) => scopesConflict(t.scope, o.scope));
    if (clash) { deferred.push({ id: t.id, reason: `file scope overlaps ${clash.id}` }); continue; }
    selected.push(t.id);
    free--;
  }
  return { selected, deferred, freeSlots: free };
}

module.exports = {
  PRIORITY_RANK, normPath, isGlob, matchPath, patternsConflict, scopesConflict,
  validateGraph, findCycle, levels, dependentCounts, selectBatch,
};
