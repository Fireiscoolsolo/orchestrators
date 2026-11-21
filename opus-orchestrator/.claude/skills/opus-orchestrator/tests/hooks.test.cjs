'use strict';
// Hook tests run the scripts as child processes with stdin fixtures and a temp project directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../scripts/lib/store.cjs');

const HOOKS = path.resolve(__dirname, '..', 'scripts', 'hooks');

function setup(opts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oo-hooks-'));
  const paths = store.resolvePaths({ projectDir: root });
  let run = null;
  if (!opts || opts.state !== false) {
    store.ensureState(paths);
    run = store.createRun(paths, {
      objective: 'Build the thing',
      options: { mode: 'balanced', max_workers: 3 },
      config: { context: { max_resume_lines: 60 } },
    });
  }
  return { root, paths, run, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function addTask(s, id, status, extra) {
  store.saveTask(s.paths, s.run.run_id, Object.assign({
    task_id: id, status, dependencies: [], spec_revision: 1, review_round: 0,
    routing: { role: 'implementation-worker', agent: 'opus-implementer', model: 'haiku' },
    history: [], evidence: { reviews: [] }, result: null, correction: null, failure: null, block: null,
  }, extra || {}));
}

function runHook(name, input, cwd, env) {
  const e = Object.assign({}, process.env, env || {});
  delete e.OPUS_ORCH_PROJECT_DIR;
  delete e.OPUS_ORCH_STATE_DIR;
  Object.assign(e, env || {});
  return spawnSync(process.execPath, [path.join(HOOKS, `${name}.cjs`)], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    cwd: cwd || os.tmpdir(),
    env: e,
    encoding: 'utf8',
    timeout: 20000,
  });
}

function snapshotTree(dir) {
  const out = {};
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      if (fs.statSync(f).isDirectory()) walk(f);
      else out[path.relative(dir, f)] = fs.readFileSync(f, 'utf8');
    }
  })(dir);
  return out;
}

// ------------------------------------------------------------------ pre_compact

test('pre_compact: writes a checkpoint and prints summary instructions naming run id and resume command', () => {
  const s = setup();
  try {
    addTask(s, 'T-001', 'RUNNING');
    addTask(s, 'T-002', 'COMPLETED');
    const r = runHook('pre_compact', { hook_event_name: 'PreCompact', trigger: 'auto', cwd: s.root, custom_instructions: '' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(s.run.run_id), r.stdout);
    assert.match(r.stdout, /oo\.cjs resume/);
    assert.match(r.stdout, /on disk/);
    assert.ok(r.stdout.length < 10000);
    assert.doesNotMatch(r.stdout, /was compacted|triggered/i);
    const file = path.join(s.paths.runsDir, s.run.run_id, 'checkpoint.yaml');
    assert.ok(fs.existsSync(file), 'checkpoint.yaml written');
    const cp = require('../scripts/lib/checkpoint.cjs').readCheckpoint(s.paths, s.run.run_id);
    assert.equal(cp.run_id, s.run.run_id);
    assert.equal(cp.task_statuses['T-001'], 'RUNNING');
  } finally {
    s.done();
  }
});

test('pre_compact: finds the project from a subdirectory cwd', () => {
  const s = setup();
  try {
    addTask(s, 'T-001', 'READY');
    const sub = path.join(s.root, 'src', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    const r = runHook('pre_compact', { hook_event_name: 'PreCompact', cwd: sub });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(s.run.run_id));
  } finally {
    s.done();
  }
});

test('pre_compact: honours OPUS_ORCH_PROJECT_DIR', () => {
  const s = setup();
  try {
    addTask(s, 'T-001', 'READY');
    const r = runHook('pre_compact', { hook_event_name: 'PreCompact' }, os.tmpdir(), { OPUS_ORCH_PROJECT_DIR: s.root });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(s.run.run_id));
  } finally {
    s.done();
  }
});

