'use strict';
// checkpoint.cjs: checkpoint build/write/read, resume summary, context utilization advice.
// Uses store.cjs (file I/O) and yaml.cjs. Never prints, never calls process.exit.
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store.cjs');
const yaml = require('./yaml.cjs');

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const DEFAULT_MAX_LINES = 120;
const DEFAULT_MAX_AGE_SECONDS = 600;
const MAX_LINE_CHARS = 240;

function str(v) {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function oneLine(v, max) {
  const s = str(v).replace(/\s+/g, ' ').trim();
  const limit = max || MAX_LINE_CHARS;
  return s.length > limit ? `${s.slice(0, limit - 3)}...` : s;
}

function toTime(now) {
  if (now === undefined || now === null) return Date.now();
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  const t = Date.parse(now);
  return Number.isNaN(t) ? Date.now() : t;
}

function toIso(now) {
  return new Date(toTime(now)).toISOString();
}

function isUnfinished(tasks) {
  return Array.isArray(tasks) && tasks.some((t) => t && !TERMINAL.includes(t.status));
}

function byIdMap(tasks) {
  const m = {};
  for (const t of tasks) m[t.task_id] = t;
  return m;
}

function sortedTasks(tasks) {
  return (tasks || [])
    .filter((t) => t && t.task_id)
    .slice()
    .sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
}

function depsDone(task, byId) {
  return (task.dependencies || []).every((d) => byId[d] && byId[d].status === 'COMPLETED');
}

function dispatchedSince(task) {
  const h = Array.isArray(task.history) ? task.history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i] && h[i].to === 'DISPATCHED') return h[i].ts || null;
  }
  return null;
}

function correctionRound(task) {
  const c = task.correction;
  if (c && Number.isInteger(c.round)) return c.round;
  const r = Number.isInteger(task.review_round) ? task.review_round : 0;
  return task.status === 'CORRECTION_REQUIRED' ? r + 1 : r;
}

function lastFailingCommand(task) {
  const v = task.evidence && task.evidence.verification;
  if (!v || !Array.isArray(v.commands)) return null;
  const bad = v.commands.find((c) => c && (c.exit_code !== 0 || c.refused || c.timed_out));
  return bad ? `verification command failed: ${oneLine(bad.command, 120)} (exit ${bad.exit_code})` : null;
}

// ---------------------------------------------------------------- nextActions

const ACTION_ORDER = ['RUNNING', 'DISPATCHED', 'IMPLEMENTED', 'VERIFYING', 'REVIEWING',
  'CORRECTION_REQUIRED', 'APPROVED', 'INTEGRATING', 'BLOCKED'];

