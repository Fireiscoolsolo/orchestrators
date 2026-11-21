'use strict';
// Shared helpers for the hook scripts. A hook must never break the user's session:
// every entry point wraps its work, logs to stderr and exits 0.
const fs = require('node:fs');
const path = require('node:path');
const store = require('../lib/store.cjs');

const SKILL_SCRIPTS = path.resolve(__dirname, '..');

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const chunks = [];
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    try {
      if (process.stdin.isTTY) return finish();
      const timer = setTimeout(finish, timeoutMs || 5000);
      if (timer.unref) timer.unref();
      process.stdin.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      process.stdin.on('close', finish);
    } catch (_) {
      finish();
    }
    return undefined;
  });
}

function parsePayload(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

// Project root: OPUS_ORCH_PROJECT_DIR, else the first candidate directory (or the nearest
// parent of it) that holds .claude/opus-orchestrator, else the first candidate, else cwd.
function locatePaths(candidates) {
  const envProject = process.env.OPUS_ORCH_PROJECT_DIR;
  if (envProject) return store.resolvePaths({});
  const dirs = (candidates || []).filter((c) => typeof c === 'string' && c.trim() !== '');
  for (const start of dirs) {
    let dir = path.resolve(start);
    for (;;) {
      if (isDir(path.join(dir, '.claude', 'opus-orchestrator'))) return store.resolvePaths({ projectDir: dir });
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return store.resolvePaths({ projectDir: dirs.length > 0 ? dirs[0] : process.cwd() });
}

// Loads the current run and its tasks. Throws when there is no run or state is unreadable.
function loadCurrent(paths) {
  const run = store.loadRun(paths);
  const tasks = store.listTasks(paths, run.run_id);
  return { run, tasks };
}

function oocmd(paths) {
  const abs = path.join(SKILL_SCRIPTS, 'oo.cjs');
  let rel = path.relative(paths.projectDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) rel = abs;
  rel = rel.split(path.sep).join('/');
  return `node ${/\s/.test(rel) ? `"${rel}"` : rel}`;
}

function logErr(name, e) {
  if (e && e.code === 'NO_RUN') return; // no run is the normal case outside orchestration
  try {
    process.stderr.write(`opus-orchestrator ${name}: ${e && e.message ? e.message : String(e)}\n`);
  } catch (_) { /* ignore */ }
}

// Runs main(payload) and always ends with exit code 0.
function runHook(name, main) {
  process.on('uncaughtException', (e) => {
    logErr(name, e);
    process.exit(0);
  });
  process.on('unhandledRejection', (e) => {
    logErr(name, e);
    process.exit(0);
  });
  readStdin().then((text) => {
    const payload = parsePayload(text);
    let out = '';
    try {
      out = main(payload) || '';
    } catch (e) {
      logErr(name, e);
      out = '';
    }
    const finish = () => process.exit(0);
    if (out) {
      try {
        process.stdout.write(out.endsWith('\n') ? out : `${out}\n`, finish);
      } catch (e) {
        logErr(name, e);
        finish();
      }
    } else {
      finish();
    }
  }).catch((e) => {
    logErr(name, e);
    process.exit(0);
  });
}

module.exports = { readStdin, parsePayload, locatePaths, loadCurrent, oocmd, logErr, runHook };
