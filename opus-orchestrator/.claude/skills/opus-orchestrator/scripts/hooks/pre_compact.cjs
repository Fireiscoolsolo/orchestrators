'use strict';
// PreCompact hook. Writes a checkpoint and, when a current unfinished run exists, prints
// plain instructions for the compaction summary. Never blocks compaction: always exits 0.
const path = require('node:path');
const checkpoint = require('../lib/checkpoint.cjs');
const store = require('../lib/store.cjs');
const common = require('./_common.cjs');

function main(payload) {
  if (!payload) return '';
  const paths = common.locatePaths([payload.cwd]);
  let { run, tasks } = common.loadCurrent(paths);
  if (!checkpoint.isUnfinished(tasks)) return '';

  const cfgCtx = (run.config && run.config.context) || {};
  let cp = checkpoint.buildCheckpoint(run, tasks, new Date());
  let written = false;
  if (cfgCtx.checkpoint_before_compaction !== false) {
    // The checkpoint is written under the state lock, from state read under it, so it never
    // interleaves with an oo command's writes. A busy lock is waited for briefly; if it stays
    // busy the checkpoint oo itself wrote after its last change stands, and compaction goes on.
    try {
      store.withLock(paths, () => {
        ({ run, tasks } = common.loadCurrent(paths));
        cp = checkpoint.buildCheckpoint(run, tasks, new Date());
        checkpoint.writeCheckpoint(paths, run.run_id, cp);
      }, { waitMs: 2000, kind: 'hook', command: 'pre_compact' });
      written = true;
    } catch (e) {
      common.logErr('pre_compact', e);
    }
  }
  const open = Object.values(cp.task_statuses).filter((s) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(s)).length;
  const stateRel = path.relative(paths.projectDir, path.join(paths.runsDir, run.run_id)).split(path.sep).join('/');
  const lines = [
    `opus-orchestrator: an orchestration run is in progress. Run id: ${run.run_id} (${open} unfinished task(s)).`,
    `Keep the run id ${run.run_id} in the compaction summary.`,
    `State that the authoritative orchestration state is stored on disk in ${stateRel}/${written ? ' (a fresh checkpoint.yaml was just written there)' : ''}, not in this conversation.`,
    `State that after compaction the orchestrator must run ${common.oocmd(paths)} resume before continuing, and must not rely on remembered task states.`,
  ];
  return lines.join('\n');
}

common.runHook('pre_compact', main);
