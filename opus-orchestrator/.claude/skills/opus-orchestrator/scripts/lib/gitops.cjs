'use strict';
// gitops.cjs: non-destructive git helpers and shared-workspace snapshots.
// Only `git` is spawned (no shell). Destructive git operations are refused before anything runs.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

class GitError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    if (details) this.details = details;
  }
}

const DEFAULT_IGNORE = ['.git', 'node_modules', '.claude/opus-orchestrator', '.opus-inbox'];

// ---------------------------------------------------------------------------
// Forbidden-argument guard

// Returns a reason string when the arguments describe a forbidden operation, else null.
function forbiddenReason(args) {
  let sub = null;
  const tokens = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (sub === null) {
      if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') {
        i++; // the value belongs to the global option
        continue;
      }
      if (a.startsWith('-')) {
        tokens.push(a);
        continue;
      }
      sub = a;
      continue;
    }
    if (a === '-m' || a === '--message') {
      i++; // free text, not a flag
      continue;
    }
    tokens.push(a);
  }

  for (const t of tokens) {
    if (t === '-f' || t.startsWith('--force')) return 'force is not allowed (' + t + ')';
    if (/^-[A-Za-z]+$/.test(t) && t.includes('f')) return 'force is not allowed (' + t + ')';
  }
  if (sub === 'push') return 'git push is not allowed';
  if (sub === 'clean') return 'git clean is not allowed';
  if (sub === 'reset' && tokens.includes('--hard')) return 'git reset --hard is not allowed';
  if (sub === 'checkout' && tokens.includes('--')) return 'git checkout -- is not allowed';
  if (sub === 'branch' && tokens.some((t) => t === '-D' || (/^-[A-Za-z]+$/.test(t) && t.includes('D')))) {
    return 'git branch -D is not allowed';
  }
  return null;
}

// git(args, {cwd}) -> {code, stdout, stderr}
function git(args, opts) {
  if (!Array.isArray(args)) throw new GitError('BAD_ARGS', 'git() needs an array of arguments');
  const reason = forbiddenReason(args);
  if (reason) throw new GitError('FORBIDDEN', reason + ': git ' + args.join(' '));
  const o = opts || {};
  const res = spawnSync('git', args.map(String), {
    cwd: o.cwd || process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, {
      GIT_TERMINAL_PROMPT: '0',
      GIT_MERGE_AUTOEDIT: 'no',
      GIT_EDITOR: 'true',
    }),
  });
  if (res.error) {
    // Missing cwd and a missing git binary both land here.
    if (res.error.code === 'ENOENT' && o.cwd && !fs.existsSync(o.cwd)) {
      return { code: -1, stdout: '', stderr: 'directory not found: ' + o.cwd };
    }
    throw new GitError('SPAWN_FAILED', 'could not run git: ' + res.error.message);
  }
  return {
    code: res.status === null ? -1 : res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

// Runs git and throws GitError COMMAND_FAILED on a non-zero exit.
function must(args, cwd) {
  const r = git(args, { cwd });
  if (r.code !== 0) {
    throw new GitError(
      'COMMAND_FAILED',
      'git ' + args.join(' ') + ' failed (' + r.code + '): ' + (r.stderr.trim() || r.stdout.trim()),
      { code: r.code, stdout: r.stdout, stderr: r.stderr }
    );
  }
  return r;
}

function lines(text) {
  return text.split(/\r?\n/).filter((l) => l.length > 0);
}

function normPath(p) {
  const abs = path.resolve(p);
  let real;
  try {
    real = fs.realpathSync.native(abs);
  } catch (_) {
    try {
      real = path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs));
    } catch (_e) {
      real = abs;
    }
  }
  real = real.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

// ---------------------------------------------------------------------------
// Inspection and strategy

