'use strict';
/**
 * state_manager - task lifecycle state machine with invariant guards, atomic
 * persistence, an append-only event log, recovery from corrupted state, and the
 * read-only views (summary, checkpoint, final report) derived from that state.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { performance } = require('perf_hooks');
const yaml = require('./miniyaml.cjs');

const STATES = [
  'PENDING', 'READY', 'DISPATCHED', 'RUNNING', 'IMPLEMENTED', 'VERIFYING', 'REVIEWING',
  'CORRECTION_REQUIRED', 'APPROVED', 'INTEGRATING', 'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED',
];

const ALLOWED = {
  PENDING: ['READY', 'BLOCKED', 'CANCELLED'],
  READY: ['DISPATCHED', 'PENDING', 'BLOCKED', 'CANCELLED'],
  DISPATCHED: ['RUNNING', 'READY', 'BLOCKED', 'FAILED', 'CANCELLED'],
  RUNNING: ['IMPLEMENTED', 'READY', 'BLOCKED', 'FAILED', 'CANCELLED'],
  IMPLEMENTED: ['VERIFYING', 'BLOCKED', 'CANCELLED'],
  VERIFYING: ['REVIEWING', 'CORRECTION_REQUIRED', 'IMPLEMENTED', 'BLOCKED', 'FAILED', 'CANCELLED'],
  REVIEWING: ['APPROVED', 'CORRECTION_REQUIRED', 'BLOCKED', 'CANCELLED'],
  CORRECTION_REQUIRED: ['READY', 'VERIFYING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  APPROVED: ['INTEGRATING', 'BLOCKED', 'CANCELLED'],
  INTEGRATING: ['COMPLETED', 'CORRECTION_REQUIRED', 'APPROVED', 'BLOCKED', 'FAILED'],
  BLOCKED: ['PENDING', 'READY', 'IMPLEMENTED', 'CORRECTION_REQUIRED', 'APPROVED', 'FAILED', 'CANCELLED'],
  COMPLETED: ['READY'],
  FAILED: ['READY'],
  CANCELLED: ['PENDING'],
};

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const SLOT_STATES = ['DISPATCHED', 'RUNNING'];
const HOLD_STATES = ['DISPATCHED', 'RUNNING', 'IMPLEMENTED', 'VERIFYING', 'REVIEWING', 'CORRECTION_REQUIRED', 'APPROVED', 'INTEGRATING'];
// Where a task returns to when it is unblocked, keyed by the state it was blocked from.
const UNBLOCK_TARGET = {
  PENDING: 'PENDING', READY: 'READY', DISPATCHED: 'READY', RUNNING: 'READY', IMPLEMENTED: 'IMPLEMENTED',
  VERIFYING: 'IMPLEMENTED', REVIEWING: 'IMPLEMENTED', CORRECTION_REQUIRED: 'CORRECTION_REQUIRED',
  APPROVED: 'APPROVED', INTEGRATING: 'APPROVED',
};

/** exit: 1 = usage/internal, 2 = refused by validation or an invariant, 3 = needs the user (limits, authorization) */
class OrchError extends Error {
  constructor(code, message, exit) {
    super(message);
    this.name = 'OrchError';
    this.code = code;
    this.exit = exit || 2;
  }
}

