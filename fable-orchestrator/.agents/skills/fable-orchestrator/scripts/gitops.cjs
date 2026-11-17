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
const crypto = require('crypto');
const { dangerousCommand } = require('./validate.cjs');

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
  return splitPaths(raw).map((record) => record.slice(3));
}

const splitPaths = (raw) => {
  if (!raw) return [];
  if (!raw.endsWith('\0') || raw.includes('\uFFFD')) throw new Error('Git path output is incomplete or cannot be decoded safely');
  return raw.slice(0, -1).split('\0');
};

function dirtyFiles(dir) {
  const r = git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=none']);
  if (r.code !== 0) throw new Error(`git status failed: ${r.err}`);
  return parseStatus(r.raw);
}

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
  const r = git(cwd, ['diff', '--name-only', '-z', '--no-renames', '--ignore-submodules=none', `${base}...${commit}`, '--']);
  if (r.code !== 0) throw new Error(`git diff failed: ${r.err}`);
  return splitPaths(r.raw);
}

const currentBranch = (dir) => git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']).out || null;
const candidate = (dir, ref) => {
  const commit = revParse(dir, ref);
  if (!commit) throw new Error(`Unable to resolve candidate commit ${ref}`);
  const tree = must(dir, ['rev-parse', '--verify', `${commit}^{tree}`]);
  return { commit, tree };
};

function samePath(a, b) {
  const normalize = (p) => {
    let resolved = path.resolve(p);
    try { resolved = fs.realpathSync.native(resolved); } catch (e) { /* compare missing paths lexically */ }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

function repository(dir) {
  const r = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return r.code === 0 && r.out ? fs.realpathSync.native(r.out) : null;
}

function registeredWorktrees(dir) {
  const r = git(dir, ['worktree', 'list', '--porcelain', '-z']);
  if (r.code !== 0) throw new Error(`git worktree list failed: ${r.err}`);
  return splitPaths(r.raw).filter((s) => s.startsWith('worktree ')).map((s) => s.slice(9));
}

function worktreeAdd(root, dir, opts) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const args = ['worktree', 'add'];
  if (opts.detach) args.push('--detach', dir, opts.start);
  else args.push('-b', opts.branch, dir, opts.start);
  must(root, args);
  return dir;
}

function worktreeRemove(root, dir) {
  const r = git(root, ['worktree', 'remove', dir]);
  return { ok: r.code === 0, message: r.err || r.out };
}

function isWorktree(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  const top = toplevel(dir);
  if (!top) return false;
  return samePath(top, dir);
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
  const refusal = dangerousCommand(cmd);
  if (refusal) return { cmd, cwd, shell: null, exit_code: -1, timed_out: false,
    error: `command refused: ${refusal}`, duration_ms: 0, stdout: '', stderr: '' };
  const sh = findShell();
  const allowed = new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TMP','TEMP','TMPDIR','HOME','USERPROFILE',
    'HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','PROGRAMFILES','PROGRAMFILES(X86)','LANG','LC_ALL','TZ']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  env.CI = '1';
  const opts = {
    cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env,
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

const RUNTIME_DIRS = new Set(['.claude/fable-orchestrator', '.fable-inbox']);

/** Fingerprint files without following symlinks in shared workspaces. */
function fsSnapshot(root, limit) {
  const max = limit || 20000;
  const files = Object.create(null);
  let count = 0;
  let truncated = false;
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { truncated = true; return; }
    for (const e of entries) {
      if (truncated) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name !== '.git' && !RUNTIME_DIRS.has(r)) walk(path.join(dir, e.name), r);
      } else {
        if (++count > max) { truncated = true; return; }
        try {
          const file = path.join(dir, e.name);
          if (e.isSymbolicLink()) files[r] = `link:${fs.readlinkSync(file)}`;
          else if (e.isFile()) files[r] = `${fs.lstatSync(file).mode}:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
          else { truncated = true; return; }
        } catch (err) { truncated = true; return; }
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
  currentBranch, candidate, samePath, repository, registeredWorktrees,
  worktreeAdd, worktreeRemove, isWorktree, mergeInProgress, mergeAbort, mergeNoCommit, mergeCommit,
  fastForward, branchDeleteMerged, findShell, runCommand, fsSnapshot, snapshotDiff,
};