function inspect(projectDir) {
  const info = { is_repo: false, has_commits: false, branch: null, head: null, dirty: [] };
  if (!projectDir || !fs.existsSync(projectDir)) return info;
  const inside = git(['rev-parse', '--is-inside-work-tree'], { cwd: projectDir });
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return info;
  info.is_repo = true;

  const head = git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: projectDir });
  if (head.code === 0) {
    info.has_commits = true;
    info.head = head.stdout.trim();
  }
  const br = git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: projectDir });
  if (br.code === 0 && br.stdout.trim()) info.branch = br.stdout.trim();

  try {
    info.dirty = dirtyFiles(projectDir);
  } catch (e) {
    info.dirty = [];
    info.dirty_error = e.message;
  }
  return info;
}

const STATUS_CODES = ' MADRCUT?!';

/**
 * Parses `git status --porcelain -z` output. Throws GitError STATUS_MALFORMED for anything that
 * is not a well-formed entry, so a truncated or unexpected output is never read as "clean".
 * Returns [{x, y, path, orig}] (orig is the source of a rename or copy).
 */
function parseStatusZ(stdout) {
  if (typeof stdout !== 'string') throw new GitError('STATUS_MALFORMED', 'git status produced no text output');
  if (stdout !== '' && !stdout.endsWith('\0')) throw new GitError('STATUS_MALFORMED', 'git status output is truncated (no final NUL)');
  const parts = stdout.split('\0');
  parts.pop(); // after the final NUL
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4 || e[2] !== ' ' || !STATUS_CODES.includes(e[0]) || !STATUS_CODES.includes(e[1]) || (e[0] === ' ' && e[1] === ' ')) {
      throw new GitError('STATUS_MALFORMED', `unexpected git status entry ${JSON.stringify(e.slice(0, 80))}`);
    }
    const entry = { x: e[0], y: e[1], path: e.slice(3), orig: null };
    if (e[0] === 'R' || e[0] === 'C') {
      if (i + 1 >= parts.length || !parts[i + 1]) throw new GitError('STATUS_MALFORMED', `rename entry without its source path: ${JSON.stringify(e.slice(0, 80))}`);
      entry.orig = parts[++i];
    }
    out.push(entry);
  }
  return out;
}

/**
 * statusEntries(cwd) -> entries of `git status --porcelain -z --untracked-files=all`.
 * Throws GitError (STATUS_FAILED, STATUS_MALFORMED) instead of returning an empty list when the
 * status cannot be read: a missing directory, a directory that is not a work tree, a denied
 * operation or malformed output all fail closed.
 */
function statusEntries(cwd, opts) {
  if (!cwd || !fs.existsSync(cwd)) throw new GitError('STATUS_FAILED', `cannot read git status: directory not found: ${cwd}`);
  const args = ['status', '--porcelain', '-z', '--untracked-files=all'];
  if (opts && opts.ignored) args.push('--ignored=matching');
  const r = git(args, { cwd });
  if (r.code !== 0) throw new GitError('STATUS_FAILED', `git status failed in ${cwd} (exit ${r.code}): ${(r.stderr || r.stdout).trim() || 'no message'}`);
  return parseStatusZ(r.stdout);
}

/** Modified, staged or untracked paths (sorted). Throws when the status cannot be read. */
function dirtyFiles(cwd) {
  return statusEntries(cwd).filter((e) => e.x !== '!').map((e) => e.path).sort();
}

/** Full sha of a revision, or null. */
function revParse(cwd, rev) {
  const r = git(['rev-parse', '--verify', '-q', `${rev}^{commit}`], { cwd });
  return r.code === 0 && /^[0-9a-f]{40,64}$/.test(r.stdout.trim()) ? r.stdout.trim() : null;
}

/** Tree id of a commit, or null. */
function treeOf(cwd, commit) {
  const r = git(['rev-parse', '--verify', '-q', `${commit}^{tree}`], { cwd });
  return r.code === 0 && /^[0-9a-f]{40,64}$/.test(r.stdout.trim()) ? r.stdout.trim() : null;
}