const nowIso = () => new Date().toISOString();
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepMs(40 * (i + 1));
    }
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${randomUUID()}`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function readLock(file) {
  try {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (owner && typeof owner.token === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(owner.token)
      && Number.isInteger(owner.pid) && owner.pid > 0 && owner.pid <= 0x7fffffff && typeof owner.host === 'string') {
      return owner;
    }
  } catch (e) {
    if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
  }
  return null;
}

function ownerExited(owner) {
  if (!owner || owner.host !== os.hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}

function emit(state, ev) {
  if (!state._events) Object.defineProperty(state, '_events', { value: [], enumerable: false, writable: true });
  state.seq = (state.seq || 0) + 1;
  ev.seq = state.seq;
  ev.at = nowIso();
  state._events.push(ev);
  return ev;
}

class Store {
  constructor(runDir) {
    this.runDir = runDir;
    this.statePath = path.join(runDir, 'state.json');
    this.lockPath = path.join(runDir, 'state.lock');
    this.eventsPath = path.join(runDir, 'events.jsonl');
    this.snapDir = path.join(runDir, 'snapshots');
    this.recovered = null;
    this.lockToken = null;
  }

  lock(timeoutMs = 15000) {
    if (this.lockToken) throw new OrchError('LOCK_REENTRANT', 'nested state transactions are unsupported', 1);
    const deadline = performance.now() + timeoutMs;
    const token = randomUUID();
    const claim = `${this.lockPath}.claim-${token}`;
    fs.writeFileSync(claim, JSON.stringify({ token, pid: process.pid, host: os.hostname() }), { flag: 'wx', mode: 0o600 });
    try {
      for (;;) {
        try {
          // Publish a complete owner record atomically. Other processes never see a partially written lock.
          fs.linkSync(claim, this.lockPath);
          this.lockToken = token;
          return;
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          const owner = readLock(this.lockPath);
          if (ownerExited(owner) && this.reap(owner)) continue;
          if (performance.now() >= deadline) {
            throw new OrchError('LOCK_TIMEOUT', 'state lock is active or its owner cannot be safely reconciled', 1);
          }
          sleepMs(50);
        }
      }
    } finally {
      fs.unlinkSync(claim);
    }
  }

  reap(owner) {
    const sameOwner = (a, b) => a && b && a.token === b.token && a.pid === b.pid && a.host === b.host;
    if (!sameOwner(readLock(this.lockPath), owner) || !ownerExited(owner)) return false;
    const root = `${this.lockPath}.reap-${owner.token}`;
    const readGuard = (file) => {
      try {
        // Legacy directories and links have no trustworthy guard identity.
        if (!fs.lstatSync(file).isFile()) return null;
        return readLock(file);
      } catch (e) {
        if (['ENOENT', 'EISDIR'].includes(e.code)) return null;
        throw e;
      }
    };
    const reconcile = (file) => new OrchError('LOCK_REAPER_RECONCILIATION_REQUIRED',
      `cannot establish recovery guard ownership: ${file}. Stop all processes using this run, confirm no owner can still execute, then move this guard aside as evidence before retrying.`, 1);
    let predecessor = null;
    const visited = new Set();
    for (;;) {
      const guard = predecessor ? `${root}-${predecessor}` : root;
      if (visited.has(guard)) throw reconcile(guard);
      visited.add(guard);
      const record = {
        token: randomUUID(), pid: process.pid, host: os.hostname(),
        kind: 'state-lock-reaper', lock_token: owner.token, predecessor_token: predecessor,
      };
      const matches = (candidate) => sameOwner(candidate, record) && candidate.kind === record.kind
        && candidate.lock_token === record.lock_token && candidate.predecessor_token === record.predecessor_token;
      const claim = `${this.lockPath}.claim-${record.token}`;
      let acquired = false;
      fs.writeFileSync(claim, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      try {
        try {
          // Publish complete metadata in one operation, including across a crash.
          fs.linkSync(claim, guard);
          acquired = true;
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
        }
      } finally {
        fs.unlinkSync(claim);
      }
      if (!acquired) {
        const previous = readGuard(guard);
        // A live owner may have released its guard between link and read. Retry
        // through lock(), which will also check whether the main lock changed.
        if (!previous && !fs.existsSync(guard)) return false;
        if (!previous || previous.kind !== record.kind || previous.lock_token !== owner.token
          || previous.predecessor_token !== predecessor) throw reconcile(guard);
        if (!ownerExited(previous)) return false;
        // Never unlink or overwrite an abandoned guard. Its immutable token
        // names the sole successor claim, avoiding a check-then-delete race
        // between simultaneous reapers. Repeated crashes follow this chain.
        predecessor = previous.token;
        continue;
      }
      try {
        if (!matches(readGuard(guard))) throw reconcile(guard);
        const current = readLock(this.lockPath);
        if (!sameOwner(current, owner) || !ownerExited(current)) return false;
        fs.unlinkSync(this.lockPath);
        return true;
      } finally {
        // Only the living owner removes its own guard. Dead predecessors remain
        // as small recovery records; later lock generations use different paths.
        if (matches(readGuard(guard))) fs.unlinkSync(guard);
      }
    }
  }

  unlock() {
    const token = this.lockToken;
    this.lockToken = null;
    if (!token || readLock(this.lockPath)?.token !== token) return false;
    fs.unlinkSync(this.lockPath);
    return true;
  }

  snapshotFiles() {
    try {
      return fs.readdirSync(this.snapDir).filter((f) => /^state-\d+\.json$/.test(f)).sort().reverse().map((f) => path.join(this.snapDir, f));
    } catch (e) { return []; }
  }

  /** Load state.json; fall back to the backup, then to the newest snapshot. */
  load() {
    const candidates = [this.statePath, `${this.statePath}.bak`].concat(this.snapshotFiles());
    const problems = [];
    for (const file of candidates) {
      try {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!s || s.schema !== 1 || !s.run_id || s.tasks === null || typeof s.tasks !== 'object') throw new Error('unexpected shape');
        if (file !== this.statePath) this.recovered = { from: path.basename(file), seq: s.seq || 0, problems: problems.slice() };
        return s;
      } catch (e) {
        problems.push(`${path.basename(file)}: ${e.message}`);
      }
    }
    throw new OrchError('STATE_UNRECOVERABLE', `no readable state in ${this.runDir} (${problems.join('; ')})`, 1);
  }

  save(state) {
    state.updated_at = nowIso();
    if (this.recovered) {
      // Preserve the unreadable file without moving the last readable backup or interrupting atomic replacement.
      if (fs.existsSync(this.statePath)) {
        writeAtomic(`${this.statePath}.corrupt-${randomUUID()}`, fs.readFileSync(this.statePath));
      }
    } else if (fs.existsSync(this.statePath)) {
      writeAtomic(`${this.statePath}.bak`, fs.readFileSync(this.statePath));
    }
    const shouldSnapshot = (state.seq || 0) - (state.snapshot_seq || 0) >= 10;
    if (shouldSnapshot) state.snapshot_seq = state.seq;
    writeAtomic(this.statePath, JSON.stringify(state, null, 1));
    if (shouldSnapshot) {
      try {
        fs.mkdirSync(this.snapDir, { recursive: true });
        writeAtomic(path.join(this.snapDir, `state-${String(state.seq).padStart(8, '0')}.json`), JSON.stringify(state));
        for (const old of this.snapshotFiles().slice(5)) fs.unlinkSync(old);
      } catch (e) { /* snapshots are a convenience */ }
    }
    try { writeAtomic(path.join(this.runDir, 'checkpoint.yaml'), yaml.dump(buildCheckpoint(state))); } catch (e) { /* derived view */ }
  }

  create(state) {
    fs.mkdirSync(this.runDir, { recursive: true });
    this.lock();
    try {
      if (fs.existsSync(this.statePath) || fs.existsSync(`${this.statePath}.bak`) || fs.existsSync(this.eventsPath)) {
        throw new OrchError('RUN_EXISTS', 'run files already exist', 1);
      }
      emit(state, { type: 'run_created' });
      this.commit(state);
    } finally {
      this.unlock();
    }
  }

  eventLogTail() {
    let fd;
    try {
      fd = fs.openSync(this.eventsPath, 'r');
    } catch (e) {
      if (e.code === 'ENOENT') return { offset: 0, separator: '' };
      throw e;
    }
    try {
      const offset = fs.fstatSync(fd).size;
      const last = Buffer.alloc(1);
      if (offset && fs.readSync(fd, last, 0, 1, offset - 1) !== 1) {
        throw new OrchError('EVENT_LOG_DIVERGED', 'could not read the final byte of the event log', 1);
      }
      // Legacy or recovered logs can end in an incomplete record. Preserve that record as evidence.
      return { offset, separator: offset && last[0] !== 10 ? '\n' : '' };
    } finally {
      fs.closeSync(fd);
    }
  }

  commit(state) {
    delete state.event_batch;
    if (state._events?.length) {
      const { offset, separator } = this.eventLogTail();
      state.event_batch = {
        offset,
        text: separator + state._events.map((event) => JSON.stringify(event) + '\n').join(''),
      };
    }
    this.save(state);
    try {
      this.flushEvents(state);
    } catch (e) {
      throw new OrchError('STATE_COMMITTED_LOG_PENDING', `state was committed but the event log could not be completed: ${e.message}. Run fo recover when the log is writable again.`, 1);
    }
  }

  /** Replay only the missing suffix of the committed batch after interruption. */
  flushEvents(state) {
    if (!state.event_batch) return;
    const { offset, text } = state.event_batch;
    if (!Number.isSafeInteger(offset) || offset < 0 || typeof text !== 'string' || !text.endsWith('\n')) {
      throw new OrchError('EVENT_LOG_DIVERGED', 'state contains an invalid event batch', 1);
    }
    const data = Buffer.from(text);
    const fd = fs.openSync(this.eventsPath, 'a+', 0o600);
    try {
      const written = fs.fstatSync(fd).size - offset;
      if (written < 0 || written > data.length) {
        throw new OrchError('EVENT_LOG_DIVERGED', 'event log length does not match the last committed batch', 1);
      }
      const existing = Buffer.alloc(written);
      let loaded = 0;
      while (loaded < existing.length) {
        const bytesRead = fs.readSync(fd, existing, loaded, existing.length - loaded, offset + loaded);
        if (bytesRead === 0) break;
        loaded += bytesRead;
      }
      if (loaded !== written || !existing.equals(data.subarray(0, written))) {
        throw new OrchError('EVENT_LOG_DIVERGED', 'event log content does not match the last committed batch', 1);
      }
      if (written < data.length) fs.writeFileSync(fd, data.subarray(written));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Preserve existing log evidence while avoiding duplicate sequence numbers after fallback. */
  reconcileRecoveredEvents(state) {
    let log = '';
    try { log = fs.readFileSync(this.eventsPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const lost = [];
    for (const line of log.split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        if (Number.isSafeInteger(event?.seq) && event.seq > this.recovered.seq) {
          lost.push(event);
          state.seq = Math.max(state.seq || 0, event.seq);
        }
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
    }
    this.recovered.lost_events = lost;
    emit(state, { type: 'recovery', from: this.recovered.from, lost: lost.length });
  }

  /** Lock, load, mutate, save. If fn throws nothing is written. */
  transact(fn) {
    this.lock();
    try {
      this.recovered = null;
      const state = this.load();
      Object.defineProperty(state, '_events', { value: [], enumerable: false, writable: true });
      if (this.recovered) this.reconcileRecoveredEvents(state);
      else this.flushEvents(state);
      const result = fn(state);
      if (result && typeof result.then === 'function') throw new OrchError('ASYNC_TRANSACTION', 'state transaction must finish synchronously', 1);
      this.commit(state);
      return result;
    } finally {
      this.unlock();
    }
  }

  read() {
    this.recovered = null;
    return this.load();
  }
}

// ------------------------------------------------------------------ tasks

function newTask(contract, route) {
  return {
    id: contract.task_id, contract, route, state: 'PENDING',
    review_round: 0, extra_rounds: 0, retries: 0, verify_cycle: 0, authorized: false, block: null, integration: null,
    attempts: [], checks: [], reviews: [], corrections: [], escalations: [], failures: [], spec_revisions: [], history: [],
  };
}

function getTask(state, id) {
  const t = state.tasks[id];
  if (!t) throw new OrchError('UNKNOWN_TASK', `no task ${id} in run ${state.run_id}`);
  return t;
}

const maxRounds = (state, t) => state.options.max_review_rounds + (t.extra_rounds || 0);
const currentChecks = (t) => t.checks.filter((c) => c.cycle === t.verify_cycle);
const currentReviews = (t) => t.reviews.filter((r) => r.cycle === t.verify_cycle);
const lastAttempt = (t) => t.attempts[t.attempts.length - 1] || null;

function reviewGate(t) {
  const cur = currentReviews(t);
  const rejected = cur.some((r) => r.verdict === 'reject');
  const orchestrator = cur.some((r) => r.reviewer === 'orchestrator' && r.verdict === 'approve');
  const perspectives = new Set(cur.filter((r) => r.reviewer === 'review-worker' && r.verdict === 'approve').map((r) => r.perspective));
  const need = t.route.review.independent;
  const missing = [];
  if (perspectives.size < need) {
    const want = (t.route.review.perspectives || []).filter((p) => !perspectives.has(p));
    missing.push(`${need - perspectives.size} independent review-worker approval(s)${want.length ? ` (${want.join(', ')})` : ''}`);
  }
  if (!orchestrator) missing.push('the orchestrator review');
  return { rejected, satisfied: !rejected && missing.length === 0, missing };
}

function assertInvariants(state, t, from, to, info) {
  const fail = (code, msg, exit) => { throw new OrchError(code, `${t.id}: ${msg}`, exit); };
  const openDeps = t.contract.dependencies.filter((d) => !state.tasks[d] || state.tasks[d].state !== 'COMPLETED');

  if (from === 'CANCELLED' && !(info.userAuthorized && info.reason)) fail('CANCELLED_IS_TERMINAL', 'a cancelled task restarts only with explicit user authorization and a reason', 3);
  if ((from === 'COMPLETED' || from === 'FAILED') && !info.reason) fail('EXPLICIT_REASON_REQUIRED', `a ${from} task is reopened only with an explicit reason`);
  if (from === 'FAILED' && !info.strategyChange) fail('STRATEGY_CHANGE_REQUIRED', 'a failed task is retried only through an escalation that changes model, decomposition, context or strategy');
  if (from === 'BLOCKED' && !['FAILED', 'CANCELLED'].includes(to) && !info.reason) fail('EXPLICIT_REASON_REQUIRED', 'unblocking needs a reason');
  if (from === 'READY' && to === 'PENDING' && !info.replan) fail('ILLEGAL_TRANSITION', 'READY -> PENDING happens only when the plan is revised');
  if (from === 'VERIFYING' && to === 'IMPLEMENTED' && !info.recovery) fail('ILLEGAL_TRANSITION', 'VERIFYING -> IMPLEMENTED is a recovery-only rollback');
  if (from === 'INTEGRATING' && to === 'APPROVED' && !info.recovery) fail('ILLEGAL_TRANSITION', 'INTEGRATING -> APPROVED is a recovery-only rollback');

  switch (to) {
    case 'READY':
      if (openDeps.length) fail('DEPENDENCIES_UNSATISFIED', `dependencies not completed: ${openDeps.join(', ')}`);
      if (from === 'CORRECTION_REQUIRED') {
        const last = t.corrections[t.corrections.length - 1];
        if (!last || last.round !== t.review_round) fail('CORRECTION_REQUEST_REQUIRED', 'record a targeted correction request first');
        if (t.review_round > maxRounds(state, t)) fail('CORRECTION_LIMIT', `correction limit of ${maxRounds(state, t)} rounds reached`, 3);
      }
      if (from === 'DISPATCHED' || from === 'RUNNING') {
        if (t.retries > state.options.max_task_retries) fail('RETRY_LIMIT', `retry limit of ${state.options.max_task_retries} reached`, 3);
        if (t.contract.side_effects === 'external') fail('RETRY_UNSAFE', 'the task has external side effects and is never retried automatically', 3);
      }
      break;
    case 'DISPATCHED':
      if (openDeps.length) fail('DEPENDENCIES_UNSATISFIED', `dependencies not completed: ${openDeps.join(', ')}`);
      if (t.contract.side_effects === 'external' && !t.authorized) fail('AUTHORIZATION_REQUIRED', 'the task has external side effects; record user authorization first (fo authorize)', 3);
      break;
    case 'IMPLEMENTED': {
      const a = lastAttempt(t);
      if (!a || !a.report || a.report.status !== 'implemented') fail('REPORT_REQUIRED', 'a valid completion report with status implemented is required');
      break;
    }
    case 'VERIFYING':
      if (from === 'CORRECTION_REQUIRED') {
        if (!info.reason) fail('EXPLICIT_REASON_REQUIRED', 're-verification without a new attempt needs a reason');
        if (t.review_round > maxRounds(state, t)) fail('CORRECTION_LIMIT', `correction limit of ${maxRounds(state, t)} rounds reached`, 3);
      }
      break;
    case 'REVIEWING': {
      const cur = currentChecks(t);
      // the automatic file-scope check alone says nothing about behaviour
      if (!cur.some((c) => c.kind !== 'scope')) fail('NO_VERIFICATION_EVIDENCE', 'no verification evidence is recorded for this cycle');
      const bad = cur.filter((c) => !c.passed);
      if (bad.length) fail('VERIFICATION_FAILED', `failed checks cannot be passed on as success: ${bad.map((c) => c.name).join(', ')}`);
      break;
    }
    case 'APPROVED': {
      const cur = currentChecks(t);
      if (!cur.some((c) => c.kind !== 'scope') || cur.some((c) => !c.passed)) fail('VERIFICATION_FAILED', 'approval requires passing verification evidence');
      const gate = reviewGate(t);
      if (gate.rejected) fail('REVIEW_REJECTED', 'a reviewer rejected this cycle');
      if (!gate.satisfied) fail('REVIEW_REQUIRED', `approval still needs ${gate.missing.join(' and ')}`);
      break;
    }
    case 'INTEGRATING': {
      const other = Object.values(state.tasks).find((o) => o.id !== t.id && o.state === 'INTEGRATING');
      if (other) fail('INTEGRATION_BUSY', `${other.id} is integrating; integrations run one at a time`);
      break;
    }
    case 'COMPLETED':
      if (!t.integration || t.integration.cycle !== t.verify_cycle || t.integration.passed !== true) {
        fail('INTEGRATION_CHECK_REQUIRED', 'completion requires a passed integration check for the approved work');
      }
      break;
    default:
      break;
  }
}

function transition(state, id, to, info) {
  const t = getTask(state, id);
  const meta = info || {};
  const from = t.state;
  if (!(ALLOWED[from] || []).includes(to)) throw new OrchError('ILLEGAL_TRANSITION', `${id}: ${from} -> ${to} is not a permitted transition`);
  assertInvariants(state, t, from, to, meta);
  t.state = to;
  t.block = to === 'BLOCKED' ? { kind: meta.kind || 'manual', reason: meta.reason || '', from } : null;
  t.history.push({ at: nowIso(), from, to, reason: meta.reason || '' });
  emit(state, { type: 'transition', task: id, from, to, reason: meta.reason || '' });
  return t;
}

/** Promote PENDING tasks whose dependencies completed; block those whose dependencies can no longer complete. */
function refresh(state) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of state.order) {
      const t = state.tasks[id];
      const deps = t.contract.dependencies.map((d) => state.tasks[d] || { id: d, state: 'MISSING' });
      const dead = deps.find((d) => ['FAILED', 'CANCELLED', 'MISSING'].includes(d.state));
      if (t.state === 'PENDING') {
        if (dead) {
          transition(state, id, 'BLOCKED', { kind: 'dependency', reason: `dependency ${dead.id} is ${dead.state}` });
          changed = true;
        } else if (deps.every((d) => d.state === 'COMPLETED')) {
          transition(state, id, 'READY', { reason: 'dependencies completed' });
          changed = true;
        }
      } else if (t.state === 'BLOCKED' && t.block && t.block.kind === 'dependency' && !dead) {
        transition(state, id, 'PENDING', { reason: 'blocking dependency was reopened' });
        changed = true;
      }
    }
  }
}

function schedulerViews(state) {
  return state.order.map((id) => {
    const t = state.tasks[id];
    return {
      id, state: t.state, deps: t.contract.dependencies, scope: t.contract.file_scope,
      priority: t.contract.priority, exclusive: t.contract.exclusive,
      usesSlot: SLOT_STATES.includes(t.state),
      // work in flight, or started and not yet finished, keeps ownership of its files
      holdsScope: HOLD_STATES.includes(t.state) || (t.attempts.length > 0 && !TERMINAL.includes(t.state) && t.state !== 'PENDING'),
    };
  });
}

function budgetStatus(state) {
  const b = state.config.budget;
  const used = state.budget;
  const out = { enabled: !!b.enabled, exceeded: false, warnings: [], notes: [], remaining_calls: Infinity };
  if (!b.enabled) return out;
  if (b.agent_call_limit !== null && b.agent_call_limit !== undefined) {
    const limit = b.agent_call_limit + (used.extra_agent_calls || 0);
    out.remaining_calls = Math.max(0, limit - used.agent_calls);
    const pct = limit > 0 ? (used.agent_calls / limit) * 100 : 100;
    if (used.agent_calls >= limit) { out.exceeded = true; out.notes.push(`agent call limit reached (${used.agent_calls}/${limit})`); }
    else if (pct >= b.warn_at_percent) out.warnings.push(`agent calls at ${Math.round(pct)}% of the limit (${used.agent_calls}/${limit})`);
  }
  if (b.token_limit !== null && b.token_limit !== undefined) {
    const pct = (used.tokens_reported / b.token_limit) * 100;
    if (used.tokens_reported >= b.token_limit) { out.exceeded = true; out.notes.push(`token limit reached (${used.tokens_reported}/${b.token_limit} reported tokens)`); }
    else if (pct >= b.warn_at_percent) out.warnings.push(`reported tokens at ${Math.round(pct)}% of the limit`);
    out.notes.push('token totals cover only worker usage reported to fo; the orchestrator session itself is not measurable from inside it');
  }
  if (b.cost_limit_usd !== null && b.cost_limit_usd !== undefined) {
    out.notes.push('cost_limit_usd is not enforceable inside a session (no dollar figure is exposed); for headless runs use `claude -p --max-budget-usd`');
  }
  return out;
}

function summary(state) {
  const counts = {};
  for (const s of STATES) counts[s] = 0;
  const tasks = state.order.map((id) => state.tasks[id]);
  for (const t of tasks) counts[t.state]++;
  let run_state;
  if (!tasks.length) run_state = 'INTAKE';
  else if (tasks.every((t) => t.state === 'COMPLETED')) run_state = 'COMPLETE';
  else if (tasks.every((t) => TERMINAL.includes(t.state))) run_state = 'COMPLETE_WITH_FAILURES';
  else if (tasks.some((t) => !TERMINAL.includes(t.state) && t.state !== 'BLOCKED' && t.state !== 'PENDING')) run_state = 'IN_PROGRESS';
  else run_state = 'STALLED';
  return { run_state, total: tasks.length, counts };
}

/** What the orchestrator has to do next, one line per task that needs it. */
function nextActions(state) {
  const out = [];
  for (const id of state.order) {
    const t = state.tasks[id];
    switch (t.state) {
      case 'READY': out.push(`${id}: READY - \`fo next\` dispatches it`); break;
      case 'DISPATCHED': out.push(`${id}: DISPATCHED - issue its Agent call, then \`fo started ${id}\``); break;
      case 'RUNNING': out.push(`${id}: RUNNING - when the worker returns, pass its report to \`fo report ${id} --verify --stdin\`; if it crashed, \`fo worker-failed ${id} --kind <kind> --reason "..."\``); break;
      case 'IMPLEMENTED': out.push(`${id}: IMPLEMENTED - \`fo verify ${id}\`${t.contract.verification_commands.length ? '' : ' after recording manual checks with `fo check`'}`); break;
      case 'VERIFYING': out.push(`${id}: VERIFYING - \`fo verify ${id}\` finishes verification`); break;
      case 'REVIEWING': {
        const gate = reviewGate(t);
        out.push(`${id}: REVIEWING - needs ${gate.missing.join(' and ')}; \`fo review ${id} --integrate --stdin\`${t.route.review.independent ? ` (reviewer prompt: \`fo review-package ${id}\`)` : ''}`);
        break;
      }
      case 'CORRECTION_REQUIRED': {
        const left = maxRounds(state, t) - t.review_round;
        const why = t.history.length ? t.history[t.history.length - 1].reason : '';
        out.push(left > 0
          ? `${id}: CORRECTION_REQUIRED (${why}) - write a targeted correction and pass it to \`fo correct ${id} --stdin\` (round ${t.review_round + 1} of ${maxRounds(state, t)})`
          : `${id}: CORRECTION_REQUIRED (${why}) - correction limit reached: escalate to the user (\`fo block ${id} --kind correction_limit --reason "..."\`) or \`fo fail ${id} --reason "..."\``);
        break;
      }
      case 'APPROVED': out.push(`${id}: APPROVED - \`fo integrate ${id}\``); break;
      case 'INTEGRATING': out.push(`${id}: INTEGRATING - in progress (after an interruption run \`fo resume\`)`); break;
      case 'BLOCKED': out.push(`${id}: BLOCKED [${t.block ? t.block.kind : '?'}] ${t.block ? t.block.reason : ''} - resolve it, then \`fo unblock ${id} --reason "..."\`, \`fo escalate ${id} ...\` or \`fo fail ${id} --reason "..."\``); break;
      default: break;
    }
  }
  return out;
}

