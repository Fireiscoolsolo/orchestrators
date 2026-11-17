'use strict';
/**
 * gitops - git plumbing, command execution and workspace snapshots.
 * Every git operation here is non-destructive towards user work: no force flags
 * on user branches, no reset --hard, no push. Merges into the user's branch are
 * fast-forward only; conflict-prone merges happen in a dedicated integration worktree.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { code: -1, raw: '', out: '', err: r.error.message };
  return { code: r.status, raw: r.stdout || '', out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function must(cwd, args) {
  const r = git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.err || r.out}`);
  return r.out;
}

/** Commits made by the orchestrator use the repo identity when one is configured. */
function identity(cwd) {
  const has = (k) => git(cwd, ['config', '--get', k]).out !== '';
  return has('user.name') && has('user.email') ? [] : ['-c', 'user.name=fable-orchestrator', '-c', 'user.email=fable-orchestrator@localhost'];
}

const available = () => git(process.cwd(), ['--version']).code === 0;

function toplevel(dir) {
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  return r.code === 0 && r.out ? path.resolve(r.out) : null;
}

function parseStatus(raw) {
  return raw.split('\n').filter((l) => l.length > 3).map((l) => {
    let p = l.slice(3).replace(/\r$/, '');
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    return p.replace(/^"|"$/g, '');
  });
}

const dirtyFiles = (dir) => parseStatus(git(dir, ['status', '--porcelain']).raw);

function inspect(root) {
  if (git(root, ['rev-parse', '--is-inside-work-tree']).out !== 'true') return { enabled: false, reason: 'not a git repository' };
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (head.code !== 0 || !head.out) return { enabled: false, reason: 'repository has no commits yet' };
  return {
    enabled: true,
    base_sha: head.out,
    base_branch: git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).out || null,
    dirty: dirtyFiles(root),
  };
}

const revParse = (cwd, ref) => {
  const r = git(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  return r.code === 0 && r.out ? r.out : null;
};
const isAncestor = (cwd, a, b) => git(cwd, ['merge-base', '--is-ancestor', a, b]).code === 0;
const branchExists = (cwd, name) => git(cwd, ['show-ref', '--verify', '-q', `refs/heads/${name}`]).code === 0;

/** Files changed on `commit` since it diverged from `base`. */
function changedFiles(cwd, base, commit) {
  const r = git(cwd, ['diff', '--name-only', `${base}...${commit}`]);
  if (r.code !== 0) throw new Error(`git diff failed: ${r.err}`);
  return r.out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function worktreeAdd(root, dir, opts) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const args = ['worktree', 'add'];
  if (opts.detach) args.push('--detach', dir, opts.start);
  else args.push('-b', opts.branch, dir, opts.start);
  must(root, args);
  return dir;
}

function worktreeRemove(root, dir, force) {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(dir);
  const r = git(root, args);
  return { ok: r.code === 0, message: r.err || r.out };
}

function isWorktree(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  const top = toplevel(dir);
  if (!top) return false;
  const real = (p) => { try { return fs.realpathSync.native(p); } catch (e) { return path.resolve(p); } };
  return real(top).toLowerCase() === real(dir).toLowerCase();
}

/** Commit whatever the worker left uncommitted in its own worktree. Returns the new HEAD or null when clean. */
function autoCommit(dir, message) {
  if (!dirtyFiles(dir).length) return null;
  must(dir, ['add', '-A']);
  must(dir, identity(dir).concat(['commit', '-m', message]));
  return must(dir, ['rev-parse', 'HEAD']);
}

const mergeInProgress = (dir) => git(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code === 0;

function mergeAbort(dir) {
  if (mergeInProgress(dir)) git(dir, ['merge', '--abort']);
}

/** Merge without committing so checks can run on the merged tree first. */
function mergeNoCommit(dir, commit) {
  const r = git(dir, identity(dir).concat(['merge', '--no-ff', '--no-commit', commit]));
  if (r.code === 0) return { ok: true, noop: !mergeInProgress(dir), output: r.out };
  const conflicts = git(dir, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
  return { ok: false, conflicts, output: (r.out + '\n' + r.err).trim() };
}

function mergeCommit(dir, message) {
  must(dir, identity(dir).concat(['commit', '--no-edit', '-m', message]));
  return must(dir, ['rev-parse', 'HEAD']);
}

/** Fast-forward the user's checkout. Git refuses rather than overwrite local modifications. */
function fastForward(root, ref) {
  const r = git(root, ['merge', '--ff-only', ref]);
  return { ok: r.code === 0, output: (r.out + '\n' + r.err).trim() };
}

function branchDeleteMerged(root, name) {
  const r = git(root, ['branch', '-d', name]);
  return { ok: r.code === 0, message: r.err || r.out };
}

// ---------------------------------------------------------------- commands

let shellCache;
/** Verification commands run under bash when it exists (Git Bash on Windows), matching the Bash tool. */
function findShell() {
  if (shellCache !== undefined) return shellCache;
  if (process.platform !== 'win32') return (shellCache = { file: '/bin/sh', args: ['-c'], name: 'sh' });
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH];
  const exec = git(process.cwd(), ['--exec-path']);
  if (exec.code === 0 && exec.out) {
    const gitRoot = path.resolve(exec.out, '..', '..', '..');
    candidates.push(path.join(gitRoot, 'bin', 'bash.exe'), path.join(gitRoot, 'usr', 'bin', 'bash.exe'));
  }
  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe');
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return (shellCache = { file: c, args: ['-c'], name: 'bash' });
  }
  return (shellCache = null);
}

function runCommand(cmd, cwd, timeoutMs) {
  const started = Date.now();
  const sh = findShell();
  const opts = {
    cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { CI: process.env.CI || '1' }),
  };
  const r = sh ? spawnSync(sh.file, sh.args.concat(cmd), opts) : spawnSync(cmd, Object.assign({ shell: true }, opts));
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  return {
    cmd, cwd,
    shell: sh ? sh.name : 'system',
    exit_code: timedOut ? null : r.status === null || r.status === undefined ? -1 : r.status,
    timed_out: timedOut,
    error: r.error && !timedOut ? r.error.message : null,
    duration_ms: Date.now() - started,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

// --------------------------------------------------------------- snapshots

const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', '.cache']);

/** Size+mtime fingerprint of the project tree, used for scope checks when git is unavailable. */
function fsSnapshot(root, limit) {
  const max = limit || 20000;
  const files = {};
  let count = 0;
  let truncated = false;
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (truncated) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        if (++count > max) { truncated = true; return; }
        try {
          const st = fs.statSync(path.join(dir, e.name));
          files[r] = `${st.size}:${Math.round(st.mtimeMs)}`;
        } catch (err) { /* file vanished mid-walk */ }
      }
    }
  };
  walk(root, '');
  return { files, truncated };
}

function snapshotDiff(before, after) {
  const changed = [];
  for (const k of new Set(Object.keys(before).concat(Object.keys(after)))) {
    if (before[k] !== after[k]) changed.push(k);
  }
  return changed.sort();
}

module.exports = {
  git, must, available, toplevel, inspect, dirtyFiles, revParse, isAncestor, branchExists, changedFiles,
  worktreeAdd, worktreeRemove, isWorktree, autoCommit, mergeInProgress, mergeAbort, mergeNoCommit, mergeCommit,
  fastForward, branchDeleteMerged, findShell, runCommand, fsSnapshot, snapshotDiff,
};
