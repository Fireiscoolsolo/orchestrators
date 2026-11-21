'use strict';
// store.cjs: atomic persistent run and task store. JSON only, synchronous fs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 5000;

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
  const tmp = `${file}.tmp-${process.pid}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
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

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function lockIsStale(lockFile) {
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch (_) { /* unreadable: judge by mtime */ }
  let age;
  if (info && typeof info.ts === 'number') age = Date.now() - info.ts;
  else {
    try { age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch (_) { return false; }
  }
  if (age > LOCK_STALE_MS) return true;
  if (info && !pidAlive(info.pid)) return true;
  return false;
}

function withLock(paths, fn) {
  fs.mkdirSync(paths.stateRoot, { recursive: true });
  const lockFile = path.join(paths.stateRoot, '.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      if (e.code === 'EEXIST' && lockIsStale(lockFile)) {
        try { fs.unlinkSync(lockFile); } catch (_) { /* raced */ }
        continue;
      }
      if (Date.now() >= deadline) throw new StoreError('LOCK_TIMEOUT', 'could not acquire state lock');
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockFile); } catch (_) { /* ignore */ }
  }
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
  checkIntegrity,
};
