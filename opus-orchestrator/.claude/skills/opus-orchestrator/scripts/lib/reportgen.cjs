'use strict';
// reportgen.cjs (pure): status summaries and the final report, built from recorded state only.
// Honesty rules (DESIGN section 7): a dollar cost is printed only when a measured cost was
// recorded; tokens are labelled measured or not measured; a task is called verified only when its
// current verification evidence passed.

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const IN_FLIGHT = ['DISPATCHED', 'RUNNING'];

function costText(usage) {
  const u = usage || {};
  if (u.cost_measured === true && typeof u.cost_usd === 'number') return `$${u.cost_usd.toFixed(2)} (measured)`;
  return 'not measured';
}

function tokensText(usage) {
  const u = usage || {};
  if (u.tokens_measured === true) return `${(u.tokens && u.tokens.total) || 0} (measured)`;
  return 'not measured';
}

function budgetLines(check, usage) {
  const lines = [];
  if (!check || check.state === 'disabled') {
    lines.push('budget tracking is disabled');
  } else {
    for (const l of check.limits || []) {
      if (l.name === 'agent_call_limit') {
        lines.push(l.limit == null
          ? `agent calls: ${l.used} used (no limit set)`
          : `agent calls: ${l.used} of ${l.limit} (${Math.round(l.percent)}%, ${l.state})`);
      } else if (l.name === 'token_limit') {
        if (!l.enforceable) lines.push(`tokens: not measured${l.limit == null ? ' (no limit set)' : `; limit ${l.limit} not enforced`}`);
        else lines.push(l.limit == null ? `tokens: ${l.used} measured (no limit set)` : `tokens: ${l.used} of ${l.limit} measured (${Math.round(l.percent)}%, ${l.state})`);
      } else if (l.name === 'cost_limit_usd') {
        if (!l.enforceable) lines.push(`cost: not measured${l.limit == null ? ' (no limit set)' : `; limit $${l.limit} not enforceable in-session`}`);
        else lines.push(l.limit == null ? `cost: ${costText(usage)} (no limit set)` : `cost: ${costText(usage)} of limit $${l.limit} (${Math.round(l.percent)}%, ${l.state})`);
      }
    }
  }
  return lines;
}

function verifiedNow(t) {
  const v = t.evidence && t.evidence.verification;
  return !!(v && v.passed === true);
}

function taskRow(t) {
  const r = t.routing || {};
  return {
    task_id: t.task_id,
    title: t.title,
    status: t.status,
    role: r.role || null,
    agent: r.agent || null,
    model: r.role === 'orchestrator' ? 'self' : (r.model || null), // work the orchestrator does itself has no worker model
    review_round: t.review_round || 0,
    attempts: t.attempts || 0,
    retries: t.retries || 0,
    verified: verifiedNow(t),
    block: t.block || null,
    failure: t.failure || null,
  };
}

/** status object (also the --json output). */
function statusObject(run, tasks, { budgetCheck, context, nextActions } = {}) {
  const rows = (tasks || []).map(taskRow);
  const usage = run.usage || {};
  return {
    run_id: run.run_id,
    objective: run.objective,
    phase: run.phase,
    delivered: run.delivered === true,
    options: run.options || {},
    workspace: run.workspace || {},
    tasks: rows,
    counts: rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
    active: (tasks || []).filter((t) => IN_FLIGHT.includes(t.status)).map((t) => ({
      task_id: t.task_id, agent: (t.routing && t.routing.agent) || null,
      model: t.routing && t.routing.role === 'orchestrator' ? 'self' : ((t.routing && t.routing.model) || null),
      since: t.dispatch ? t.dispatch.at : null,
    })),
    blocked: (tasks || []).filter((t) => t.status === 'BLOCKED').map((t) => ({ task_id: t.task_id, kind: t.block && t.block.kind, reason: t.block && t.block.reason })),
    failed: (tasks || []).filter((t) => t.status === 'FAILED').map((t) => ({ task_id: t.task_id, kind: t.failure && t.failure.kind, reason: t.failure && t.failure.reason })),
    budget: {
      state: budgetCheck ? budgetCheck.state : 'unknown',
      lines: budgetLines(budgetCheck, usage),
      messages: budgetCheck ? budgetCheck.messages : [],
    },
    usage: {
      agent_calls: usage.agent_calls || 0,
      worker_calls: usage.worker_calls || 0,
      review_calls: usage.review_calls || 0,
      verification_runs: usage.verification_runs || 0,
      tokens: tokensText(usage),
      tokens_measured: usage.tokens_measured === true,
      cost: costText(usage),
      cost_measured: usage.cost_measured === true,
    },
    context: context || null,
    next_actions: nextActions || [],
  };
}

