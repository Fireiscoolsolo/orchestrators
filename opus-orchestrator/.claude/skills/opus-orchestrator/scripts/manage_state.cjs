#!/usr/bin/env node
'use strict';
// manage_state.cjs: thin CLI over store.cjs and statemachine.cjs for inspection and repair.
//
//   node manage_state.cjs show [<ID>] [--run <run id>]   run summary, or one task record as JSON
//   node manage_state.cjs transitions                    the state machine table and guards
//   node manage_state.cjs integrity [--run <run id>]     checks run.json and every task file; restores from .bak
//   node manage_state.cjs events [--tail N] [--run <run id>]
//
// Exit codes: 0 success; 1 refused (no run, unknown task, integrity problems); 2 usage error.
// It never changes task states: transitions go through oo.cjs so that every guard applies.

const store = require('./lib/store.cjs');
const sm = require('./lib/statemachine.cjs');
const { parseArgv, checkAllowed, ArgError } = require('./lib/cliargs.cjs');

const USAGE = 'usage: node manage_state.cjs show [<ID>] | transitions | integrity | events [--tail N]   (optional --run <run id>)';

function loadRunOrNull(paths, runId, out) {
  try {
    return store.loadRun(paths, runId || undefined);
  } catch (e) {
    out.push(`REFUSED: no run to inspect (${e.code}: ${e.message})`, 'NEXT: start a run with oo init <objective>, or pass --run <run id>');
    return null;
  }
}

function show(paths, a, out) {
  const run = loadRunOrNull(paths, a.opts.run, out);
  if (!run) return 1;
  const id = a.pos[1];
  if (id) {
    try {
      out.push(JSON.stringify(store.loadTask(paths, run.run_id, id), null, 2));
      return 0;
    } catch (e) {
      out.push(`REFUSED: ${e.code}: ${e.message}`, 'NEXT: node manage_state.cjs show (lists the task ids)');
      return 1;
    }
  }
  const tasks = store.listTasks(paths, run.run_id);
  out.push(`run ${run.run_id} | phase ${run.phase} | created ${run.created_at} | updated ${run.updated_at}`);
  out.push(`objective: ${String(run.objective || '').replace(/\s+/g, ' ').trim()}`);
  out.push(`options: ${JSON.stringify(run.options || {})}`);
  out.push(`workspace: ${JSON.stringify(run.workspace || {})}`);
  out.push(`tasks (${tasks.length}):`);
  for (const t of tasks) out.push(`  ${t.task_id} ${t.status} round ${t.review_round || 0} attempts ${t.attempts || 0} retries ${t.retries || 0}`);
  out.push(`runs on disk: ${store.listRuns(paths).join(', ') || 'none'}`);
  return 0;
}

function integrity(paths, a, out) {
  const run = loadRunOrNull(paths, a.opts.run, out);
  if (!run) return 1;
  const r = store.withLock(paths, () => store.checkIntegrity(paths, run.run_id));
  out.push(`integrity of run ${run.run_id}: ${r.ok ? 'ok' : 'PROBLEMS'}`);
  for (const f of r.recovered) out.push(`  restored from backup: ${f} (the backup holds the version before the last save)`);
  for (const p of r.problems) out.push(`  problem: ${p}`);
  return r.ok ? 0 : 1;
}

function events(paths, a, out) {
  const run = loadRunOrNull(paths, a.opts.run, out);
  if (!run) return 1;
  let list = store.readEvents(paths, run.run_id);
  if (a.opts.tail !== undefined) {
    if (!/^\d+$/.test(String(a.opts.tail))) throw new ArgError('--tail must be a non-negative integer');
    const n = Number(a.opts.tail);
    list = n === 0 ? [] : list.slice(-n);
  }
  for (const e of list) out.push(JSON.stringify(e));
  return 0;
}

function main(argv) {
  const out = [];
  let code = 0;
  try {
    const a = parseArgv(argv);
    const cmd = a.pos[0];
    const paths = store.resolvePaths();
    if (cmd === 'show') {
      checkAllowed(a.opts, ['run'], 'show');
      code = show(paths, a, out);
    } else if (cmd === 'transitions') {
      checkAllowed(a.opts, [], 'transitions');
      out.push(sm.describe());
    } else if (cmd === 'integrity') {
      checkAllowed(a.opts, ['run'], 'integrity');
      code = integrity(paths, a, out);
    } else if (cmd === 'events') {
      checkAllowed(a.opts, ['run', 'tail'], 'events');
      code = events(paths, a, out);
    } else {
      out.push(USAGE);
      code = 2;
    }
  } catch (e) {
    if (e instanceof ArgError) {
      out.push(`USAGE ERROR: ${e.message}`, USAGE);
      code = 2;
    } else {
      out.push(`ERROR: ${e.code ? `${e.code}: ` : ''}${e.message}`);
      code = 1;
    }
  }
  if (out.length) process.stdout.write(out.join('\n') + '\n');
  return code;
}

module.exports = { main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
