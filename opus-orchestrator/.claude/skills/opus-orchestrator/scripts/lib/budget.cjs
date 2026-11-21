'use strict';
// Budget accounting (pure: no I/O, no clock). Functions return new objects.

class BudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
  }
}

function newUsage() {
  return {
    agent_calls: 0,
    worker_calls: 0,
    review_calls: 0,
    retries: 0,
    corrections: 0,
    verification_runs: 0,
    tokens: { input: 0, output: 0, cached: 0, total: 0 },
    tokens_measured: false,
    cost_usd: null,
    cost_measured: false,
    duration_ms: 0,
    by_task: {},
  };
}

function clone(u) {
  return JSON.parse(JSON.stringify(u));
}

function taskEntry(u, id) {
  if (id == null) return null;
  if (!u.by_task[id]) u.by_task[id] = { calls: 0, tokens: 0, verification_runs: 0 };
  return u.by_task[id];
}

function recordCall(usage, { task_id, kind } = {}) {
  const u = clone(usage);
  u.agent_calls += 1;
  if (kind === 'review') u.review_calls += 1;
  else if (kind === 'retry') { u.worker_calls += 1; u.retries += 1; }
  else if (kind === 'correction') { u.worker_calls += 1; u.corrections += 1; }
  else u.worker_calls += 1;
  const t = taskEntry(u, task_id);
  if (t) t.calls += 1;
  return u;
}

function recordTokens(usage, { task_id, total, input, output, cached } = {}) {
  const u = clone(usage);
  const i = Number(input) || 0;
  const o = Number(output) || 0;
  const c = Number(cached) || 0;
  const tot = total != null ? Number(total) || 0 : i + o;
  u.tokens.input += i;
  u.tokens.output += o;
  u.tokens.cached += c;
  u.tokens.total += tot;
  u.tokens_measured = true;
  const t = taskEntry(u, task_id);
  if (t) t.tokens += tot;
  return u;
}

function recordCost(usage, usd) {
  const u = clone(usage);
  u.cost_usd = (u.cost_usd || 0) + Number(usd);
  u.cost_measured = true;
  return u;
}

function recordVerification(usage, task_id) {
  const u = clone(usage);
  u.verification_runs += 1;
  const t = taskEntry(u, task_id);
  if (t) t.verification_runs += 1;
  return u;
}

function effectiveLimit(name, budgetCfg, authorizations) {
  let limit = budgetCfg[name] == null ? null : budgetCfg[name];
  for (const a of authorizations || []) {
    if (a && a.limit === name && a.by === 'user' && a.value != null) {
      if (limit == null || a.value > limit) limit = a.value;
    }
  }
  return limit;
}

const RANK = { ok: 0, warning: 1, exceeded: 2 };

function check(usage, budgetCfg, authorizations = []) {
  if (!budgetCfg || budgetCfg.enabled === false) {
    return { state: 'disabled', limits: [], messages: ['budget disabled'] };
  }
  const threshold = budgetCfg.warning_threshold_percent == null ? 80 : budgetCfg.warning_threshold_percent;
  const defs = [
    { name: 'agent_call_limit', used: usage.agent_calls, enforceable: true, note: '' },
    {
      name: 'token_limit',
      used: usage.tokens.total,
      enforceable: !!usage.tokens_measured,
      note: usage.tokens_measured ? '' : 'tokens are not measured; limit not enforced',
    },
    {
      name: 'cost_limit_usd',
      used: usage.cost_usd,
      enforceable: !!usage.cost_measured,
      note: usage.cost_measured ? '' : 'cost is not measurable in-session',
    },
  ];
  const limits = [];
  const messages = [];
  let worst = 'ok';
  for (const d of defs) {
    const limit = effectiveLimit(d.name, budgetCfg, authorizations);
    const entry = { name: d.name, used: d.used, limit, percent: null, state: 'ok', enforceable: d.enforceable, note: d.note };
    if (limit == null) {
      entry.note = 'no limit set';
    } else if (d.enforceable) {
      entry.percent = limit === 0 ? 100 : (d.used / limit) * 100;
      if (entry.percent >= 100) entry.state = 'exceeded';
      else if (entry.percent >= threshold) entry.state = 'warning';
      if (entry.state !== 'ok') messages.push(`${d.name} ${entry.state}: ${d.used} of ${limit}`);
    } else {
      messages.push(`${d.name}: ${d.note}`);
    }
    if (RANK[entry.state] > RANK[worst]) worst = entry.state;
    limits.push(entry);
  }
  return { state: worst, limits, messages };
}

function authorize(authorizations, { limit, value, by, reason, now } = {}) {
  if (by !== 'user' || typeof reason !== 'string' || !reason.trim()) {
    throw new BudgetError('NOT_USER', 'raising a budget limit requires by "user" and a non-empty reason');
  }
  return (authorizations || []).concat([{ limit, value, by, reason, ts: now }]);
}

function remainingCalls(usage, budgetCfg, authorizations = []) {
  if (!budgetCfg || budgetCfg.enabled === false) return Infinity;
  const limit = effectiveLimit('agent_call_limit', budgetCfg, authorizations);
  if (limit == null) return Infinity;
  return Math.max(0, limit - usage.agent_calls);
}

module.exports = {
  newUsage, recordCall, recordTokens, recordCost, recordVerification,
  check, authorize, remainingCalls, effectiveLimit, BudgetError,
};
