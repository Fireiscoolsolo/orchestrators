'use strict';
// Formal task state machine (DESIGN.md 4.4). Pure: no I/O and no clock reads; time arrives via ctx.now.

const STATES = [
  'PENDING', 'READY', 'DISPATCHED', 'RUNNING', 'IMPLEMENTED', 'VERIFYING', 'REVIEWING',
  'CORRECTION_REQUIRED', 'APPROVED', 'INTEGRATING', 'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED',
];
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const IN_FLIGHT = ['DISPATCHED', 'RUNNING'];
const OWNS_WORK = [
  'DISPATCHED', 'RUNNING', 'IMPLEMENTED', 'VERIFYING', 'REVIEWING', 'CORRECTION_REQUIRED', 'APPROVED', 'INTEGRATING',
];

const TRANSITIONS = {
  PENDING: ['READY', 'BLOCKED', 'FAILED', 'CANCELLED'],
  READY: ['DISPATCHED', 'BLOCKED', 'FAILED', 'CANCELLED'],
  DISPATCHED: ['RUNNING', 'READY', 'BLOCKED', 'FAILED', 'CANCELLED'],
  RUNNING: ['IMPLEMENTED', 'READY', 'BLOCKED', 'FAILED', 'CANCELLED'],
  IMPLEMENTED: ['VERIFYING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  VERIFYING: ['REVIEWING', 'CORRECTION_REQUIRED', 'BLOCKED', 'FAILED', 'CANCELLED'],
  REVIEWING: ['APPROVED', 'CORRECTION_REQUIRED', 'BLOCKED', 'FAILED', 'CANCELLED'],
  CORRECTION_REQUIRED: ['READY', 'BLOCKED', 'FAILED', 'CANCELLED'],
  APPROVED: ['INTEGRATING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  INTEGRATING: ['COMPLETED', 'CORRECTION_REQUIRED', 'BLOCKED', 'FAILED', 'CANCELLED'],
  COMPLETED: ['PENDING'],
  BLOCKED: ['PENDING', 'READY', 'FAILED', 'CANCELLED'],
  FAILED: ['READY', 'CANCELLED'],
  CANCELLED: ['PENDING'],
};

class TransitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
  }
}

function canTransition(from, to) {
  return Object.prototype.hasOwnProperty.call(TRANSITIONS, from) && TRANSITIONS[from].includes(to);
}

function isTerminal(status) {
  return TERMINAL.includes(status);
}

