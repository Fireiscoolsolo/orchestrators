'use strict';
// Adaptive cost-aware routing (pure: no I/O, no clock).
// relative_cost values are unitless planning weights from configuration, not prices.
// heuristic_expected_attempts are stated heuristics, not measured probabilities.

const ORDER = ['haiku', 'sonnet', 'opus'];

const KIND_ROLE = {
  implementation: 'implementation-worker',
  research: 'research-worker',
  test: 'test-worker',
  verification: 'verification-worker',
  review: 'review-worker',
  debug: 'debug-worker',
  documentation: 'documentation-worker',
  integration: 'integration-worker',
  security: 'security-worker',
  repository: 'repository-worker',
};

function band(complexity) {
  const c = Number(complexity);
  if (c <= 2) return '1-2';
  if (c <= 4) return '3-4';
  if (c <= 6) return '5-6';
  if (c <= 8) return '7-8';
  return '9-10';
}

function rank(model) {
  const i = ORDER.indexOf(model);
  return i < 0 ? 0 : i;
}

function roleFor(spec, config) {
  void config;
  if (spec && spec.assigned_role && spec.assigned_role !== 'auto') return spec.assigned_role;
  const kind = (spec && spec.kind) || 'implementation';
  return KIND_ROLE[kind] || 'implementation-worker';
}

function tierFor(complexity) {
  const b = band(complexity);
  return { '1-2': 'direct', '3-4': 'targeted', '5-6': 'reviewed', '7-8': 'oversight', '9-10': 'opus_led' }[b];
}

function effectiveRisk(spec) {
  if (spec.risk) return spec.risk;
  const c = Number(spec.complexity);
  if (c >= 8 || spec.security_sensitive) return 'high';
  if (c >= 5) return 'medium';
  return 'low';
}

function route(spec, config, stats = null, mode = 'balanced') {
  const reasons = [];
  const models = config.models || {};
  const rcfg = config.routing || {};
  const allowed = (models.allowed || ORDER).slice().sort((a, b) => rank(a) - rank(b));
  const complexity = Number(spec.complexity);
  const risk = effectiveRisk(spec);
  const b = band(complexity);
  const cost = models.relative_cost || {};
  const role = roleFor(spec, config);

  // Floor
  const floors = [];
  if (spec.assigned_model && spec.assigned_model !== 'auto') {
    floors.push(spec.assigned_model);
    reasons.push(`rule explicit_assigned_model: assigned_model ${spec.assigned_model} is a floor`);
  }
  if (complexity >= 9) {
    floors.push('opus');
    reasons.push(`rule complexity_9_10: complexity ${complexity} requires opus`);
  }
  if (risk === 'high' && (spec.security_sensitive || complexity >= 7)) {
    floors.push('opus');
    reasons.push('rule high_risk_sensitive: high-risk task that is security sensitive or complexity 7 or more requires opus');
  }
  const factors = spec.complexity_factors || {};
  if (factors.architectural_impact === 3) {
    floors.push('opus');
    reasons.push('rule architectural_impact_3: architectural_impact 3 requires opus');
  }
  let defaultFloor = models.worker_default || 'haiku';
  if (rcfg.prefer_haiku === false) {
    const nonHaiku = allowed.filter((m) => m !== 'haiku');
    if (nonHaiku.length) defaultFloor = nonHaiku[0];
    reasons.push(`rule prefer_haiku_false: default floor is ${defaultFloor}, the cheapest allowed model that is not haiku`);
  } else if (!floors.length) {
    reasons.push(`rule default_floor: worker_default ${defaultFloor} is the floor`);
  }
  floors.push(defaultFloor);
  const floor = floors.reduce((a, m) => (rank(m) > rank(a) ? m : a), floors[0]);

  // Candidates
  let candidates = allowed.filter((m) => rank(m) >= rank(floor));
  if (rcfg.allow_opus_escalation === false && floor !== 'opus') {
    const before = candidates.length;
    candidates = candidates.filter((m) => m !== 'opus');
    if (candidates.length !== before) reasons.push('rule allow_opus_escalation_false: opus removed from candidates');
  }
  if (!candidates.length) candidates = [floor];

  const minObs = rcfg.min_observations == null ? 5 : rcfg.min_observations;
  const heur = rcfg.heuristic_expected_attempts || {};
  const scored = candidates.map((m) => {
    const s = stats && stats[m] && stats[m][b];
    let attempts;
    let basis;
    if (s && s.tasks >= minObs) {
      attempts = s.mean_attempts;
      basis = 'observed';
    } else {
      const h = heur[m] && heur[m][b];
      attempts = h == null ? 1 : h;
      basis = 'heuristic';
    }
    const rc = cost[m] == null ? 1 : cost[m];
    return { model: m, expected_attempts: attempts, relative_cost: rc, expected_cost: rc * attempts, basis };
  });

  let chosen;
  if (rcfg.adaptive === false) {
    chosen = scored.find((c) => c.model === floor) || scored[0];
    reasons.push(`rule adaptive_false: choosing the floor ${chosen.model}`);
  } else {
    chosen = scored[0];
    for (const c of scored) if (c.expected_cost < chosen.expected_cost) chosen = c;
    reasons.push(
      `rule adaptive_cost: ${chosen.model} has the lowest expected cost (unitless relative_cost weight times expected attempts, ${chosen.basis} basis)`
    );
    if (floor === 'haiku' && chosen.model !== 'haiku') {
      reasons.push(`rule haiku_outcompeted: a stronger model has lower expected cost than haiku for band ${b}`);
    }
  }
  if (stats === null || stats === undefined) reasons.push('no observed statistics supplied; heuristic_expected_attempts used');

  // Verification
  const vmode = (config.verification && config.verification.modes && config.verification.modes[mode]) || {};
  const ir = vmode.independent_review || {};
  let independent = false;
  if (ir.min_complexity != null && complexity >= ir.min_complexity) independent = true;
  if (Array.isArray(ir.risks) && ir.risks.includes(risk)) independent = true;
  if (independent) reasons.push(`rule review_mode_${mode}: mode ${mode} requires independent review for this task`);
  const ev = config.execution && config.execution.independent_verification;
  if (ev === false && risk === 'low') {
    independent = false;
    reasons.push('rule independent_verification_false: low-risk task skips independent review');
  }
  if (spec.security_sensitive) {
    independent = true;
    reasons.push('rule security_sensitive: independent review always required');
  }

  const layers = ['self_check'];
  if (Array.isArray(spec.verification_commands) && spec.verification_commands.length) layers.push('automated');
  if (independent) layers.push('independent_review');
  layers.push('opus_gate', 'integration');

  const roleCfg = (rcfg.roles && rcfg.roles[role]) || {};
  return {
    role,
    agent: roleCfg.agent || null,
    model: chosen.model,
    tier: tierFor(complexity),
    independent_review: independent,
    verification_layers: layers,
    reasons,
    decision_basis: chosen.basis,
    candidates: scored,
  };
}