test('pre_compact: no run, finished run, invalid stdin and corrupt state print nothing and change nothing', () => {
  // no state at all
  const none = setup({ state: false });
  try {
    const before = snapshotTree(none.root);
    const r = runHook('pre_compact', { hook_event_name: 'PreCompact', cwd: none.root });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.deepEqual(snapshotTree(none.root), before);
  } finally {
    none.done();
  }

  // finished run
  const fin = setup();
  try {
    addTask(fin, 'T-001', 'COMPLETED');
    addTask(fin, 'T-002', 'CANCELLED');
    const before = snapshotTree(fin.root);
    const r = runHook('pre_compact', { cwd: fin.root });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.deepEqual(snapshotTree(fin.root), before);
  } finally {
    fin.done();
  }

  // invalid stdin
  const inv = setup();
  try {
    addTask(inv, 'T-001', 'RUNNING');
    const before = snapshotTree(inv.root);
    for (const bad of ['', 'not json {', '[1,2]', 'null']) {
      const r = runHook('pre_compact', bad, inv.root);
      assert.equal(r.status, 0, `stdin ${JSON.stringify(bad)}`);
      assert.equal(r.stdout, '');
    }
    assert.deepEqual(snapshotTree(inv.root), before);
  } finally {
    inv.done();
  }

  // corrupt state
  const cor = setup();
  try {
    addTask(cor, 'T-001', 'RUNNING');
    fs.writeFileSync(path.join(cor.paths.runsDir, cor.run.run_id, 'run.json'), '{ broken');
    fs.rmSync(path.join(cor.paths.runsDir, cor.run.run_id, 'run.json.bak'), { force: true });
    const before = snapshotTree(cor.root);
    const r = runHook('pre_compact', { cwd: cor.root });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.deepEqual(snapshotTree(cor.root), before);
  } finally {
    cor.done();
  }

  // corrupt task file
  const cor2 = setup();
  try {
    addTask(cor2, 'T-001', 'RUNNING');
    const tf = path.join(cor2.paths.runsDir, cor2.run.run_id, 'tasks', 'T-001.json');
    fs.writeFileSync(tf, '<<<');
    fs.rmSync(`${tf}.bak`, { force: true });
    const before = snapshotTree(cor2.root);
    const r = runHook('pre_compact', { cwd: cor2.root });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.deepEqual(snapshotTree(cor2.root), before);
  } finally {
    cor2.done();
  }
});

// ------------------------------------------------------------------ session_start

test('session_start: prints the resume summary for source compact and resume', () => {
  const s = setup();
  try {
    addTask(s, 'T-001', 'RUNNING');
    addTask(s, 'T-002', 'COMPLETED');
    for (const source of ['compact', 'resume']) {
      const r = runHook('session_start', { hook_event_name: 'SessionStart', source, cwd: s.root });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes(s.run.run_id), source);
      assert.match(r.stdout, /Build the thing/);
      assert.match(r.stdout, /T-001 RUNNING/);
      assert.match(r.stdout, /Completed tasks \(1\): T-002/);
      assert.match(r.stdout, /oo result T-001 --stdin/);
      assert.ok(r.stdout.split('\n').filter((l) => l !== '').length <= 60, 'honours max_resume_lines from the run config');
    }
  } finally {
    s.done();
  }
});

test('session_start: prints nothing for other sources, finished runs, no run, bad stdin and corrupt state', () => {
  const s = setup();
  try {
    addTask(s, 'T-001', 'RUNNING');
    for (const source of ['startup', 'clear', 'fork', 'other', undefined]) {
      const r = runHook('session_start', { hook_event_name: 'SessionStart', source, cwd: s.root });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '', `source ${source}`);
    }
    for (const bad of ['', 'garbage']) {
      const r = runHook('session_start', bad, s.root);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
    }
    fs.writeFileSync(path.join(s.paths.runsDir, s.run.run_id, 'run.json'), '{ broken');
    fs.rmSync(path.join(s.paths.runsDir, s.run.run_id, 'run.json.bak'), { force: true });
    const r = runHook('session_start', { source: 'compact', cwd: s.root });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    s.done();
  }

  const fin = setup();
  try {
    addTask(fin, 'T-001', 'COMPLETED');
    const r = runHook('session_start', { source: 'compact', cwd: fin.root });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    fin.done();
  }

  const none = setup({ state: false });
  try {
    const r = runHook('session_start', { source: 'resume', cwd: none.root });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    none.done();
  }
});