function isAncestor(cwd, a, b) {
  return git(['merge-base', '--is-ancestor', a, b], { cwd }).code === 0;
}

/** Absolute git common directory of a work tree (shared by all worktrees of one repository), or null. */
function commonDir(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const r = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  return r.code === 0 && r.stdout.trim() ? normPath(r.stdout.trim()) : null;
}

/** Top-level directory of the work tree containing cwd, or null. */
function topLevel(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const r = git(['rev-parse', '--show-toplevel'], { cwd });
  return r.code === 0 && r.stdout.trim() ? normPath(r.stdout.trim()) : null;
}

/** Git operations left half done in a work tree (merge, rebase, cherry-pick, revert, bisect). */
function operationsInProgress(cwd) {
  const found = [];
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']) {
    const r = git(['rev-parse', '--git-path', name], { cwd });
    if (r.code !== 0) throw new GitError('STATUS_FAILED', `cannot inspect ${cwd} for an unfinished ${name}: ${r.stderr.trim()}`);
    const p = path.resolve(cwd, r.stdout.trim());
    if (fs.existsSync(p)) found.push(name);
  }
  return found;
}

/** Worktrees of the repository: [{dir, head, branch, detached}]. Throws when they cannot be listed. */
function listWorktrees(projectDir) {
  const r = git(['worktree', 'list', '--porcelain'], { cwd: projectDir });
  if (r.code !== 0) throw new GitError('COMMAND_FAILED', `git worktree list failed: ${r.stderr.trim()}`);
  const out = [];
  let cur = null;
  for (const l of r.stdout.split(/\r?\n/)) {
    if (l.startsWith('worktree ')) {
      cur = { dir: l.slice(9), norm: normPath(l.slice(9)), head: null, branch: null, detached: false };
      out.push(cur);
    } else if (cur && l.startsWith('HEAD ')) cur.head = l.slice(5).trim();
    else if (cur && l.startsWith('branch ')) cur.branch = l.slice(7).replace(/^refs\/heads\//, '');
    else if (cur && l === 'detached') cur.detached = true;
  }
  return out;
}

/** Creates a detached worktree at `commit` (used for clean verification and integration checkouts). */
function addDetachedWorktree(projectDir, dir, commit) {
  must(['worktree', 'add', '--detach', dir, commit], projectDir);
  return dir;
}

/** Unified diff between two commits, without external diff programs or text conversion filters. */
function diffText(cwd, base, commit) {
  return must(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', base, commit], cwd).stdout;
}

/**
 * Hash of the repository's configuration, hooks and info/attributes in the common git directory.
 * A worker that edits them can make later git commands of oo run arbitrary programs (hooks,
 * filters, diff drivers), so oo records this at init and refuses to run git operations on
 * candidate work when it changed.
 */
function repoGuard(cwd) {
  const dir = commonDir(cwd);
  if (!dir) return null;
  const h = require('node:crypto').createHash('sha256');
  const walk = (abs, rel) => {
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw new GitError('GUARD_UNREADABLE', `cannot read ${abs}: ${e.code}`);
    }
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(abs).sort()) walk(path.join(abs, n), `${rel}/${n}`);
    } else if (st.isSymbolicLink()) {
      h.update(`${rel}\0link:${fs.readlinkSync(abs)}\0`);
    } else {
      h.update(`${rel}\0${hashFile(abs)}\0`);
    }
  };
  // info/exclude too: a pattern added there would hide a command's untracked writes from git status.
  for (const part of ['config', 'config.worktree', 'hooks', 'info/attributes', 'info/exclude']) walk(path.join(dir, ...part.split('/')), part);
  return 'sha256:' + h.digest('hex');
}

/** git version as [major, minor, patch], or null. */
function gitVersion() {
  try {
    const r = git(['--version'], {});
    const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(r.stdout);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
  } catch (_) {
    return null;
  }
}

