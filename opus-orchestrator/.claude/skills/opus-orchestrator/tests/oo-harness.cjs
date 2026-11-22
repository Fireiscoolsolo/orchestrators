'use strict';
// Test harness for the oo CLI. Not a test file itself (no .test.cjs suffix).
//
// Every project is a fresh directory under os.tmpdir(). oo runs as a child process with
// OPUS_ORCH_PROJECT_DIR pointing at it and OPUS_ORCH_HOME at an empty home directory, so the
// real project state and the user's agents are never touched.
//
// SIMULATED AGENTS: no model is ever called. A "worker" here is test code that edits files in
// the temp project and then feeds a YAML report to `oo result`, exactly as the orchestrator
// would paste a worker's final message. Tests that do this are named "simulated-agent: ...".
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const yaml = require('../scripts/lib/yaml.cjs');
const store = require('../scripts/lib/store.cjs');

const SKILL = path.resolve(__dirname, '..');
const OO = path.join(SKILL, 'scripts', 'oo.cjs');
const roots = [];
const CURRENT_ATTEMPT = '__CURRENT_ATTEMPT__';
const CURRENT_REVIEW = '__CURRENT_REVIEW__';

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (_) {
    // a directory still held open by a killed process is not a test failure
  }
}

function cleanup() {
  while (roots.length) removeDir(roots.pop());
}

function g(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`fixture git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function baseEnv(extra) {
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) if (k.startsWith('OPUS_ORCH_')) delete env[k];
  delete env.NODE_TEST_CONTEXT;
  return Object.assign(env, extra || {});
}

/**
 * project({git, config, skill}) -> project handle
 * git: create a repository with one commit (README.md) on branch main.
 * config: text of STATE/config.yaml (project overrides) written before init.
 * skill: path of a skill copy whose oo.cjs is used (for proposal tests that edit config).
 */
function project(opts = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'oo-cli-')));
  roots.push(root);
  const dir = path.join(root, 'project');
  const home = path.join(root, 'home');
  fs.mkdirSync(dir);
  fs.mkdirSync(home);
  if (opts.git) {
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, 'config', 'user.name', 'Test User');
    g(dir, 'config', 'user.email', 'test@example.invalid');
    g(dir, 'config', 'commit.gpgsign', 'false');
    g(dir, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', 'init');
  }
  if (opts.config) {
    fs.mkdirSync(path.join(dir, '.claude', 'opus-orchestrator'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'opus-orchestrator', 'config.yaml'), opts.config);
  }
  const ooFile = opts.skill ? path.join(opts.skill, 'scripts', 'oo.cjs') : OO;
  const env = baseEnv(Object.assign({ OPUS_ORCH_PROJECT_DIR: dir, OPUS_ORCH_HOME: home }, opts.env || {}));
  const paths = store.resolvePaths({ projectDir: dir });

  const p = {
    root, dir, home, env, paths,
    run(args, o = {}) {
      let input = o.input === undefined ? '' : o.input;
      let argv = args;
      // A simulated worker copies the attempt id of its package, and a simulated reviewer the
      // review id of its package, exactly as a real agent copies them from the report template.
      // The harness reads them from oo's state; tests of stale or foreign ids pass them explicitly.
      if (typeof input === 'string' && input.includes(CURRENT_ATTEMPT)) {
        let cur = 'none';
        try { cur = (p.task(args[1]).dispatch || {}).attempt_id || 'none'; } catch (_) { /* no such task: oo refuses */ }
        input = input.split(CURRENT_ATTEMPT).join(cur);
      }
      if (typeof input === 'string' && input.includes(CURRENT_REVIEW)) {
        let rid = 'none';
        let n = 0;
        try {
          const ds = (p.task(args[1]).review_dispatches || []).filter((d) => d.status === 'issued');
          if (ds.length) { rid = ds[ds.length - 1].review_id; n = ds[ds.length - 1].n; }
        } catch (_) { /* no such task */ }
        input = input.split(CURRENT_REVIEW).join(rid);
        // Simulated host identity of the reviewer agent (one per review package).
        if (!argv.includes('--agent-id')) argv = argv.concat(['--agent-id', `sim-reviewer-${n}`]);
      }
      const r = spawnSync(process.execPath, [ooFile, ...argv], {
        cwd: o.cwd || dir, env, input, encoding: 'utf8', timeout: 120000, windowsHide: true,
      });
      return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
    },
    expect(code, args, o) {
      const r = p.run(args, o);
      assert.equal(r.code, code, `oo ${args.join(' ')} exited ${r.code}, expected ${code}\n${r.out}`);
      return r.out;
    },
    ok(args, o) { return p.expect(0, args, o); },
    refused(args, o) { return p.expect(1, args, o); },
    usage(args, o) { return p.expect(2, args, o); },
    write(rel, text) {
      const f = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
      return f;
    },
    read(rel) { return fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8'); },
    exists(rel) { return fs.existsSync(path.join(dir, ...rel.split('/'))); },
    runId() { return fs.readFileSync(paths.currentFile, 'utf8').trim(); },
    runDir() { return path.join(paths.runsDir, p.runId()); },
    runRecord() { return store.loadRun(paths); },
    task(id) { return store.loadTask(paths, p.runId(), id); },
    status(id) { return p.task(id).status; },
    checkpointText() { return fs.readFileSync(path.join(p.runDir(), 'checkpoint.yaml'), 'utf8'); },
    checkpoint() { return yaml.parse(p.checkpointText()); },
    /** Writes specs to the inbox and runs oo plan; returns the output. */
    plan(specs, code = 0) {
      const f = p.write('.opus-inbox/specs.yaml', yaml.stringify(specs));
      return p.expect(code, ['plan', '--file', f]);
    },
    git(...args) { return g(dir, ...args); },
  };
  return p;
}

/** A task specification (DESIGN 3.1) with small defaults. */
function spec(id, o = {}) {
  return Object.assign({
    task_id: id,
    title: `Task ${id}`,
    objective: `Create the file for ${id}.`,
    complexity: 2,
    authorized_files: [`${id.toLowerCase()}.txt`],
    acceptance_criteria: [`${id.toLowerCase()}.txt exists`],
    verification_commands: [existsCmd(`${id.toLowerCase()}.txt`)],
  }, o);
}

/** A shell command (bash or cmd) that exits 0 when the file exists. */
function existsCmd(rel) {
  return `node -e "process.exit(require('fs').existsSync('${rel}')?0:1)"`;
}

/** A command that prints two lines and exits 3. */
const FAIL_CMD = 'node -e "console.log(\'line one of the failure\'); console.error(\'boom: expected 2 got 3\'); process.exit(3)"';

function fence(obj, prose = 'Simulated worker message (test code, no model).') {
  return `${prose}\n\n\`\`\`yaml\n${yaml.stringify(obj)}\`\`\`\n`;
}

