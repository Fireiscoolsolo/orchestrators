'use strict';
/**
 * routing - complexity scoring, adaptive model/role routing, review policy.
 * Rules are transparent heuristics. Observed outcome data (learning/routing-stats.json)
 * adjusts them only once a tier has at least `min_samples` recorded tasks.
 */

const TIER_ORDER = ['light', 'standard', 'capable', 'lead', 'lead_oversight'];
const MODEL_RANK = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };
const FACTORS = ['components', 'architecture', 'ambiguity', 'dependencies', 'uncertainty', 'regression_risk', 'security', 'debugging'];
const ROLE_MIN_TIER = { 'review-worker': 1, 'debug-worker': 1, 'integration-worker': 1, 'opus-executor': 3 };
const READ_ONLY_ROLES = ['research-worker', 'review-worker'];

const MODES = {
  fast: { parallel_cap: 3, regression: 'never', description: 'essential verification, orchestrator review, conservative parallelism' },
  balanced: { parallel_cap: 20, regression: 'risky', description: 'structured specs, adaptive routing, relevant tests, orchestrator review' },
  thorough: { parallel_cap: 20, regression: 'always', description: 'broader tests, independent review for complex changes, regression at every integration' },
  maximum: { parallel_cap: 20, regression: 'always', description: 'independent review for every change, dual review for high-risk work, full final audit' },
};

/** Each factor is scored 0-3; the sum (0-24) maps linearly onto 1-10. */
function scoreFromFactors(factors) {
  let sum = 0;
  for (const f of FACTORS) sum += Number(factors[f] || 0);
  return Math.min(10, Math.max(1, 1 + Math.round((sum * 9) / 24)));
}

const bandOf = (score) => (score <= 2 ? 'light' : score <= 4 ? 'standard' : score <= 6 ? 'capable' : score <= 8 ? 'lead' : 'lead_oversight');

function reviewPolicy(contract, mode, role) {
  if (READ_ONLY_ROLES.includes(role)) return { independent: 0, perspectives: [], reason: 'read-only task: orchestrator review of findings' };
  const risky = contract.security_sensitive || contract.risk_level === 'high';
  const score = contract.complexity_score;
  let independent = 0;
  let reason = 'orchestrator review';
  if (mode === 'fast' && risky) { independent = 1; reason = 'fast mode: independent review only for high-risk or security-sensitive work'; }
  if (mode === 'balanced' && (risky || score >= 7)) { independent = 1; reason = 'balanced mode: independent review for high-risk, security-sensitive or complexity >= 7'; }
  if (mode === 'thorough' && (risky || score >= 5 || contract.risk_level !== 'low')) { independent = 1; reason = 'thorough mode: independent review for complexity >= 5 or risk above low'; }
  if (mode === 'maximum') { independent = risky ? 2 : 1; reason = risky ? 'maximum mode: two independent perspectives for high-risk work' : 'maximum mode: independent review for every change'; }
  if (role === 'orchestrator' && independent < 1) { independent = 1; reason = 'orchestrator-implemented work is never self-approved'; }
  const perspectives = independent >= 2 ? ['correctness', 'security'] : independent === 1 ? ['correctness'] : [];
  return { independent, perspectives, reason };
}

/**
 * Route one validated contract.
 * cfg: effective config (routing.*), mode: execution mode, stats: observed outcomes or null.
 */