function chooseStrategy(info, isolationSetting) {
  if (info && info.is_repo && info.has_commits && (isolationSetting === 'auto' || isolationSetting === 'worktree')) {
    return 'worktree';
  }
  return 'shared';
}

// ---------------------------------------------------------------------------
// Integration worktree

function integrationBranch(runId) {
  return 'opus-orch/' + runId + '/integration';
}

function worktreeForBranch(projectDir, branch) {
  const r = git(['worktree', 'list', '--porcelain'], { cwd: projectDir });
  if (r.code !== 0) return null;
  let cur = null;
  for (const l of r.stdout.split(/\r?\n/)) {
    if (l.startsWith('worktree ')) cur = { dir: l.slice(9), branch: null };
    else if (l.startsWith('branch ') && cur) {
      cur.branch = l.slice(7).replace(/^refs\/heads\//, '');
      if (cur.branch === branch) return cur.dir;
    }
  }
  return null;
}

function worktreeRegistered(projectDir, dir) {
  const r = git(['worktree', 'list', '--porcelain'], { cwd: projectDir });
  if (r.code !== 0) return false;
  const want = normPath(dir);
  return r.stdout.split(/\r?\n/).some((l) => l.startsWith('worktree ') && normPath(l.slice(9)) === want);
}

function branchBase(projectDir, branch) {
  const rl = git(['reflog', 'show', '--format=%H', branch], { cwd: projectDir });
  if (rl.code === 0) {
    const ls = lines(rl.stdout);
    if (ls.length) return ls[ls.length - 1].trim();
  }
  const mb = git(['merge-base', branch, 'HEAD'], { cwd: projectDir });
  if (mb.code === 0 && mb.stdout.trim()) return mb.stdout.trim();
  return must(['rev-parse', branch], projectDir).stdout.trim();
}

function ensureIntegration(projectDir, runId, worktreeDir) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new GitError('BAD_ARGS', 'invalid run id for a branch name: ' + runId);
  }
  if (!worktreeDir) throw new GitError('BAD_ARGS', 'worktreeDir is required');
  const branch = integrationBranch(runId);
  const exists = git(['rev-parse', '--verify', '-q', 'refs/heads/' + branch], { cwd: projectDir }).code === 0;
  const registered = worktreeRegistered(projectDir, worktreeDir);

  if (registered && fs.existsSync(worktreeDir)) {
    const cur = git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: worktreeDir });
    if (cur.code === 0 && cur.stdout.trim() === branch) {
      return { branch, worktree: worktreeDir, base: branchBase(projectDir, branch) };
    }
    throw new GitError('WORKTREE_CONFLICT', 'worktree ' + worktreeDir + ' exists but is not on ' + branch);
  }
  if (!registered && fs.existsSync(worktreeDir) && fs.readdirSync(worktreeDir).length > 0) {
    throw new GitError('WORKTREE_CONFLICT', 'directory exists and is not a worktree: ' + worktreeDir);
  }
  if (!registered) git(['worktree', 'prune'], { cwd: projectDir }); // forget stale entries

  if (exists) {
    const elsewhere = worktreeForBranch(projectDir, branch);
    if (elsewhere) {
      throw new GitError('WORKTREE_CONFLICT', branch + ' is already checked out at ' + elsewhere);
    }
    must(['worktree', 'add', worktreeDir, branch], projectDir);
  } else {
    must(['worktree', 'add', '-b', branch, worktreeDir, 'HEAD'], projectDir);
  }
  return { branch, worktree: worktreeDir, base: branchBase(projectDir, branch) };
}

// ---------------------------------------------------------------------------
// Commits and merges

function commitAll(cwd, message) {
  must(['add', '-A'], cwd);
  const st = must(['status', '--porcelain'], cwd);
  if (!st.stdout.trim()) return null;
  must(['commit', '-m', String(message)], cwd);
  return must(['rev-parse', 'HEAD'], cwd).stdout.trim();
}

