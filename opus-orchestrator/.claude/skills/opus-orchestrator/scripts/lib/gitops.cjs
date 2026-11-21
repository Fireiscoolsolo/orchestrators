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

  info.dirty = dirtyFiles(projectDir);
  return info;
}

function dirtyFiles(cwd) {
  const st = git(['status', '--porcelain', '-z', '--untracked-files=all'], { cwd });
  if (st.code !== 0) return [];
  const parts = st.stdout.split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const x = e[0];
    out.push(e.slice(3));
    if (x === 'R' || x === 'C') i++; // next entry is the original path
  }
  return out;
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

function snapshot(projectDir, opts) {
  const ignore = (opts && opts.ignore) || DEFAULT_IGNORE;
  const out = {};
  const root = path.resolve(projectDir);
  if (!fs.existsSync(root)) return out;
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (isIgnored(r, ent.name, ignore)) continue;
      const full = path.join(abs, ent.name);
      if (ent.isDirectory()) {
        walk(full, r);
      } else {
        let st;
        try {
          st = fs.lstatSync(full);
        } catch (_) {
          continue;
        }
        out[r] = st.size + ':' + st.mtimeMs;
      }
    }
  };
  walk(root, '');
  return out;
}

function diffSnapshot(before, after) {
  const b = before || {};
  const a = after || {};
  const changed = new Set();
  for (const k of Object.keys(a)) if (!(k in b) || b[k] !== a[k]) changed.add(k);
  for (const k of Object.keys(b)) if (!(k in a)) changed.add(k);
  return Array.from(changed).sort();
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
  diffSnapshot,
};
