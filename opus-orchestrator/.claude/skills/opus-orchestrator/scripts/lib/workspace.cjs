'use strict';
// workspace.cjs: which files a task changed and whether they lie in its scope.
//
// Shared workspace (no git isolation): oo stores a file snapshot when a task is dispatched and
// diffs against it at verification. A changed file inside the task's own scope is the task's
// change; a changed file inside the scope of another task that owned work at any time since the
// dispatch is attributed to that task and ignored; anything else is a scope violation. The state
// directory and the inbox are never part of a snapshot.
//
// Worktree strategy: the task's commit is diffed against the merge base with the integration head
// it was given at dispatch, so only the worker's own changes count.
const path = require('node:path');
const security = require('./security.cjs');
const gitops = require('./gitops.cjs');

// Same values as statemachine.cjs OWNS_WORK (DESIGN 4.4).
const OWNS_WORK = ['DISPATCHED', 'RUNNING', 'IMPLEMENTED', 'VERIFYING', 'REVIEWING',
  'CORRECTION_REQUIRED', 'APPROVED', 'INTEGRATING'];

// Directory where Claude Code keeps agent worktrees inside a project.
const AGENT_WORKTREES = '.claude/worktrees';

function relInside(projectDir, abs) {
  const rel = path.relative(projectDir, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** Snapshot ignore list for a project: git data, node_modules, the state directory, the inbox and agent worktrees. */
function snapshotIgnore(paths) {
  const list = ['.git', 'node_modules', AGENT_WORKTREES];
  for (const dir of [paths.stateRoot, paths.inboxDir]) {
    const rel = relInside(paths.projectDir, dir);
    if (rel) list.push(rel);
  }
  return list;
}

/** Status the task had at time `ts` (ISO string), from its history; null before it existed. */
function statusAt(task, ts) {
  const h = Array.isArray(task.history) ? task.history : [];
  let status = null;
  for (const e of h) {
    if (e && typeof e.ts === 'string' && e.ts <= ts) status = e.to;
  }
  return status;
}

/** True when the task was in a work-owning state at any time from `ts` until now. */
function ownedWorkSince(task, ts) {
  if (OWNS_WORK.includes(task.status)) return true;
  if (OWNS_WORK.includes(statusAt(task, ts))) return true;
  const h = Array.isArray(task.history) ? task.history : [];
  return h.some((e) => e && typeof e.ts === 'string' && e.ts >= ts && OWNS_WORK.includes(e.to));
}

/**
 * attributeShared(task, changed, tasks, sinceTs) -> {own, ignored:[{file, owner}], violations, ok}
 * Pure attribution of changed files in a shared workspace.
 */
function attributeShared(task, changed, tasks, sinceTs) {
  const own = [];
  const ignored = [];
  const violations = [];
  const others = (tasks || []).filter((t) => t && t.task_id !== task.task_id && ownedWorkSince(t, sinceTs));
  for (const raw of changed || []) {
    const f = security.normalizePath(raw);
    if (security.fileInScope(f, task.authorized_files || [])) {
      own.push(f);
      continue;
    }
    const owner = others.find((o) => security.fileInScope(f, o.authorized_files || []));
    if (owner) ignored.push({ file: f, owner: owner.task_id });
    else violations.push(f);
  }
  return { own, ignored, violations, ok: violations.length === 0 };
}

/** Merge base of two commits in a repository (or the first commit when there is none). */
function mergeBase(cwd, a, b) {
  const r = gitops.git(['merge-base', a, b], { cwd });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : a;
}

/** Uncommitted (modified, staged or untracked) files in a worktree. */
function uncommittedFiles(cwd) {
  const r = gitops.git(['status', '--porcelain', '-z', '--untracked-files=all'], { cwd });
  if (r.code !== 0) return [];
  const parts = r.stdout.split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    out.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') i++;
  }
  return out.sort();
}

/**
 * worktreeChanges(worktree, integrationHead, commit) -> {base, files}
 * Files the task's commit changed relative to its merge base with the integration head.
 */
function worktreeChanges(worktree, integrationHead, commit) {
  const base = integrationHead ? mergeBase(worktree, integrationHead, commit) : null;
  if (!base) return { base: null, files: [] };
  return { base, files: gitops.changedFiles(worktree, base, commit) };
}

module.exports = {
  OWNS_WORK, AGENT_WORKTREES, snapshotIgnore, statusAt, ownedWorkSince, attributeShared,
  mergeBase, uncommittedFiles, worktreeChanges, relInside,
};
