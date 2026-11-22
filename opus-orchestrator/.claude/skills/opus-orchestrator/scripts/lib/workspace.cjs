'use strict';
// workspace.cjs: which files a task changed and whether they lie in its scope.
//
// Shared workspace (no git isolation): oo stores a content-hash snapshot when a task is first
// dispatched (its baseline, kept across retries and correction rounds) and compares the
// workspace with it at verification. A changed file inside the task's own scope is the task's
// change. A changed file outside it is a scope violation unless its current content is exactly
// the content that another task's verified candidate recorded for that path: authorship is
// established by recorded content, never by another task's scope. Paths matching the generated
// artifact policy are listed but are not scope evidence. Because concurrent writers in one
// directory cannot be told apart, oo serializes shared-workspace tasks (see scheduler
// shared_serial); a change nobody can account for fails the verification and is left in place.
//
// Worktree strategy: the task's pinned candidate commit is diffed against its merge base with
// the integration head it was given at dispatch, so only the worker's own commits count.
const path = require('node:path');
const security = require('./security.cjs');
const gitops = require('./gitops.cjs');

// Same values as statemachine.cjs OWNS_WORK (DESIGN 4.4).
const OWNS_WORK = ['DISPATCHED', 'RUNNING', 'IMPLEMENTED', 'VERIFYING', 'REVIEWING',
  'CORRECTION_REQUIRED', 'APPROVED', 'INTEGRATING'];

// States in which a shared-workspace task's evidence can be disturbed by another task's writes:
// its worker may be editing, its result is being verified, or oo runs its integration commands.
const SHARED_WINDOW = ['DISPATCHED', 'RUNNING', 'IMPLEMENTED', 'VERIFYING', 'INTEGRATING'];

// Directory where Claude Code keeps agent worktrees inside a project.
const AGENT_WORKTREES = '.claude/worktrees';

// Default generated-artifact policy: outputs that verification commands commonly write.
const DEFAULT_GENERATED = ['coverage/', '.nyc_output/', '.pytest_cache/', '**/__pycache__/', '**/*.pyc'];

class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

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

/** The generated-artifact globs of a configuration (verification.generated_artifacts). */
function generatedPolicy(cfg) {
  const v = cfg && cfg.verification && cfg.verification.generated_artifacts;
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : DEFAULT_GENERATED.slice();
}

function isGenerated(file, policy) {
  return security.fileInScope(file, policy || []);
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
 * Content entries other tasks' verified shared candidates recorded: [{task_id, files: {rel: entry|null}, at}].
 * Every verified round counts, so a file another task changed, had verified and then left alone
 * is still attributable after that task moved on.
 */
function recordedCandidates(task, tasks) {
  const out = [];
  for (const o of tasks || []) {
    if (!o || o.task_id === task.task_id) continue;
    const ev = o.evidence || {};
    const rounds = [ev.verification].concat((ev.rounds || []).map((r) => r && r.verification)).filter(Boolean);
    for (const v of rounds) {
      if (v.passed === true && v.candidate && v.candidate.kind === 'shared' && v.candidate.files) {
        out.push({ task_id: o.task_id, files: v.candidate.files, at: v.run_at });
      }
    }
  }
  return out;
}

/**
 * attributeShared(task, comparison, current, opts) -> {own, ignored, generated, violations, ok}
 * comparison: gitops.compareSnapshots(baseline, current), which must be ok (complete evidence).
 * current: the current snapshot, whose content entries are matched against other tasks' recorded
 * candidates. opts: {tasks, generated: [globs]}.
 * ignored: [{file, owner, basis}] files whose current content is exactly what another task's
 * verified candidate recorded. A name that cannot be matched reliably (snapshot.odd) is always a
 * violation.
 */
function attributeShared(task, comparison, current, opts) {
  const o = opts || {};
  if (!comparison || comparison.ok !== true) {
    throw new WorkspaceError('EVIDENCE_INCOMPLETE', `scope evidence is incomplete: ${((comparison && comparison.problems) || ['no comparison']).join('; ')}`);
  }
  const own = [];
  const ignored = [];
  const generated = [];
  const violations = [];
  const odd = new Set((current && current.odd) || []);
  const recorded = recordedCandidates(task, o.tasks);
  const entries = gitops.pickEntries(current, comparison.changed);
  for (const f of comparison.changed) {
    if (odd.has(f)) {
      violations.push(f);
      continue;
    }
    if (security.fileInScope(f, task.authorized_files || [])) {
      own.push(f);
      continue;
    }
    if (isGenerated(f, o.generated)) {
      generated.push(f);
      continue;
    }
    const now = entries[f];
    const owner = recorded.find((r) => Object.prototype.hasOwnProperty.call(r.files, f) && r.files[f] === now);
    if (owner) ignored.push({ file: f, owner: owner.task_id, basis: `content recorded by the verified candidate of ${owner.task_id} at ${owner.at}` });
    else violations.push(f);
  }
  return { own, ignored, generated, violations, ok: violations.length === 0 };
}

/** Merge base of two commits in a repository, or null when there is none. */
function mergeBase(cwd, a, b) {
  const r = gitops.git(['merge-base', a, b], { cwd });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Uncommitted (modified, staged or untracked) files in a worktree, sorted. Throws WorkspaceError
 * STATUS_UNAVAILABLE when git status cannot be read (missing directory, not a repository, a
 * denied operation, malformed output): "could not look" is never reported as "clean".
 */
function uncommittedFiles(cwd) {
  try {
    return gitops.dirtyFiles(cwd);
  } catch (e) {
    throw new WorkspaceError('STATUS_UNAVAILABLE', e.message);
  }
}

/**
 * worktreeChanges(worktree, integrationHead, commit) -> {base, files}
 * Files the task's commit changed relative to its merge base with the integration head.
 * Throws WorkspaceError NO_BASE / NO_MERGE_BASE when that base cannot be established.
 */
function worktreeChanges(worktree, integrationHead, commit) {
  if (!integrationHead) throw new WorkspaceError('NO_BASE', 'no integration head was recorded at dispatch');
  const base = mergeBase(worktree, integrationHead, commit);
  if (!base) throw new WorkspaceError('NO_MERGE_BASE', `the candidate ${String(commit).slice(0, 12)} shares no history with the integration head ${String(integrationHead).slice(0, 12)}`);
  return { base, files: gitops.changedFiles(worktree, base, commit) };
}

module.exports = {
  OWNS_WORK, SHARED_WINDOW, AGENT_WORKTREES, DEFAULT_GENERATED, WorkspaceError,
  snapshotIgnore, generatedPolicy, isGenerated, statusAt, ownedWorkSince, recordedCandidates, attributeShared,
  mergeBase, uncommittedFiles, worktreeChanges, relInside,
};