/** Simulated worker report (DESIGN 3.4). */
function report(id, o = {}) {
  const n = o.criteria === undefined ? 1 : o.criteria;
  const r = {
    task_id: id,
    attempt_id: o.attempt === undefined ? CURRENT_ATTEMPT : o.attempt,
    status: o.status || 'completed',
    summary: o.summary || `simulated worker finished ${id}`,
    files_changed: o.files || [],
    self_check: Array.from({ length: n }, (_, i) => ({ met: true, evidence: `simulated check ${i + 1}` })),
    commands_run: [],
    commit: o.commit || null,
    branch: o.branch || null,
    issues: o.issues || [],
    proposed_subtasks: o.proposed_subtasks || [],
  };
  if (r.status !== 'completed' && o.criteria === undefined) r.self_check = [];
  return fence(r);
}

/** Review report (DESIGN 3.5). */
function review(id, o = {}) {
  const n = o.criteria === undefined ? 1 : o.criteria;
  const verdict = o.verdict || 'approve';
  const r = {
    task_id: id,
    review_id: o.reviewId === undefined ? ((o.reviewer || 'orchestrator') === 'orchestrator' ? null : CURRENT_REVIEW) : o.reviewId,
    reviewer: o.reviewer || 'orchestrator',
    verdict,
    criteria: Array.from({ length: n }, (_, i) => ({ met: verdict === 'approve', evidence: `simulated review of criterion ${i + 1}` })),
    findings: verdict === 'approve' ? [] : [{ severity: 'major', file: o.file || 'x.txt', description: 'simulated finding' }],
  };
  return fence(r, 'Simulated reviewer message (test code, no model).');
}

/** Correction request (DESIGN 3.6). */
function correction(id, o = {}) {
  const c = {
    task_id: id,
    failure: 'the verification command exited 3',
    evidence: 'boom: expected 2 got 3',
    expected_behavior: 'the command exits 0',
    required_change: 'make the check pass',
    verification: ['node --version'],
  };
  if (o.strategy_change) c.strategy_change = o.strategy_change;
  if (o.verification_commands) c.verification_commands = o.verification_commands;
  return yaml.stringify(c);
}

/**
 * Copies the skill (scripts, config, agents, templates, VERSION) to a temp directory so that a
 * test may let oo edit config files (proposals apply) without touching the real skill.
 */
function skillCopy() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'oo-skill-')));
  roots.push(root);
  const dest = path.join(root, 'opus-orchestrator');
  for (const part of ['scripts', 'config', 'agents', 'templates', 'VERSION']) {
    const src = path.join(SKILL, part);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, part), { recursive: true });
  }
  return dest;
}

module.exports = { SKILL, OO, project, spec, existsCmd, FAIL_CMD, report, review, correction, fence, skillCopy, cleanup, g };
