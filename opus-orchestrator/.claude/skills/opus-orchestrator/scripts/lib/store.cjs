'use strict';
// store.cjs: atomic persistent run and task store. JSON only, synchronous fs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

// How long a command waits for the state lock. Commands hold the lock only for short state
// transactions; slow work (verification, integration and audit commands) runs outside it.
const LOCK_WAIT_MS = 15000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function resolvePaths(opts) {
  const o = opts || {};
  const projectDir = path.resolve(o.projectDir || process.env.OPUS_ORCH_PROJECT_DIR || process.cwd());
  const stateRoot = path.resolve(
    o.stateDir || process.env.OPUS_ORCH_STATE_DIR || path.join(projectDir, '.claude', 'opus-orchestrator')
  );
  return {
    projectDir,
    stateRoot,
    runsDir: path.join(stateRoot, 'runs'),
    inboxDir: path.join(projectDir, '.opus-inbox'),
    currentFile: path.join(stateRoot, 'current'),
    observationsFile: path.join(stateRoot, 'observations.jsonl'),
    proposalsDir: path.join(stateRoot, 'proposals'),
    contextFile: path.join(stateRoot, 'context.json'),
    configFile: path.join(stateRoot, 'config.yaml'),
  };
}

function ensureState(paths) {
  for (const d of [paths.stateRoot, paths.runsDir, paths.proposalsDir, paths.inboxDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  for (const d of [paths.stateRoot, paths.inboxDir]) {
    const gi = path.join(d, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  }
}

function renameWithRetry(from, to) {
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      lastErr = e;
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') break;
      sleepSync(10 * (i + 1));
    }
  }
  throw lastErr;
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    renameWithRetry(tmp, file);
  } catch (e) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw e;
  }
}

function writeJson(file, obj) {
  atomicWrite(file, JSON.stringify(obj, null, 2) + '\n');
}

function tryParse(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { ok: false, missing: e.code === 'ENOENT' };
  }
}

function readJson(file) {
  const main = tryParse(file);
  if (main.ok) return { value: main.value, recovered: false };
  const bakFile = `${file}.bak`;
  const bak = tryParse(bakFile);
  if (bak.ok) return { value: bak.value, recovered: true };
  if (main.missing && bak.missing) throw new StoreError('MISSING', `file not found: ${file}`);
  throw new StoreError('CORRUPT', `file and backup are unreadable: ${file}`);
}

