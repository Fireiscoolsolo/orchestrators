'use strict';
// Status line bridge. Records context utilization for the orchestrator (a model cannot read it
// directly) and prints one short status line. Writes only when the state directory already exists.
// Always exits 0.
const fs = require('node:fs');
const store = require('../lib/store.cjs');
const common = require('./_common.cjs');

function main(payload) {
  const p = payload || {};
  const cw = p.context_window && typeof p.context_window === 'object' ? p.context_window : {};
  const pct = cw.used_percentage;
  const hasPct = typeof pct === 'number' && Number.isFinite(pct);

  if (hasPct) {
    try {
      const ws = p.workspace && typeof p.workspace === 'object' ? p.workspace : {};
      const paths = common.locatePaths([ws.current_dir, p.cwd]);
      let exists = false;
      try {
        exists = fs.statSync(paths.stateRoot).isDirectory();
      } catch (_) { /* absent: never create it */ }
      if (exists) {
        const size = typeof cw.context_window_size === 'number' && Number.isFinite(cw.context_window_size)
          ? cw.context_window_size
          : null;
        store.writeJson(paths.contextFile, {
          used_percentage: pct,
          context_window_size: size,
          ts: new Date().toISOString(),
        });
      }
    } catch (e) {
      common.logErr('statusline_bridge', e);
    }
  }

  let model = '';
  if (p.model && typeof p.model.display_name === 'string') {
    model = p.model.display_name.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 30);
  }
  const ctx = hasPct ? `ctx ${Math.round(pct)}%` : 'ctx n/a';
  return model ? `${model} | ${ctx}` : ctx;
}

common.runHook('statusline_bridge', main);