function nextActions(run, tasks) {
  const list = sortedTasks(tasks);
  const byId = byIdMap(list);
  const lines = [];
  for (const status of ACTION_ORDER) {
    for (const t of list) {
      if (t.status !== status) continue;
      const id = t.task_id;
      switch (status) {
        case 'RUNNING':
          lines.push(`oo result ${id} --stdin (ingest the worker result of attempt ${(t.dispatch && t.dispatch.attempt_id) || '?'}; if its agent is known to have stopped: oo reconcile ${id} --attempt ${(t.dispatch && t.dispatch.attempt_id) || '<attempt id>'} --agent-gone --reason <text>)`);
          break;
        case 'DISPATCHED':
          lines.push(`oo started ${id} once its agent is launched, then oo result ${id} --stdin (if its agent is known to have stopped: oo reconcile ${id} --attempt ${(t.dispatch && t.dispatch.attempt_id) || '<attempt id>'} --agent-gone --reason <text>)`);
          break;
        case 'IMPLEMENTED':
          lines.push(`oo verify ${id} (run independent verification of the reported result)`);
          break;
        case 'VERIFYING':
          lines.push(`oo verify ${id} (verification was in progress; re-run it or record a manual check with oo check)`);
          break;
        case 'REVIEWING': {
          const reviews = (t.evidence && t.evidence.reviews) || [];
          const approvals = reviews.filter((r) => r && r.independent === true && r.verdict === 'approve').length;
          const modes = (run && run.config && run.config.verification && run.config.verification.modes) || {};
          const modeCfg = modes[run && run.options && run.options.mode] || {};
          const needed = t.risk === 'high' && Number.isInteger(modeCfg.reviewers_high_risk) && modeCfg.reviewers_high_risk > 1 ? modeCfg.reviewers_high_risk : 1;
          const needsIndependent = t.routing && t.routing.independent_review === true && approvals < needed;
          if (needsIndependent) {
            lines.push(`oo review-package ${id} (independent review required${needed > 1 ? `: ${needed} approving reviews for a high-risk task, ${approvals} so far` : ''}; dispatch the reviewer and ingest its report with oo review ${id} --stdin)`);
          } else {
            lines.push(`oo review ${id} --stdin (awaiting Opus quality gate)`);
          }
          break;
        }
        case 'CORRECTION_REQUIRED':
          lines.push(`oo correct ${id} --stdin (write the correction request for round ${correctionRound(t)})`);
          break;
        case 'APPROVED':
          lines.push(`oo integrate ${id} (approved, awaiting integration)`);
          break;
        case 'INTEGRATING':
          lines.push(`oo integrate ${id} (integration was in progress; check the integration state and finish it)`);
          break;
        case 'BLOCKED': {
          const b = t.block || {};
          lines.push(`Resolve the block on ${id} (${oneLine(b.kind || 'manual', 40)}: ${oneLine(b.reason || 'no reason recorded', 120)}), then oo unblock ${id} --reason <text> or ask the user`);
          break;
        }
        default:
          break;
      }
    }
  }
  const dispatchable = list.filter((t) => t.status === 'READY' || (t.status === 'PENDING' && depsDone(t, byId)))
    .map((t) => t.task_id);
  if (dispatchable.length > 0) {
    const shown = dispatchable.slice(0, 10).join(', ');
    const more = dispatchable.length > 10 ? ` and ${dispatchable.length - 10} more` : '';
    lines.push(`oo next (dispatch ready work: ${shown}${more})`);
  }
  for (const t of list) {
    if (t.status !== 'PENDING') continue;
    const dead = (t.dependencies || []).filter((d) => byId[d] && (byId[d].status === 'FAILED' || byId[d].status === 'CANCELLED'));
    if (dead.length > 0) {
      lines.push(`Resolve ${t.task_id}: it waits on ${dead.join(', ')} which will not complete; escalate, reopen, amend or cancel it`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------- buildCheckpoint

function buildCheckpoint(run, tasks, now) {
  const r = run || {};
  const list = sortedTasks(tasks);
  const usage = r.usage || {};
  const tokens = usage.tokens || {};

  const spec_revisions = {};
  const task_graph = {};
  const task_statuses = {};
  const verification_evidence = {};
  const known_failures = [];
  const pending_corrections = [];
  const active_agents = [];
  const files = new Set();

  for (const t of list) {
    const id = t.task_id;
    spec_revisions[id] = Number.isInteger(t.spec_revision) ? t.spec_revision : 1;
    task_graph[id] = Array.isArray(t.dependencies) ? t.dependencies.slice() : [];
    task_statuses[id] = t.status;
    if (t.status === 'DISPATCHED' || t.status === 'RUNNING') {
      const ro = t.routing || {};
      active_agents.push({
        task_id: id,
        role: ro.role || null,
        agent: ro.agent || null,
        model: ro.model || null,
        since: dispatchedSince(t),
      });
    }
    if (t.result && Array.isArray(t.result.files_changed)) {
      for (const f of t.result.files_changed) if (typeof f === 'string') files.add(f);
    }
    const v = t.evidence && t.evidence.verification;
    if (v) {
      verification_evidence[id] = {
        passed: v.passed === undefined ? null : v.passed,
        commands: Array.isArray(v.commands) ? v.commands.length : 0,
      };
    }
    if (t.failure) {
      known_failures.push({ task_id: id, kind: str(t.failure.kind) || 'unknown', reason: str(t.failure.reason) });
    }
    const hasCorrection = t.correction && typeof t.correction === 'object';
    if (!TERMINAL.includes(t.status) && (hasCorrection || t.status === 'CORRECTION_REQUIRED')) {
      const c = hasCorrection ? t.correction : {};
      pending_corrections.push({
        task_id: id,
        round: correctionRound(t),
        failure: str(c.failure) || lastFailingCommand(t) || '(correction request not written yet)',
        required_change: str(c.required_change) || '(not written yet)',
      });
    }
  }

  const decisions = (Array.isArray(r.decisions) ? r.decisions : [])
    .map((d) => (d && typeof d === 'object' ? str(d.text) : str(d)))
    .filter((s) => s !== '');

  const cp = {
    run_id: r.run_id || null,
    written_at: toIso(now),
    objective: str(r.objective),
    options: r.options && typeof r.options === 'object' ? r.options : {},
    phase: r.phase || null,
    spec_revisions,
    task_graph,
    task_statuses,
    active_agents,
    decisions,
    modified_files: Array.from(files).sort(),
    verification_evidence,
    known_failures,
    pending_corrections,
    next_actions: nextActions(r, list),
    usage: {
      agent_calls: Number.isFinite(usage.agent_calls) ? usage.agent_calls : 0,
      tokens_total: Number.isFinite(tokens.total) ? tokens.total : 0,
      tokens_measured: usage.tokens_measured === true,
    },
  };
  return JSON.parse(JSON.stringify(cp));
}

// ---------------------------------------------------------------- write / read

function checkpointFile(paths, runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new store.StoreError('NO_RUN', `invalid run id: ${runId}`);
  }
  return path.join(paths.runsDir, runId, 'checkpoint.yaml');
}

function writeCheckpoint(paths, runId, cp) {
  const file = checkpointFile(paths, runId);
  store.atomicWrite(file, yaml.stringify(cp));
  return file;
}

function readCheckpoint(paths, runId) {
  let id = runId;
  if (!id) {
    try {
      id = fs.readFileSync(paths.currentFile, 'utf8').trim();
    } catch (_) {
      id = '';
    }
    if (!id) throw new store.StoreError('NO_RUN', 'no current run');
  }
  const file = checkpointFile(paths, id);
  let missing = 0;
  for (const f of [file, `${file}.bak`]) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (_) {
      missing += 1;
      continue;
    }
    try {
      const v = yaml.parse(text);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch (_) { /* try the backup */ }
  }
  if (missing === 2) throw new store.StoreError('MISSING', `checkpoint not found for run ${id}`);
  throw new store.StoreError('CORRUPT', `checkpoint is unreadable for run ${id}`);
}

// ---------------------------------------------------------------- renderResume

function renderResume(cp, opts) {
  const c = cp || {};
  let maxLines = opts && Number.isInteger(opts.maxLines) && opts.maxLines >= 1 ? opts.maxLines : DEFAULT_MAX_LINES;
  if (maxLines < 1) maxLines = DEFAULT_MAX_LINES;

  const statuses = c.task_statuses || {};
  const graph = c.task_graph || {};
  const revs = c.spec_revisions || {};
  const ids = Object.keys(statuses).sort();
  const completed = ids.filter((id) => statuses[id] === 'COMPLETED');
  const open = ids.filter((id) => statuses[id] !== 'COMPLETED');
  const active = {};
  for (const a of c.active_agents || []) if (a && a.task_id) active[a.task_id] = a;
  const evidence = c.verification_evidence || {};

  const options = c.options && typeof c.options === 'object'
    ? Object.keys(c.options).map((k) => `${k}=${oneLine(c.options[k], 40)}`).join(' ')
    : '';
  const usage = c.usage || {};

  const fixed = [
    oneLine(`RESUME opus-orchestrator run ${c.run_id || '(unknown)'} (checkpoint written ${c.written_at || 'unknown'})`),
    'The state on disk is authoritative; this summary is derived from it. Re-read it with oo resume or oo status.',
    oneLine(`Objective: ${c.objective || '(none recorded)'}`),
    oneLine(`Options: ${options || '(none)'}; phase: ${c.phase || 'unknown'}`),
    oneLine(`Usage: ${usage.agent_calls || 0} agent calls; tokens ${usage.tokens_total || 0} (${usage.tokens_measured ? 'measured' : 'not measured'})`),
  ];
  const completedLine = completed.length > 0
    ? `Completed tasks (${completed.length}): ${completed.join(', ')}`
    : 'Completed tasks (0)';

  const taskItems = open.map((id) => {
    const parts = [`${id} ${statuses[id]}`];
    const deps = graph[id] || [];
    if (deps.length > 0) parts.push(`deps: ${deps.join(',')}`);
    const a = active[id];
    if (a) parts.push(`agent: ${a.agent || '?'}/${a.model || '?'} since ${a.since || '?'}`);
    if (evidence[id]) parts.push(`verification: ${evidence[id].passed === true ? 'passed' : evidence[id].passed === false ? 'failed' : 'n/a'}`);
    if (revs[id] && revs[id] > 1) parts.push(`spec rev ${revs[id]}`);
    return oneLine(`- ${parts.join('; ')}`);
  });
  const decisions = (c.decisions || []).map((d) => oneLine(`- ${d}`));
  const failures = (c.known_failures || []).map((f) => oneLine(`- ${f.task_id} [${f.kind}]: ${f.reason}`));
  const corrections = (c.pending_corrections || []).map((p) =>
    oneLine(`- ${p.task_id} round ${p.round}: ${p.failure} => ${p.required_change}`));
  const actions = (c.next_actions || []).map((a, i) => oneLine(`${i + 1}. ${a}`));

  // display order; allocation priority is the order of `priority`
  const sections = {
    decisions: { title: 'Decisions:', items: decisions, keep: 'tail' },
    tasks: { title: `Tasks not completed (${open.length}):`, items: taskItems },
    failures: { title: 'Known failures:', items: failures },
    corrections: { title: 'Pending corrections:', items: corrections },
    actions: { title: 'Next actions:', items: actions },
  };
  const display = ['decisions', 'tasks', 'failures', 'corrections', 'actions'];
  const priority = ['actions', 'corrections', 'tasks', 'failures', 'decisions'];

  let remaining = maxLines - fixed.length - 1; // 1 for the completed line
  const grant = {};
  for (const k of display) grant[k] = 0;
  let progress = true;
  while (remaining > 0 && progress) {
    progress = false;
    for (const k of priority) {
      const s = sections[k];
      if (grant[k] >= s.items.length) continue;
      const cost = grant[k] === 0 ? 2 : 1;
      if (remaining >= cost) {
        grant[k] += 1;
        remaining -= cost;
        progress = true;
      }
    }
  }

  const out = fixed.slice();
  out.push(completedLine);
  for (const k of display) {
    const s = sections[k];
    const g = grant[k];
    if (s.items.length === 0 || g === 0) continue;
    out.push(s.title);
    if (g >= s.items.length) {
      out.push(...s.items);
    } else {
      const shown = g - 1;
      const hidden = s.items.length - shown;
      if (s.keep === 'tail') {
        out.push(`... ${hidden} earlier not shown (run oo status)`);
        if (shown > 0) out.push(...s.items.slice(s.items.length - shown));
      } else {
        if (shown > 0) out.push(...s.items.slice(0, shown));
        out.push(`... ${hidden} more not shown (run oo status)`);
      }
    }
  }
  return out.slice(0, maxLines).join('\n');
}

// ---------------------------------------------------------------- utilization

// Returns utilization as a fraction (0..1) so it compares directly with the configured target.
function readUtilization(paths, opts) {
  const o = opts || {};
  const nowMs = toTime(o.now);
  const maxAge = Number.isFinite(o.maxAgeSeconds) ? o.maxAgeSeconds : DEFAULT_MAX_AGE_SECONDS;
  let data;
  try {
    data = store.readJson(paths.contextFile).value;
  } catch (_) {
    return { utilization: null, source: 'none', age_seconds: null };
  }
  if (!data || typeof data !== 'object'
    || typeof data.used_percentage !== 'number' || !Number.isFinite(data.used_percentage)
    || data.used_percentage < 0 || data.used_percentage > 100) {
    return { utilization: null, source: 'none', age_seconds: null };
  }
  const ts = typeof data.ts === 'string' || typeof data.ts === 'number' ? Date.parse(data.ts) : NaN;
  if (Number.isNaN(ts)) return { utilization: null, source: 'stale', age_seconds: null };
  const age = Math.max(0, Math.round((nowMs - ts) / 1000));
  if (age > maxAge) return { utilization: null, source: 'stale', age_seconds: age };
  return {
    utilization: data.used_percentage / 100,
    used_percentage: data.used_percentage,
    context_window_size: typeof data.context_window_size === 'number' ? data.context_window_size : null,
    source: data.source === 'user' ? 'user' : 'statusline', // a figure typed with oo context is the user's; the bridge writes none
    age_seconds: age,
  };
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

function contextAdvice(utilization, target) {
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) {
    return {
      level: 'unknown',
      message: 'Context utilization is unknown: no fresh status line data. A skill cannot read it directly; '
        + 'the user can check it with /context. State is checkpointed on disk either way.',
    };
  }
  const tgt = typeof target === 'number' && Number.isFinite(target) ? target : 0.6;
  if (utilization > tgt) {
    return {
      level: 'over_target',
      message: `Context utilization is about ${pct(utilization)}, above the target of ${pct(tgt)}. `
        + 'This skill cannot start compaction. At a safe point (no worker mid-flight) ask the user to run /compact; '
        + 'state is on disk and oo resume restores the summary afterwards.',
    };
  }
  return {
    level: 'ok',
    message: `Context utilization is about ${pct(utilization)}, within the target of ${pct(tgt)}.`,
  };
}

module.exports = {
  buildCheckpoint,
  nextActions,
  writeCheckpoint,
  readCheckpoint,
  renderResume,
  readUtilization,
  contextAdvice,
  isUnfinished,
};