function changedFiles(cwd, baseRef, headRef) {
  const r = must(['diff', '--name-only', '--no-renames', '-z', baseRef, headRef || 'HEAD'], cwd);
  return r.stdout.split('\0').filter(Boolean).sort();
}

function conflictedFiles(cwd) {
  const r = git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd });
  return r.stdout.split('\0').filter(Boolean).sort();
}

function mergeInProgress(cwd) {
  return git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd }).code === 0;
}

function mergeNoCommit(cwd, commit) {
  const r = git(['merge', '--no-ff', '--no-commit', String(commit)], { cwd });
  if (r.code === 0) return { ok: true, conflict: false, files: [] };
  const files = conflictedFiles(cwd);
  if (files.length > 0 || (mergeInProgress(cwd) && /conflict/i.test(r.stdout + r.stderr))) {
    return { ok: false, conflict: true, files };
  }
  throw new GitError('COMMAND_FAILED', 'git merge failed (' + r.code + '): ' + (r.stderr.trim() || r.stdout.trim()), {
    code: r.code,
    stdout: r.stdout,
    stderr: r.stderr,
  });
}

// Completes a merge started by mergeNoCommit. When mergeNoCommit found nothing to merge (the commit
// is already contained), there is no merge to complete and the current HEAD is returned.
function commitMerge(cwd, message) {
  if (!mergeInProgress(cwd)) return must(['rev-parse', 'HEAD'], cwd).stdout.trim();
  must(['commit', '-m', String(message)], cwd);
  return must(['rev-parse', 'HEAD'], cwd).stdout.trim();
}

// Returns true when a merge was aborted, false when none was in progress.
function abortMerge(cwd) {
  if (!mergeInProgress(cwd)) return false;
  must(['merge', '--abort'], cwd);
  return true;
}

function fastForward(projectDir, branch) {
  const cur = git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: projectDir });
  if (cur.code !== 0) return { ok: false, reason: 'the project checkout is on a detached HEAD or is not a repository' };
  if (git(['rev-parse', '--verify', '-q', 'refs/heads/' + branch], { cwd: projectDir }).code !== 0) {
    return { ok: false, reason: 'branch ' + branch + ' does not exist' };
  }
  const isAncestor = (a, b) => git(['merge-base', '--is-ancestor', a, b], { cwd: projectDir }).code === 0;
  if (isAncestor(branch, 'HEAD')) return { ok: true, reason: null }; // nothing to move
  if (!isAncestor('HEAD', branch)) {
    return {
      ok: false,
      reason: cur.stdout.trim() + ' and ' + branch + ' have diverged; a fast-forward is not possible',
    };
  }
  const r = git(['merge', '--ff-only', branch], { cwd: projectDir });
  if (r.code !== 0) return { ok: false, reason: (r.stderr.trim() || r.stdout.trim() || 'fast-forward failed') };
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Cleanup (never forced)

function removeWorktree(projectDir, dir) {
  if (!fs.existsSync(dir)) {
    git(['worktree', 'prune'], { cwd: projectDir });
    return { ok: true, reason: 'directory was already gone' };
  }
  if (!worktreeRegistered(projectDir, dir)) return { ok: false, reason: 'not a worktree of this repository: ' + dir };
  const st = git(['status', '--porcelain', '--untracked-files=all'], { cwd: dir });
  if (st.code !== 0) return { ok: false, reason: 'could not read worktree status: ' + st.stderr.trim() };
  if (st.stdout.trim()) {
    return { ok: false, reason: 'worktree has uncommitted changes or a merge in progress: ' + dir };
  }
  const r = git(['worktree', 'remove', dir], { cwd: projectDir });
  if (r.code !== 0) return { ok: false, reason: r.stderr.trim() || r.stdout.trim() || 'worktree remove failed' };
  return { ok: true, reason: null };
}