function route(contract, cfg, mode, stats) {
  const r = cfg.routing;
  const notes = [];
  const band = bandOf(contract.complexity_score);
  let idx = TIER_ORDER.indexOf(band);
  const raise = (to, why) => {
    const target = Math.min(to, TIER_ORDER.length - 1);
    if (target > idx) { idx = target; notes.push(why); }
  };

  if (contract.risk_level === 'high') raise(idx + 1, 'risk_level high: +1 tier');
  if (contract.security_sensitive) raise(contract.complexity_score >= 5 ? 3 : 2, 'security_sensitive: capable tier minimum, lead tier when complexity >= 5');
  if (!r.prefer_lower_cost_models) raise(1, 'prefer_lower_cost_models off: standard tier minimum');

  let role = contract.assigned_role === 'auto' ? 'implementation-worker' : contract.assigned_role;
  if (ROLE_MIN_TIER[role] !== undefined) raise(ROLE_MIN_TIER[role], `${role}: ${TIER_ORDER[ROLE_MIN_TIER[role]]} tier minimum`);

  let basis = 'heuristic';
  if (r.adaptive && stats) {
    const cur = stats[`${TIER_ORDER[idx]}|${band}`];
    if (cur && cur.tasks >= r.min_samples) {
      basis = 'heuristic+observed';
      const rate = cur.first_pass / cur.tasks;
      const next = idx < TIER_ORDER.length - 1 ? stats[`${TIER_ORDER[idx + 1]}|${band}`] : null;
      if (rate < r.min_first_pass_rate && r.allow_escalation && idx < TIER_ORDER.length - 1) {
        notes.push(`observed first-pass rate ${cur.first_pass}/${cur.tasks} for ${TIER_ORDER[idx]} on ${band}-band tasks is below ${r.min_first_pass_rate}: +1 tier`);
        idx++;
        basis = 'observed';
      } else if (next && next.tasks >= r.min_samples && cur.completed > 0 && next.completed > 0 && r.allow_escalation) {
        const w = r.cost_weights;
        const costHere = w[r.tiers[TIER_ORDER[idx]].model] * (cur.dispatches / cur.completed);
        const costNext = w[r.tiers[TIER_ORDER[idx + 1]].model] * (next.dispatches / next.completed);
        if (costNext < costHere) {
          notes.push(`observed expected cost favours ${TIER_ORDER[idx + 1]} (${costNext.toFixed(2)} vs ${costHere.toFixed(2)} cost units per completed task)`);
          idx++;
          basis = 'observed';
        }
      }
    }
  }

  if (role === 'implementation-worker' && idx >= 3) role = 'opus-executor';
  const tier = TIER_ORDER[idx];
  let model = r.tiers[tier].model;
  const effort = r.tiers[tier].effort || null;
  const preferred = contract.preferred_model;
  if (preferred && preferred !== 'auto') {
    if (MODEL_RANK[preferred] >= MODEL_RANK[model]) {
      if (preferred !== model) notes.push(`preferred_model ${preferred} honoured (routed tier asks for ${model})`);
      model = preferred;
    } else {
      notes.push(`preferred_model ${preferred} is below the required ${model}: using ${model}`);
    }
  }
  if (role === 'orchestrator') model = 'inherit';

  return {
    band, tier, role, model, effort, basis, notes,
    cost_units: role === 'orchestrator' ? null : r.cost_weights[model] ?? null,
    oversight: tier === 'lead_oversight',
    review: reviewPolicy(contract, mode, role),
  };
}

/** Next step of the escalation ladder after `tier`, or null when the ladder is exhausted. */
function nextTier(tier) {
  const i = TIER_ORDER.indexOf(tier);
  return i >= 0 && i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : null;
}

/** Fold a finished task into the observed-outcome table. Returns the updated table. */
function recordOutcome(stats, sample) {
  const key = `${sample.tier}|${sample.band}`;
  const s = stats[key] || { tasks: 0, completed: 0, first_pass: 0, dispatches: 0, corrections: 0, escalations: 0, failed: 0 };
  s.tasks++;
  s.dispatches += sample.dispatches;
  s.corrections += sample.corrections;
  s.escalations += sample.escalations;
  if (sample.completed) s.completed++; else s.failed++;
  if (sample.completed && sample.corrections === 0 && sample.dispatches === 1 && sample.escalations === 0) s.first_pass++;
  stats[key] = s;
  return stats;
}

/** Rule-based proposals from observed outcomes. Never applied automatically. */
function proposals(stats, cfg) {
  const out = [];
  const min = cfg.routing.min_samples;
  for (const [key, s] of Object.entries(stats)) {
    const [tier, band] = key.split('|');
    if (s.tasks < min) continue;
    const rate = s.first_pass / s.tasks;
    if (rate < cfg.routing.min_first_pass_rate && nextTier(tier)) {
      out.push({
        kind: 'routing',
        evidence: `${s.first_pass}/${s.tasks} ${band}-band tasks passed first time on the ${tier} tier (${s.corrections} corrections, ${s.escalations} escalations)`,
        proposal: `Route ${band}-band tasks to the ${nextTier(tier)} tier by default.`,
      });
    }
    if (rate === 1 && s.tasks >= min * 2 && TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(band)) {
      out.push({
        kind: 'routing',
        evidence: `${s.tasks}/${s.tasks} ${band}-band tasks passed first time on the ${tier} tier`,
        proposal: `Consider trialling the ${band} tier for ${band}-band tasks; keep verification unchanged while trialling.`,
      });
    }
  }
  return out;
}

module.exports = { TIER_ORDER, MODEL_RANK, FACTORS, MODES, READ_ONLY_ROLES, scoreFromFactors, bandOf, route, reviewPolicy, nextTier, recordOutcome, proposals };