function isInt(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function transition(task, to, ctx) {
  if (!task || typeof task !== 'object') throw new TransitionError('INVALID_TASK', 'task must be an object');
  if (!ctx || typeof ctx !== 'object') throw new TransitionError('NOW_REQUIRED', 'ctx.now is required');
  if (typeof ctx.now !== 'string' || ctx.now === '' || Number.isNaN(Date.parse(ctx.now))) {
    throw new TransitionError('NOW_REQUIRED', 'ctx.now (ISO-8601 string) is required');
  }
  const from = task.status;
  if (!canTransition(from, to)) {
    throw new TransitionError('INVALID_TRANSITION', `cannot move task from ${from} to ${to}`);
  }
  const reason = typeof ctx.reason === 'string' ? ctx.reason.trim() : '';
  const limits = ctx.limits || {};
  const evidence = task.evidence || {};
  const key = `${from}>${to}`;

  if (to === 'BLOCKED' || to === 'FAILED' || to === 'CANCELLED') {
    if (!reason) throw new TransitionError('REASON_REQUIRED', `moving to ${to} requires a non-empty reason`);
  }

  const needsDeps = key === 'PENDING>READY' || key === 'BLOCKED>READY' || key === 'READY>DISPATCHED' || key === 'FAILED>READY';
  const retry = key === 'DISPATCHED>READY' || key === 'RUNNING>READY';

  if (key === 'FAILED>READY' && ctx.escalated !== true && ctx.userAuthorized !== true) {
    throw new TransitionError('NOT_AUTHORIZED', 'restarting a FAILED task requires ctx.escalated or ctx.userAuthorized');
  }
  if ((key === 'CANCELLED>PENDING' || key === 'COMPLETED>PENDING') && ctx.userAuthorized !== true) {
    throw new TransitionError('NOT_AUTHORIZED', `reopening a ${from} task requires ctx.userAuthorized`);
  }
  if (needsDeps && ctx.depsCompleted !== true) {
    throw new TransitionError('DEPS_UNSATISFIED', 'dependencies are not all completed');
  }
  if (retry) {
    if (task.side_effects === 'external') {
      throw new TransitionError('UNSAFE_RETRY', 'task has external side effects; automatic retry is unsafe');
    }
    if (!isInt(limits.max_retries) || !((task.retries || 0) < limits.max_retries)) {
      throw new TransitionError('RETRY_LIMIT', 'retry limit reached');
    }
  }
  if (key === 'VERIFYING>REVIEWING') {
    if (!evidence.verification || evidence.verification.passed !== true) {
      throw new TransitionError('VERIFICATION_FAILED', 'verification has not passed');
    }
  }
  if (key === 'REVIEWING>APPROVED') {
    if (!evidence.verification || evidence.verification.passed !== true) {
      throw new TransitionError('UNVERIFIED', 'cannot approve without passed verification');
    }
    const reviews = Array.isArray(evidence.reviews) ? evidence.reviews : [];
    const own = reviews.filter((r) => r && r.reviewer === 'orchestrator');
    if (own.length === 0 || own[own.length - 1].verdict !== 'approve') {
      throw new TransitionError('NO_APPROVAL', 'latest orchestrator review is not an approval');
    }
    if (ctx.requiresIndependentReview &&
        !reviews.some((r) => r && r.independent === true && r.verdict === 'approve')) {
      throw new TransitionError('NO_INDEPENDENT_REVIEW', 'an approving independent review is required');
    }
  }
  if (key === 'CORRECTION_REQUIRED>READY') {
    if (!task.correction) throw new TransitionError('NO_CORRECTION', 'no pending correction request');
    if (!isInt(limits.max_review_rounds) || !((task.review_round || 0) < limits.max_review_rounds)) {
      throw new TransitionError('CORRECTION_LIMIT', 'correction round limit reached');
    }
  }
  if (key === 'INTEGRATING>COMPLETED') {
    if (!evidence.integration || evidence.integration.passed !== true) {
      throw new TransitionError('INTEGRATION_FAILED', 'integration has not passed');
    }
  }

  const next = structuredClone(task);
  next.status = to;
  if (key === 'READY>DISPATCHED') next.attempts = (next.attempts || 0) + 1;
  if (retry) next.retries = (next.retries || 0) + 1;
  if (key === 'CORRECTION_REQUIRED>READY') next.review_round = (next.review_round || 0) + 1;
  if (to === 'BLOCKED') next.block = { kind: ctx.kind || 'manual', reason, ts: ctx.now };
  if (to === 'FAILED') next.failure = { kind: ctx.kind || 'manual', reason, ts: ctx.now };
  if (from === 'BLOCKED' && to !== 'BLOCKED') next.block = null;
  if (from === 'FAILED' && to === 'READY') next.failure = null;
  if (!Array.isArray(next.history)) next.history = [];
  next.history.push({ ts: ctx.now, from, to, reason: reason || null, actor: ctx.actor || 'orchestrator' });
  return next;
}

const GUARD_LINES = [
  'PENDING->READY, BLOCKED->READY, READY->DISPATCHED: ctx.depsCompleted === true (DEPS_UNSATISFIED)',
  'READY->DISPATCHED: increments attempts',
  'DISPATCHED->READY, RUNNING->READY: retries < max_retries (RETRY_LIMIT), side_effects !== external (UNSAFE_RETRY); increments retries',
  'VERIFYING->REVIEWING: verification passed (VERIFICATION_FAILED)',
  'REVIEWING->APPROVED: verification passed (UNVERIFIED); latest orchestrator review approves (NO_APPROVAL); independent approval if required (NO_INDEPENDENT_REVIEW)',
  'CORRECTION_REQUIRED->READY: correction present (NO_CORRECTION), review_round < max_review_rounds (CORRECTION_LIMIT); increments review_round',
  'INTEGRATING->COMPLETED: integration passed (INTEGRATION_FAILED)',
  'FAILED->READY: escalated or userAuthorized (NOT_AUTHORIZED), deps completed (DEPS_UNSATISFIED)',
  'CANCELLED->PENDING, COMPLETED->PENDING: userAuthorized (NOT_AUTHORIZED)',
  'any->BLOCKED/FAILED/CANCELLED: non-empty reason (REASON_REQUIRED)',
];

function describe() {
  const lines = ['Task states and allowed transitions:'];
  for (const s of STATES) lines.push(`  ${s.padEnd(20)} ${TRANSITIONS[s].join(' ')}`);
  lines.push('', 'Guards:');
  for (const g of GUARD_LINES) lines.push(`  ${g}`);
  return lines.join('\n');
}

module.exports = {
  STATES, TERMINAL, IN_FLIGHT, OWNS_WORK, TRANSITIONS,
  canTransition, transition, isTerminal, describe, TransitionError,
};