function newRunId(date) {
  const d = date || new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ymd = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const hms = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${ymd}-${hms}-${crypto.randomBytes(2).toString('hex')}`;
}

const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

function runDir(paths, runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new StoreError('NO_RUN', `invalid run id: ${runId}`);
  }
  return path.join(paths.runsDir, runId);
}

function setCurrent(paths, runId) {
  atomicWrite(paths.currentFile, `${runId}\n`);
}

function createRun(paths, spec) {
  const s = spec || {};
  ensureState(paths);
  const now = new Date().toISOString();
  const run = {
    run_id: newRunId(),
    objective: s.objective || '',
    created_at: now,
    updated_at: now,
    options: s.options || {},
    config: s.config || {},
    workspace: s.workspace || {},
    decisions: [],
    usage: {},
    authorizations: [],
    phase: 'planning',
    delivered: false,
    snapshots: {},
  };
  const dir = runDir(paths, run.run_id);
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  writeJson(path.join(dir, 'run.json'), run);
  atomicWrite(path.join(dir, 'request.md'), `${run.objective}\n`);
  setCurrent(paths, run.run_id);
  return run;
}

function loadRun(paths, runId) {
  let id = runId;
  if (!id) {
    try {
      id = fs.readFileSync(paths.currentFile, 'utf8').trim();
    } catch (_) {
      id = '';
    }
    if (!id) throw new StoreError('NO_RUN', 'no current run');
  }
  const file = path.join(runDir(paths, id), 'run.json');
  try {
    return readJson(file).value;
  } catch (e) {
    if (e.code === 'MISSING') throw new StoreError('NO_RUN', `run not found: ${id}`);
    throw e;
  }
}

function saveRun(paths, run) {
  run.updated_at = new Date().toISOString();
  writeJson(path.join(runDir(paths, run.run_id), 'run.json'), run);
  return run;
}

function listRuns(paths) {
  let names;
  try {
    names = fs.readdirSync(paths.runsDir);
  } catch (_) {
    return [];
  }
  return names
    .filter((n) => RUN_ID_RE.test(n) && fs.existsSync(path.join(paths.runsDir, n, 'run.json')))
    .sort();
}

function safeName(id, what) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith('.')) {
    throw new StoreError('BAD_NAME', `invalid ${what}: ${id}`);
  }
  return id;
}

function taskFile(paths, runId, id) {
  return path.join(runDir(paths, runId), 'tasks', `${safeName(id, 'task id')}.json`);
}

function saveTask(paths, runId, task) {
  if (!task || !task.task_id) throw new StoreError('BAD_TASK', 'task has no task_id');
  writeJson(taskFile(paths, runId, task.task_id), task);
  return task;
}

function loadTask(paths, runId, id) {
  try {
    return readJson(taskFile(paths, runId, id)).value;
  } catch (e) {
    if (e.code === 'MISSING') throw new StoreError('NO_TASK', `task not found: ${id}`);
    throw e;
  }
}

function taskIds(paths, runId) {
  const dir = path.join(runDir(paths, runId), 'tasks');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
}

function listTasks(paths, runId) {
  const tasks = taskIds(paths, runId).map((id) => loadTask(paths, runId, id));
  tasks.sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
  return tasks;
}

function saveSpecText(paths, runId, id, yamlText) {
  atomicWrite(path.join(runDir(paths, runId), 'specs', `${safeName(id, 'task id')}.yaml`), yamlText);
}

function appendEvent(paths, runId, event) {
  const file = path.join(runDir(paths, runId), 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rec = Object.assign({ ts: new Date().toISOString() }, event);
  rec.ts = new Date().toISOString();
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  return rec;
}

function readEvents(paths, runId) {
  let text;
  try {
    text = fs.readFileSync(path.join(runDir(paths, runId), 'events.jsonl'), 'utf8');
  } catch (_) {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (_) { /* skip */ }
  }
  return out;
}

function writeEvidence(paths, runId, name, text) {
  const parts = String(name).split(/[\\/]/);
  parts.forEach((p) => safeName(p, 'evidence name'));
  const file = path.join(runDir(paths, runId), 'evidence', ...parts);
  atomicWrite(file, text);
  const rel = path.relative(paths.projectDir, file);
  return (rel.startsWith('..') || path.isAbsolute(rel) ? file : rel).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// State lock
//
// The lock file holds one owner record {token, pid, host, acquired_at, kind}. The record is
// written completely to a private claim file first and then published with a hard link, so no
// other process ever reads a partly written lock. Rules:
// - Only the holder of the token releases the lock; a release checks the token first.
// - A lock is taken over only when its owner is proven dead: same host and the process id no
//   longer exists (ESRCH). Age never establishes death. A record from another host, a legacy
//   record without token or host, or an unreadable record is never taken over automatically;
//   `node manage_state.cjs lock` shows it and `lock --break` moves it aside after the user has
//   confirmed that its owner stopped.
// - A takeover is itself guarded: the reaper publishes a guard file named after the dead
//   owner's token, re-checks the owner under the guard, and moves the lock aside as evidence
//   (`.lock.reaped-<token>`). A reaper that dies leaves its guard; the next reaper follows a
//   chain of guards named after their predecessors instead of deleting one, so two reapers can
//   never both remove a lock. A process id that the operating system reused after the owner
//   died makes the owner look alive: the lock then waits (and times out) rather than being stolen.

const LOCK_FILE = '.lock';
const TOKEN_RE = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
const held = new Map(); // lock file -> token held by this process

function lockFileOf(paths) {
  return path.join(paths.stateRoot, LOCK_FILE);
}

/** {state: 'missing'|'invalid'|'legacy'|'ok', owner?, raw?} for a lock or guard file. */
function readOwner(file) {
  let text;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return { state: 'invalid', raw: `not a regular file (${st.isDirectory() ? 'directory' : 'other'})` };
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { state: 'missing' };
    return { state: 'invalid', raw: `unreadable: ${e.code || e.message}` };
  }
  let v;
  try {
    v = JSON.parse(text);
  } catch (_) {
    return { state: 'invalid', raw: text.slice(0, 200) };
  }
  if (v && typeof v === 'object' && typeof v.token === 'string' && TOKEN_RE.test(v.token)
    && Number.isInteger(v.pid) && v.pid > 0 && v.pid <= 0x7fffffff && typeof v.host === 'string' && v.host) {
    return { state: 'ok', owner: v };
  }
  if (v && typeof v === 'object' && Number.isInteger(v.pid)) return { state: 'legacy', owner: v };
  return { state: 'invalid', raw: text.slice(0, 200) };
}

/**
 * 'alive' | 'dead' | 'unknown'. Dead only when the owner ran on this host and its process id no
 * longer exists. Another host, a legacy record or any doubt is 'unknown', which is never reaped.
 */
function ownerState(owner) {
  if (!owner || typeof owner !== 'object' || typeof owner.host !== 'string' || !Number.isInteger(owner.pid)) return 'unknown';
  if (owner.host !== os.hostname()) return 'unknown';
  if (owner.pid === process.pid) return 'alive';
  try {
    process.kill(owner.pid, 0);
    return 'alive';
  } catch (e) {
    if (e.code === 'ESRCH') return 'dead';
    if (e.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function sameOwner(a, b) {
  return !!(a && b && a.token === b.token && a.pid === b.pid && a.host === b.host);
}

/**
 * Publishes `record` at `target` only if `target` does not exist. Returns true when published,
 * false when the target exists. The record is complete before anyone can see it.
 */
function publishExclusive(target, record) {
  const claim = `${target}.claim-${record.token}`;
  fs.writeFileSync(claim, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  try {
    try {
      fs.linkSync(claim, target);
      return true;
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      // File systems without hard links: fall back to an exclusive create. A crash between create
      // and write then leaves an unreadable lock, which is never reaped automatically.
      if (!['EPERM', 'ENOTSUP', 'EXDEV', 'EINVAL', 'ENOSYS'].includes(e.code)) throw e;
      let fd;
      try {
        fd = fs.openSync(target, 'wx', 0o600);
      } catch (e2) {
        if (e2.code === 'EEXIST') return false;
        throw e2;
      }
      try {
        fs.writeSync(fd, JSON.stringify(record));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    }
  } finally {
    try { fs.unlinkSync(claim); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function newOwner(kind, extra) {
  return Object.assign({ token: crypto.randomUUID(), pid: process.pid, host: os.hostname(), acquired_at: new Date().toISOString(), kind }, extra || {});
}

function reconcileError(file) {
  return new StoreError('LOCK_RECONCILIATION_REQUIRED',
    `cannot establish the owner of the lock recovery guard ${file}. Stop every oo process of this project, confirm that no owner can still run, then inspect it with node manage_state.cjs lock`);
}

/** Moves the lock of a dead owner aside. Returns true when it did; false to retry the acquisition. */
function reap(lockFile, owner) {
  if (!sameOwner(readOwner(lockFile).owner, owner) || ownerState(owner) !== 'dead') return false;
  const root = `${lockFile}.reap-${owner.token}`;
  let predecessor = null;
  const visited = new Set();
  for (;;) {
    const guard = predecessor ? `${root}-${predecessor}` : root;
    if (visited.has(guard)) throw reconcileError(guard);
    visited.add(guard);
    const record = newOwner('lock-reaper', { lock_token: owner.token, predecessor_token: predecessor });
    const mine = (r) => r.state === 'ok' && sameOwner(r.owner, record) && r.owner.lock_token === owner.token
      && r.owner.predecessor_token === predecessor;
    if (!publishExclusive(guard, record)) {
      const prev = readOwner(guard);
      if (prev.state === 'missing') return false; // its reaper finished meanwhile: retry the lock
      if (prev.state !== 'ok' || prev.owner.kind !== 'lock-reaper' || prev.owner.lock_token !== owner.token
        || prev.owner.predecessor_token !== predecessor) throw reconcileError(guard);
      if (ownerState(prev.owner) !== 'dead') return false; // a live (or unknown) reaper is working
      // Never delete an abandoned guard: its token names the only successor guard, so two
      // reapers that both found it abandoned still cannot both proceed.
      predecessor = prev.owner.token;
      continue;
    }
    try {
      if (!mine(readOwner(guard))) throw reconcileError(guard);
      const cur = readOwner(lockFile);
      if (cur.state !== 'ok' || !sameOwner(cur.owner, owner) || ownerState(cur.owner) !== 'dead') return false;
      renameWithRetry(lockFile, `${lockFile}.reaped-${owner.token}`);
      return true;
    } finally {
      if (mine(readOwner(guard))) fs.unlinkSync(guard);
    }
  }
}

function describeOwner(r) {
  if (!r || r.state === 'missing') return 'no lock';
  if (r.state === 'invalid') return `an unreadable lock record (${r.raw})`;
  const o = r.owner;
  const who = `process ${o.pid}${o.host ? ` on host ${o.host}` : ''}`;
  const since = o.acquired_at ? ` since ${o.acquired_at}` : (typeof o.ts === 'number' ? ` since ${new Date(o.ts).toISOString()}` : '');
  const kind = o.kind ? ` (${o.kind}${o.command ? ` ${o.command}` : ''})` : '';
  if (r.state === 'legacy') return `a legacy lock record without owner token or host: ${who}${since}`;
  return `${who}${kind}${since}, owner ${ownerState(o)}`;
}

/** Acquires the state lock; returns the token. Waits up to opts.waitMs (default LOCK_WAIT_MS). */
function acquireLock(paths, opts) {
  fs.mkdirSync(paths.stateRoot, { recursive: true });
  const lockFile = lockFileOf(paths);
  if (held.has(lockFile)) throw new StoreError('LOCK_REENTRANT', 'this process already holds the state lock (nested state transactions are not supported)');
  const o = opts || {};
  const envWait = Number(process.env.OPUS_ORCH_LOCK_WAIT_MS);
  const waitMs = Number.isFinite(o.waitMs) ? o.waitMs : (Number.isFinite(envWait) && envWait >= 0 ? envWait : LOCK_WAIT_MS);
  const deadline = Date.now() + waitMs;
  const record = newOwner(o.kind || 'oo', o.command ? { command: String(o.command).slice(0, 80) } : null);
  for (;;) {
    if (publishExclusive(lockFile, record)) {
      held.set(lockFile, record.token);
      return record.token;
    }
    const cur = readOwner(lockFile);
    if (cur.state === 'missing') continue; // released between link and read
    if (cur.state === 'ok' && reap(lockFile, cur.owner)) continue;
    if (Date.now() >= deadline) {
      const e = new StoreError('LOCK_TIMEOUT', `could not acquire the state lock: it is held by ${describeOwner(cur)}`);
      e.owner = cur.owner || null;
      e.lockState = cur.state;
      throw e;
    }
    sleepSync(25);
  }
}

/**
 * Releases the lock only when it still carries `token`. Returns true when released; false when
 * the lock is gone or belongs to someone else (it is then left untouched).
 */
function releaseLock(paths, token) {
  const lockFile = lockFileOf(paths);
  if (held.get(lockFile) === token) held.delete(lockFile);
  const cur = readOwner(lockFile);
  if (cur.state !== 'ok' || cur.owner.token !== token) return false;
  fs.unlinkSync(lockFile);
  return true;
}

/** Throws LOCK_LOST unless this process holds the state lock right now. Called before state writes. */
function assertLockHeld(paths) {
  const lockFile = lockFileOf(paths);
  const token = held.get(lockFile);
  const cur = readOwner(lockFile);
  if (!token || cur.state !== 'ok' || cur.owner.token !== token) {
    throw new StoreError('LOCK_LOST', `this process no longer holds the state lock (it is held by ${describeOwner(cur)}); nothing was written`);
  }
}

function withLock(paths, fn, opts) {
  const token = acquireLock(paths, opts);
  let ok = false;
  let value;
  try {
    value = fn();
    ok = true;
  } finally {
    const released = releaseLock(paths, token);
    if (ok && !released) {
      // fn finished, but the lock was taken from us (only possible through a manual break):
      // its writes may have interleaved with another writer's.
      throw new StoreError('LOCK_LOST', 'the state lock was taken from this process while it worked; check the run with oo resume');
    }
  }
  return value;
}

/** Lock inspection for manage_state.cjs: the lock record, its owner state and leftover recovery files. */
function lockInfo(paths) {
  const lockFile = lockFileOf(paths);
  const cur = readOwner(lockFile);
  let extras = [];
  try {
    extras = fs.readdirSync(paths.stateRoot).filter((n) => n.startsWith(`${LOCK_FILE}.`)).sort();
  } catch (_) { /* no state directory */ }
  return {
    file: lockFile, state: cur.state, owner: cur.owner || null, raw: cur.raw || null,
    owner_state: cur.state === 'ok' ? ownerState(cur.owner) : (cur.state === 'missing' ? null : 'unknown'),
    description: describeOwner(cur), recovery_files: extras,
  };
}

/**
 * Moves the current lock aside as `.lock.broken-<token or state>-<time>` after a person has
 * confirmed that its owner stopped. `token` must match the record (or be 'invalid' / 'legacy' for
 * such records), so a lock that changed hands since it was inspected is never broken.
 */
function breakLock(paths, token, opts) {
  const lockFile = lockFileOf(paths);
  const cur = readOwner(lockFile);
  if (cur.state === 'missing') throw new StoreError('NO_LOCK', 'there is no state lock to break');
  const matches = cur.state === 'ok' ? cur.owner.token === token : cur.state === token;
  if (!matches) {
    throw new StoreError('LOCK_MISMATCH', `the lock is held by ${describeOwner(cur)}; --token ${token} does not match it (inspect again with node manage_state.cjs lock)`);
  }
  // A process id can be reused by an unrelated program after the owner died; only a person who
  // checked that the process with that id is not oo can say so (pidReused).
  if (cur.state === 'ok' && ownerState(cur.owner) === 'alive' && !(opts && opts.pidReused === true && cur.owner.pid !== process.pid)) {
    throw new StoreError('LOCK_OWNER_ALIVE', `the lock owner, process ${cur.owner.pid} on this host, is still running; stop it first (if that process id now belongs to a program that is not oo, add --pid-reused)`);
  }
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const dest = `${lockFile}.broken-${cur.state === 'ok' ? cur.owner.token : cur.state}-${stamp}`;
  renameWithRetry(lockFile, dest);
  return { moved_to: dest, previous: describeOwner(cur) };
}

function checkIntegrity(paths, runId) {
  const problems = [];
  const recovered = [];
  const rel = (f) => path.relative(runDir(paths, runId), f).split(path.sep).join('/');

  function check(file, validate) {
    let r;
    try {
      r = readJson(file);
    } catch (e) {
      problems.push(`${rel(file)}: ${e.code || 'ERROR'} ${e.message}`);
      return;
    }
    const bad = validate(r.value);
    if (bad) {
      problems.push(`${rel(file)}: ${bad}`);
      return;
    }
    if (r.recovered) {
      writeJson(file, r.value);
      recovered.push(rel(file));
    }
  }

  const dir = runDir(paths, runId);
  check(path.join(dir, 'run.json'), (v) => (v && typeof v === 'object' && v.run_id ? null : 'missing run_id'));
  for (const id of taskIds(paths, runId)) {
    check(taskFile(paths, runId, id), (v) => {
      if (!v || typeof v !== 'object') return 'not an object';
      if (!v.task_id) return 'missing task_id';
      if (!v.status) return 'missing status';
      return null;
    });
  }
  return { ok: problems.length === 0, problems, recovered };
}

module.exports = {
  StoreError,
  resolvePaths,
  ensureState,
  atomicWrite,
  writeJson,
  readJson,
  newRunId,
  createRun,
  loadRun,
  saveRun,
  listRuns,
  setCurrent,
  saveTask,
  loadTask,
  listTasks,
  saveSpecText,
  appendEvent,
  readEvents,
  writeEvidence,
  withLock,
  acquireLock,
  releaseLock,
  assertLockHeld,
  lockInfo,
  breakLock,
  ownerState,
  newOwner,
  checkIntegrity,
  LOCK_WAIT_MS,
};