function deleteMergedBranch(projectDir, branch) {
  const r = git(['branch', '-d', branch], { cwd: projectDir });
  if (r.code !== 0) return { ok: false, reason: r.stderr.trim() || r.stdout.trim() || 'branch -d failed' };
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Shared-workspace snapshots (no git)

function isIgnored(rel, name, ignore) {
  for (const raw of ignore) {
    const ig = String(raw).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!ig) continue;
    if (ig.includes('/')) {
      if (rel === ig || rel.startsWith(ig + '/')) return true;
    } else if (name === ig) {
      return true; // a bare name matches at any depth
    }
  }
  return false;
}

// A snapshot is security evidence, so it is explicit about what it could not see:
//   {version: 2, root, taken_at, complete, errors: [{path, code}], files: {rel: entry}, odd: [rel]}
// entry is 'sha256:<hex>' for a regular file (its content hash), 'link:<target>' for a symbolic
// link or junction (never followed, so a link cannot pull files from outside the root into the
// evidence), or 'special:<kind>' for a socket, FIFO or device. A directory or file that cannot
// be read makes the snapshot incomplete instead of being skipped, and a missing root is an
// incomplete snapshot with the error ROOT_MISSING. `odd` lists paths whose names cannot be
// matched against a scope reliably (a backslash or a control character in a name on a system
// where those are legal): a change to one of them is always treated as a scope violation.
// Inside a top-level `.git` directory only `config` and `hooks/` are recorded, the two places
// where a change makes later git commands run something else.
const SNAPSHOT_VERSION = 2;
const HASH_CHUNK = 1024 * 1024;

function hashFile(file) {
  const h = require('node:crypto').createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(HASH_CHUNK);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, HASH_CHUNK, null);
      if (n <= 0) break;
      h.update(n === HASH_CHUNK ? buf : buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return 'sha256:' + h.digest('hex');
}

function oddName(name) {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(name) || (process.platform !== 'win32' && name.includes('\\'));
}

function snapshot(projectDir, opts) {
  const ignore = (opts && opts.ignore) || DEFAULT_IGNORE;
  const root = path.resolve(projectDir);
  const snap = { version: SNAPSHOT_VERSION, root: root.split(path.sep).join('/'), taken_at: new Date().toISOString(), complete: true, errors: [], files: {}, odd: [] };
  const fail = (rel, code) => {
    snap.complete = false;
    snap.errors.push({ path: rel || '.', code: code || 'ERROR' });
  };
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch (e) {
    fail('', e.code === 'ENOENT' ? 'ROOT_MISSING' : (e.code || 'ERROR'));
    return snap;
  }
  if (!rootStat.isDirectory()) {
    fail('', 'ROOT_NOT_A_DIRECTORY');
    return snap;
  }
  const record = (full, rel, name) => {
    if (oddName(name)) snap.odd.push(rel);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch (e) {
      if (e.code === 'ENOENT') return undefined; // removed while walking: absent from this snapshot
      fail(rel, e.code);
      return undefined;
    }
    if (st.isSymbolicLink()) {
      try {
        snap.files[rel] = 'link:' + fs.readlinkSync(full).split(path.sep).join('/');
      } catch (e) {
        fail(rel, e.code);
      }
      return undefined;
    }
    if (st.isFile()) {
      try {
        snap.files[rel] = hashFile(full);
      } catch (e) {
        if (e.code !== 'ENOENT') fail(rel, e.code);
      }
      return undefined;
    }
    if (st.isDirectory()) return 'dir';
    snap.files[rel] = 'special:' + (st.isFIFO() ? 'fifo' : st.isSocket() ? 'socket' : st.isBlockDevice() ? 'block' : st.isCharacterDevice() ? 'char' : 'other');
    return undefined;
  };
  const walk = (abs, rel, onlyGit) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      if (e.code !== 'ENOENT' || !rel) fail(rel, e.code);
      return;
    }
    for (const ent of entries) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      const full = path.join(abs, ent.name);
      if (!rel && ent.name === '.git' && ent.isDirectory()) {
        // Only the configuration and hooks of the repository are evidence.
        for (const sub of ['config', 'hooks']) {
          const subFull = path.join(full, sub);
          if (!fs.existsSync(subFull)) continue;
          if (record(subFull, '.git/' + sub, sub) === 'dir') walk(subFull, '.git/' + sub, true);
        }
        continue;
      }
      if (!onlyGit && isIgnored(r, ent.name, ignore)) continue;
      if (record(full, r, ent.name) === 'dir') walk(full, r, onlyGit);
    }
  };
  walk(root, '', false);
  snap.odd.sort();
  return snap;
}