function statusText(obj) {
  const o = obj.options || {};
  const lines = [];
  lines.push(`RUN ${obj.run_id} | phase ${obj.phase}${obj.delivered ? ' (delivered)' : ''} | mode ${o.mode} | max workers ${o.max_workers} | review rounds ${o.max_review_rounds} | retries ${o.max_retries}${o.plan_only ? ' | PLAN ONLY' : ''}`);
  lines.push(`Objective: ${String(obj.objective || '').replace(/\s+/g, ' ').trim()}`);
  lines.push(`Workspace: ${(obj.workspace && obj.workspace.strategy) || 'unknown'}${obj.workspace && obj.workspace.integration_branch ? ` (integration branch ${obj.workspace.integration_branch})` : ''}`);
  lines.push(`Tasks (${obj.tasks.length}):`);
  if (!obj.tasks.length) lines.push('  (none planned yet)');
  for (const t of obj.tasks) {
    lines.push(`  ${t.task_id.padEnd(12)} ${t.status.padEnd(20)} ${`${t.role || '-'}/${t.model || '-'}`.padEnd(30)} round ${t.review_round}  attempts ${t.attempts}${t.retries ? `  retries ${t.retries}` : ''}`);
  }
  if (obj.active.length) lines.push(`Active workers: ${obj.active.map((a) => `${a.task_id} (${a.agent || 'orchestrator'}/${a.model || '-'} since ${a.since || '?'})`).join(', ')}`);
  else lines.push('Active workers: none');
  for (const b of obj.blocked) lines.push(`Blocked: ${b.task_id} [${b.kind}] ${b.reason}`);
  for (const f of obj.failed) lines.push(`Failed: ${f.task_id} [${f.kind}] ${f.reason}`);
  lines.push('Budget:');
  for (const l of obj.budget.lines) lines.push(`  ${l}`);
  if (!obj.budget.lines.some((l) => l.startsWith('cost:'))) lines.push(`  cost: ${obj.usage.cost}`);
  lines.push(`  usage: ${obj.usage.agent_calls} agent calls (${obj.usage.worker_calls} worker, ${obj.usage.review_calls} review), ${obj.usage.verification_runs} verification runs, tokens ${obj.usage.tokens}`);
  if (obj.context) lines.push(`Context: ${obj.context.level}: ${obj.context.message}`);
  lines.push('Next actions:');
  if (!obj.next_actions.length) lines.push('  (none)');
  obj.next_actions.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`));
  return lines;
}

function overallStatus(tasks) {
  if (!tasks.length) return 'PARTIAL';
  if (tasks.every((t) => t.status === 'COMPLETED')) return 'COMPLETE';
  if (!tasks.some((t) => t.status === 'COMPLETED')) return 'FAILED';
  return 'PARTIAL';
}

function cmdRows(task) {
  const rows = [];
  const add = (stage, round, list) => {
    for (const c of list || []) {
      const ec = c.refused ? 'refused' : c.timed_out ? 'timed out' : c.exit_code === null || c.exit_code === undefined ? 'none' : String(c.exit_code);
      rows.push({ task_id: task.task_id, stage, round, command: c.command, exit: ec });
    }
  };
  const ev = task.evidence || {};
  for (const r of ev.rounds || []) {
    if (r.verification) add('verification', r.round, r.verification.commands);
    if (r.integration) add('integration', r.round, r.integration.commands);
  }
  if (ev.verification) add('verification', task.review_round || 0, ev.verification.commands);
  if (ev.integration) add('integration', task.review_round || 0, ev.integration.commands);
  return rows;
}

function mdCell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** final-report.md text from recorded state only. */
function finalReport(run, tasks, { now, budgetCheck } = {}) {
  const list = (tasks || []).slice().sort((a, b) => (a.task_id < b.task_id ? -1 : 1));
  const usage = run.usage || {};
  const overall = overallStatus(list);
  const L = [];
  L.push(`# Final report: run ${run.run_id}`, '');
  L.push(`Objective: ${String(run.objective || '').replace(/\s+/g, ' ').trim()}`, '');
  L.push(`Overall status: ${overall}`, '');
  L.push(`Generated ${now || ''} from the recorded run state only. Workspace strategy: ${(run.workspace && run.workspace.strategy) || 'unknown'}. Delivered: ${run.delivered ? 'yes' : 'no'}.`, '');

  L.push('## Tasks by outcome', '');
  const groups = {};
  for (const t of list) (groups[t.status] = groups[t.status] || []).push(t);
  const order = ['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'];
  const statuses = order.filter((s) => groups[s]).concat(Object.keys(groups).filter((s) => !order.includes(s)).sort());
  if (!statuses.length) L.push('No tasks were planned.', '');
  for (const s of statuses) {
    L.push(`### ${s} (${groups[s].length})`, '');
    for (const t of groups[s]) {
      const v = t.evidence && t.evidence.verification;
      const ver = verifiedNow(t)
        ? `verified (${(v.commands || []).length} command(s), ${(v.checks || []).length} check(s), at ${v.run_at})`
        : v ? 'verification FAILED' : 'not verified';
      const integ = t.evidence && t.evidence.integration;
      const intText = integ ? (integ.passed ? `integrated${integ.merged_commit ? ` (merge ${integ.merged_commit})` : ''}` : 'integration failed') : 'not integrated';
      const extra = t.status === 'FAILED' && t.failure ? `; failure ${t.failure.kind}: ${t.failure.reason}`
        : t.status === 'BLOCKED' && t.block ? `; blocked ${t.block.kind}: ${t.block.reason}`
          : t.status === 'CANCELLED' ? `; cancelled: ${((t.history || []).filter((h) => h.to === 'CANCELLED').pop() || {}).reason || ''}` : '';
      L.push(`- ${t.task_id} ${t.title}: ${ver}; ${intText}; review rounds ${t.review_round || 0}; attempts ${t.attempts || 0}${extra}`);
    }
    L.push('');
  }

  L.push('## Verified tasks', '');
  const verified = list.filter(verifiedNow);
  L.push(verified.length ? verified.map((t) => `- ${t.task_id}`).join('\n') : 'None.', '');
  const unverified = list.filter((t) => !verifiedNow(t));
  if (unverified.length) L.push(`Not verified: ${unverified.map((t) => t.task_id).join(', ')}`, '');

  L.push('## Files modified', '');
  const files = new Map();
  for (const t of list) {
    const v = t.evidence && t.evidence.verification;
    for (const f of (v && v.changed_files) || []) files.set(`${f}\u0000${t.task_id}`, { f, id: t.task_id, src: 'observed by verification' });
    for (const f of (t.result && t.result.files_changed) || []) {
      if (!files.has(`${f}\u0000${t.task_id}`)) files.set(`${f}\u0000${t.task_id}`, { f, id: t.task_id, src: 'reported by the worker' });
    }
  }
  if (!files.size) L.push('None recorded.');
  for (const x of [...files.values()].sort((a, b) => (a.f < b.f ? -1 : 1))) L.push(`- ${x.f} (${x.id}, ${x.src})`);
  L.push('');

  L.push('## Commands executed', '');
  const rows = list.flatMap(cmdRows);
  if (!rows.length) {
    L.push('No command was executed by the orchestrator.');
  } else {
    L.push('| task | stage | round | command | exit code |', '|---|---|---|---|---|');
    for (const r of rows) L.push(`| ${r.task_id} | ${r.stage} | ${r.round} | \`${mdCell(r.command)}\` | ${r.exit} |`);
  }
  L.push('');

  L.push('## Verification outcomes', '');
  for (const t of list) {
    const v = t.evidence && t.evidence.verification;
    const rounds = ((t.evidence && t.evidence.rounds) || []).filter((r) => r.verification);
    const past = rounds.map((r) => `round ${r.round} ${r.verification.passed ? 'passed' : 'failed'}`);
    const cur = v ? `current round ${t.review_round || 0} ${v.passed ? 'passed' : `failed (${(v.reasons || []).join('; ')})`}` : 'current round not verified';
    L.push(`- ${t.task_id}: ${past.concat([cur]).join(', ')}`);
  }
  if (!list.length) L.push('None.');
  L.push('');

  L.push('## Limitations', '');
  const lim = [];
  if (usage.cost_measured !== true) lim.push('Dollar cost was not measured in this session.');
  if (usage.tokens_measured !== true) lim.push('Token usage was not measured.');
  if (overall !== 'COMPLETE') lim.push(`Not every task completed: ${list.filter((t) => t.status !== 'COMPLETED').map((t) => `${t.task_id} (${t.status})`).join(', ') || 'no tasks'}.`);
  if (!run.delivered && run.workspace && run.workspace.strategy === 'worktree') lim.push('The integration branch has not been delivered to the user branch.');
  L.push(lim.length ? lim.map((x) => `- ${x}`).join('\n') : '- None recorded.', '');

  L.push('## Risks', '');
  const risks = [];
  for (const t of list) {
    if (t.risk === 'high' || t.security_sensitive) risks.push(`${t.task_id} is ${t.security_sensitive ? 'security sensitive' : 'high risk'} (status ${t.status}).`);
    if (t.side_effects === 'external') risks.push(`${t.task_id} has external side effects (status ${t.status}).`);
    if (t.status === 'FAILED' || t.status === 'BLOCKED') risks.push(`${t.task_id} did not finish: ${t.status}.`);
  }
  L.push(risks.length ? risks.map((x) => `- ${x}`).join('\n') : '- None recorded.', '');

  L.push('## Usage', '');
  L.push(`- Agent calls: ${usage.agent_calls || 0} (worker ${usage.worker_calls || 0}, review ${usage.review_calls || 0}, retries ${usage.retries || 0}, corrections ${usage.corrections || 0})`);
  L.push(`- Verification runs: ${usage.verification_runs || 0}`);
  L.push(`- Tokens: ${tokensText(usage)}`);
  L.push(`- Cost: ${costText(usage)}`);
  for (const b of budgetLines(budgetCheck, usage)) L.push(`- Budget: ${b}`);
  L.push('');
  return { text: L.join('\n'), overall };
}

module.exports = { statusObject, statusText, finalReport, overallStatus, costText, tokensText, budgetLines, TERMINAL };