// ------------------------------------------------------------------ views

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 3)}...` : String(s));

function buildCheckpoint(state) {
  const sum = summary(state);
  return {
    run_id: state.run_id,
    updated_at: state.updated_at,
    phase: state.phase,
    run_state: sum.run_state,
    request: clip(state.request, 2000),
    options: state.options,
    workspace: state.project.isolation,
    decisions: (state.decisions || []).map((d) => d.text),
    tasks: state.order.map((id) => {
      const t = state.tasks[id];
      const last = t.history[t.history.length - 1];
      const corr = t.corrections[t.corrections.length - 1];
      const a = lastAttempt(t);
      return {
        id, title: t.contract.title, state: t.state,
        dependencies: t.contract.dependencies,
        assignment: `${t.route.role} on ${t.route.model} (${t.route.tier})`,
        dispatches: t.attempts.length, correction_rounds: t.review_round, retries: t.retries,
        commit: a && a.commit ? a.commit : null,
        last_event: last ? `${last.from} -> ${last.to}: ${clip(last.reason, 200)}` : null,
        pending_correction: t.state === 'READY' && corr && corr.round === t.review_round ? clip(corr.required_change, 300) : null,
        blocked: t.block ? `${t.block.kind}: ${clip(t.block.reason, 300)}` : null,
      };
    }),
    integration: state.project.git
      ? { branch: state.project.git.integration_branch, delivery: state.delivery ? state.delivery.status : 'pending' }
      : { delivery: state.delivery ? state.delivery.status : 'pending', verified: state.delivery?.verified === true },
    budget: { agent_calls: state.budget.agent_calls, tokens_reported: state.budget.tokens_reported },
    next_actions: nextActions(state),
  };
}

function finalReport(state, runDir) {
  const sum = summary(state);
  const tasks = state.order.map((id) => state.tasks[id]);
  const L = [];
  const g = state.project.git;
  L.push(`# Fable Orchestrator report - run ${state.run_id}`, '');
  L.push(`- Outcome: **${sum.run_state}** (${sum.counts.COMPLETED} of ${sum.total} tasks completed)`);
  L.push(`- Mode ${state.options.mode}; up to ${state.options.max_workers} workers; ${state.options.max_review_rounds} correction rounds; ${state.options.max_task_retries} retries per task`);
  L.push(`- Workspace: ${state.project.isolation === 'shared' ? 'shared project directory (no git isolation)' : `git worktrees (${state.project.isolation}); integration branch ${g && g.integration_branch ? g.integration_branch : 'not created'}`}`);
  if (state.delivery) {
    const d = state.delivery;
    L.push(`- Delivery: ${d.status}${d.head ? ` (your branch is now at ${d.head.slice(0, 10)})` : ''}${d.reason ? ` - ${clip(d.reason, 300)}` : ''}`);
  } else {
    L.push('- Delivery: not performed');
  }
  L.push(`- Started ${state.created_at}; last update ${state.updated_at}`, '');
  L.push('## Request', '', ...state.request.split('\n').map((l) => `> ${l}`), '');

  L.push('## Tasks', '', '| Task | State | Assignment | Dispatches | Corrections | Verification (last cycle) | Review |', '|---|---|---|---|---|---|---|');
  for (const t of tasks) {
    const cur = currentChecks(t);
    const ver = cur.length ? `${cur.filter((c) => c.passed).length}/${cur.length} checks passed` : 'none recorded';
    const revs = currentReviews(t);
    const rev = revs.length ? revs.map((r) => `${r.reviewer}: ${r.verdict}`).join('; ') : 'none';
    L.push(`| ${t.id} ${clip(t.contract.title, 50)} | ${t.state} | ${t.route.role} / ${t.route.model} | ${t.attempts.length} | ${t.review_round} | ${ver} | ${rev} |`);
  }
  L.push('');

  L.push('## Evidence by task', '');
  for (const t of tasks) {
    L.push(`### ${t.id} - ${t.contract.title} (${t.state})`, '');
    for (let cyc = 1; cyc <= t.verify_cycle; cyc++) {
      const checks = t.checks.filter((c) => c.cycle === cyc);
      if (!checks.length) continue;
      L.push(`Verification cycle ${cyc}${cyc === t.verify_cycle ? ' (current)' : ''}:`);
      for (const c of checks) {
        const how = c.kind === 'command' ? `exit ${c.timed_out ? 'timeout' : c.exit_code}${c.evidence ? `, evidence ${c.evidence}` : ''}` : clip(c.detail || '', 200);
        L.push(`- ${c.passed ? 'PASS' : 'FAIL'} [${c.kind}] ${clip(c.name, 120)} (${how})`);
      }
    }
    if (!t.checks.length) L.push('No verification evidence recorded.');
    for (const c of t.corrections) {
      L.push(`- Correction round ${c.round}: ${clip(c.failure, 200)} -> ${clip(c.required_change, 200)}${c.strategy_change ? ` [strategy change: ${c.strategy_change.kind} - ${clip(c.strategy_change.detail, 120)}]` : ''}`);
    }
    for (const e of t.escalations) L.push(`- Escalation (${e.kind}): ${e.from.role}/${e.from.model} -> ${e.to.role}/${e.to.model}; ${clip(e.detail, 160)}`);
    for (const f of t.failures) L.push(`- Worker failure (${f.kind}, dispatch ${f.attempt}): ${clip(f.reason, 200)}`);
    for (const r of currentReviews(t)) {
      L.push(`- Review by ${r.reviewer} (${r.perspective}): ${r.verdict}`);
      for (const c of r.criteria) L.push(`  - ${c.met ? 'met' : 'NOT met'}: ${clip(c.criterion, 110)} - ${clip(c.evidence || 'no evidence given', 160)}`);
      for (const f of r.findings) L.push(`  - finding: ${clip(f, 200)}`);
    }
    if (t.integration) {
      const i = t.integration;
      const ic = i.checks.length ? `${i.checks.filter((c) => c.passed).length}/${i.checks.length} integration checks passed` : 'no integration commands';
      L.push(`- Integration: ${i.passed ? 'passed' : 'FAILED'}${i.merge_commit ? `, merge commit ${i.merge_commit.slice(0, 10)}` : i.already_merged ? ', already merged' : ''}; ${ic}${i.conflict_files.length ? `; conflicts in ${i.conflict_files.join(', ')}` : ''}`);
    }
    const a = lastAttempt(t);
    if (a && a.report && a.report.known_issues.length) L.push(`- Known issues reported by the worker: ${a.report.known_issues.map((k) => clip(k, 160)).join('; ')}`);
    L.push('');
  }

  const open = tasks.filter((t) => t.state !== 'COMPLETED');
  L.push('## Not completed', '');
  if (!open.length) L.push('Every task completed with passing verification, an approving review and a passed integration check.');
  for (const t of open) {
    const last = t.history[t.history.length - 1];
    L.push(`- ${t.id} is ${t.state}${t.block ? ` [${t.block.kind}] ${clip(t.block.reason, 240)}` : last ? `: ${clip(last.reason, 240)}` : ''}`);
  }
  L.push('');

  L.push('## Resource usage', '');
  L.push(`- Agent dispatches recorded: ${state.budget.agent_calls}`);
  L.push(state.budget.tokens_reported > 0
    ? `- Worker tokens reported to fo: ${state.budget.tokens_reported} (excludes the orchestrator session and any worker whose usage was not passed in)`
    : '- Token usage: not reported to fo during this run; no figure is given rather than an estimate');
  L.push('- Dollar cost: not measurable from inside a session. A headless run reports it in `claude -p --output-format json` (`total_cost_usd`).', '');

  L.push('## Decisions and assumptions', '');
  if (!(state.decisions || []).length) L.push('None recorded.');
  for (const d of state.decisions || []) L.push(`- ${d.text}`);
  L.push('');
  L.push('## Provenance', '');
  L.push(`Generated from the recorded state and evidence files in ${runDir}. Nothing in this report is inferred: a check listed as PASS is a command whose exit code fo observed, or a manual check the orchestrator recorded with its basis.`);
  return L.join('\n') + '\n';
}

module.exports = {
  STATES, ALLOWED, TERMINAL, SLOT_STATES, HOLD_STATES, UNBLOCK_TARGET, OrchError, Store,
  nowIso, emit, writeAtomic, newTask, getTask, lastAttempt, maxRounds, currentChecks, currentReviews, reviewGate,
  transition, refresh, schedulerViews, budgetStatus, summary, nextActions, buildCheckpoint, finalReport,
};