function isSnapshot(s) {
  return !!(s && typeof s === 'object' && s.version === SNAPSHOT_VERSION && s.files && typeof s.files === 'object' && Array.isArray(s.errors));
}

/**
 * compareSnapshots(before, after) -> {ok, problems, changed, added, modified, deleted}
 * ok is false (and the lists must not be trusted) when either side is not a version-2 snapshot,
 * is incomplete, or the two were taken of different roots.
 */
function compareSnapshots(before, after) {
  const problems = [];
  for (const [name, s] of [['baseline', before], ['current', after]]) {
    if (!isSnapshot(s)) problems.push(`the ${name} snapshot is missing or in an old format (it holds no content hashes)`);
    else if (!s.complete) problems.push(`the ${name} snapshot is incomplete: ${s.errors.map((e) => `${e.path} (${e.code})`).join(', ')}`);
  }
  if (!problems.length && before.root.toLowerCase() !== after.root.toLowerCase()) problems.push(`the snapshots are of different directories (${before.root}, ${after.root})`);
  const added = [];
  const modified = [];
  const deleted = [];
  if (isSnapshot(before) && isSnapshot(after)) {
    const b = before.files;
    const a = after.files;
    for (const k of Object.keys(a)) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) added.push(k);
      else if (b[k] !== a[k]) modified.push(k);
    }
    for (const k of Object.keys(b)) if (!Object.prototype.hasOwnProperty.call(a, k)) deleted.push(k);
  }
  const changed = added.concat(modified, deleted).sort();
  return { ok: problems.length === 0, problems, changed, added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

/** Changed paths between two snapshots (throws SNAPSHOT_INCOMPLETE when the evidence is not complete). */
function diffSnapshot(before, after) {
  const c = compareSnapshots(before, after);
  if (!c.ok) throw new GitError('SNAPSHOT_INCOMPLETE', c.problems.join('; '));
  return c.changed;
}

/** The entries of `rels` in a snapshot: {rel: entry, or null when absent}. */
function pickEntries(snap, rels) {
  const out = {};
  for (const r of rels) out[r] = isSnapshot(snap) && Object.prototype.hasOwnProperty.call(snap.files, r) ? snap.files[r] : null;
  return out;
}

module.exports = {
  GitError,
  DEFAULT_IGNORE,
  git,
  inspect,
  chooseStrategy,
  integrationBranch,
  ensureIntegration,
  commitAll,
  changedFiles,
  mergeNoCommit,
  commitMerge,
  abortMerge,
  fastForward,
  removeWorktree,
  deleteMergedBranch,
  snapshot,
  isSnapshot,
  compareSnapshots,
  diffSnapshot,
  pickEntries,
  hashFile,
  parseStatusZ,
  statusEntries,
  dirtyFiles,
  revParse,
  treeOf,
  isAncestor,
  commonDir,
  topLevel,
  operationsInProgress,
  listWorktrees,
  addDetachedWorktree,
  diffText,
  repoGuard,
  gitVersion,
  normPath,
  SNAPSHOT_VERSION,
};