function escalation(task, config, { failure_kind } = {}) {
  const attempts = task.attempts || 0;
  const retries = task.retries || 0;
  const maxRetries = (config.execution && config.execution.max_retries) == null ? 2 : config.execution.max_retries;
  const current = (task.routing && task.routing.model) || (task.assigned_model !== 'auto' && task.assigned_model) || (config.models && config.models.worker_default) || 'haiku';
  if (failure_kind === 'needs_decomposition') {
    return { action: 'decompose', model: current, reason: 'worker reported the task needs decomposition' };
  }
  if (failure_kind === 'permission' || failure_kind === 'budget') {
    return { action: 'ask_user', model: current, reason: `failure kind ${failure_kind} needs a user decision` };
  }
  if (['rate_limit', 'timeout', 'crash'].includes(failure_kind) && retries < maxRetries && attempts < 2) {
    return { action: 'retry_same', model: current, reason: `transient failure ${failure_kind}; retry ${retries + 1} of ${maxRetries}` };
  }
  if (attempts >= 2) {
    const allowEsc = !config.routing || config.routing.allow_opus_escalation !== false;
    if (current !== 'opus' && allowEsc) {
      return {
        action: 'escalate_model',
        model: (config.models && config.models.escalation) || 'opus',
        reason: `${attempts} attempts on ${current}; unchanged strategy is not repeated, escalating`,
      };
    }
    return { action: 'ask_user', model: current, reason: `${attempts} attempts and no escalation available; user decision needed` };
  }
  return { action: 'targeted_correction', model: current, reason: 'fewer than two attempts; send a targeted correction' };
}

function performanceStats(observations) {
  const stats = {};
  for (const o of observations || []) {
    if (!o || o.category !== 'worker_outcome' || !o.data) continue;
    const { model, complexity, attempts, first_pass } = o.data;
    if (!model || complexity == null) continue;
    const b = band(complexity);
    stats[model] = stats[model] || {};
    const s = (stats[model][b] = stats[model][b] || { tasks: 0, first_pass: 0, attempts_total: 0, mean_attempts: 0 });
    s.tasks += 1;
    if (first_pass) s.first_pass += 1;
    s.attempts_total += Number(attempts) || 0;
    s.mean_attempts = s.attempts_total / s.tasks;
  }
  return stats;
}

module.exports = { band, roleFor, route, escalation, performanceStats };
