'use strict';
// SessionStart hook. After compaction or resume, prints the resume summary of the current
// unfinished run to stdout (which Claude Code adds to the context). Always exits 0.
const checkpoint = require('../lib/checkpoint.cjs');
const common = require('./_common.cjs');

function main(payload) {
  if (!payload) return '';
  if (payload.source !== 'compact' && payload.source !== 'resume') return '';
  const paths = common.locatePaths([payload.cwd]);
  const { run, tasks } = common.loadCurrent(paths);
  if (!checkpoint.isUnfinished(tasks)) return '';
  const cfgCtx = (run.config && run.config.context) || {};
  const maxLines = Number.isInteger(cfgCtx.max_resume_lines) && cfgCtx.max_resume_lines > 0 ? cfgCtx.max_resume_lines : 120;
  const cp = checkpoint.buildCheckpoint(run, tasks, new Date());
  return checkpoint.renderResume(cp, { maxLines });
}

common.runHook('session_start', main);