// ------------------------------------------------------------------ statusline_bridge

test('statusline_bridge: writes context.json when the percentage is a number and state exists', () => {
  const s = setup();
  try {
    const r = runHook('statusline_bridge', {
      cwd: s.root,
      workspace: { current_dir: s.root },
      model: { display_name: 'Opus' },
      context_window: { used_percentage: 37.5, context_window_size: 200000 },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    assert.equal(out.split('\n').length, 1);
    assert.match(out, /38%|37%/);
    assert.ok(out.length < 60);
    const ctx = JSON.parse(fs.readFileSync(s.paths.contextFile, 'utf8'));
    assert.equal(ctx.used_percentage, 37.5);
    assert.equal(ctx.context_window_size, 200000);
    assert.ok(!Number.isNaN(Date.parse(ctx.ts)));

    // the library reads it back as fresh
    const u = require('../scripts/lib/checkpoint.cjs').readUtilization(s.paths, { maxAgeSeconds: 60 });
    assert.equal(u.source, 'statusline');
    assert.equal(u.utilization, 0.375);
  } finally {
    s.done();
  }
});

test('statusline_bridge: prefers workspace.current_dir and falls back to cwd', () => {
  const s = setup();
  try {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'oo-hooks-other-'));
    try {
      let r = runHook('statusline_bridge', { cwd: other, workspace: { current_dir: s.root }, context_window: { used_percentage: 10, context_window_size: 1000 } });
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(fs.readFileSync(s.paths.contextFile, 'utf8')).used_percentage, 10);
      r = runHook('statusline_bridge', { cwd: s.root, context_window: { used_percentage: 20, context_window_size: 1000 } });
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(fs.readFileSync(s.paths.contextFile, 'utf8')).used_percentage, 20);
      assert.equal(fs.existsSync(path.join(other, '.claude')), false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  } finally {
    s.done();
  }
});

test('statusline_bridge: never creates the state directory and writes nothing without a numeric percentage', () => {
  const none = setup({ state: false });
  try {
    const before = snapshotTree(none.root);
    const r = runHook('statusline_bridge', { cwd: none.root, context_window: { used_percentage: 50, context_window_size: 1000 } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /50%/);
    assert.equal(fs.existsSync(path.join(none.root, '.claude')), false);
    assert.deepEqual(snapshotTree(none.root), before);
  } finally {
    none.done();
  }

  const s = setup();
  try {
    for (const used of [null, undefined, '55', {}]) {
      const input = { cwd: s.root, context_window: { used_percentage: used, context_window_size: 1000 } };
      const r = runHook('statusline_bridge', input);
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim().split('\n').length, 1);
      assert.equal(fs.existsSync(s.paths.contextFile), false, `used_percentage ${JSON.stringify(used)}`);
    }
  } finally {
    s.done();
  }
});

test('statusline_bridge: exits 0 with a short line on any input', () => {
  for (const bad of ['', 'not json', '[]', 'null', '{"context_window":5}', '{"model":{"display_name":42}}']) {
    const r = runHook('statusline_bridge', bad);
    assert.equal(r.status, 0, JSON.stringify(bad));
    assert.ok(r.stdout.trim().split('\n').length <= 1);
    assert.ok(r.stdout.length < 80);
  }
});

test('statusline_bridge: honours OPUS_ORCH_STATE_DIR', () => {
  const s = setup({ state: false });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oo-hooks-state-'));
  try {
    const r = runHook('statusline_bridge', { context_window: { used_percentage: 61, context_window_size: 1000 } },
      s.root, { OPUS_ORCH_PROJECT_DIR: s.root, OPUS_ORCH_STATE_DIR: stateDir });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'context.json'), 'utf8')).used_percentage, 61);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    s.done();
  }
});
