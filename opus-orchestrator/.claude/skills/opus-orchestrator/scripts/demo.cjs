#!/usr/bin/env node
'use strict';
// Simulated end-to-end demonstration of the opus-orchestrator (DESIGN 5; the eleven steps of
// the specification's scenario 18.2).
//
//   node scripts/demo.cjs [--keep] [--git]
//
// SIMULATED AGENTS: every worker and reviewer here is scripted code. No model is called and no
// real agent is launched. What is real is the oo command line, the state it persists, the
// verification commands it runs, and (with --git) the git branches, worktrees and merges.
//
// The fixture project (demo/project) is copied to a temporary directory and oo is driven with
// that copy as the project (OPUS_ORCH_PROJECT_DIR) and an empty home directory, so neither the
// real project state nor the user's agents are touched. Without --git the copy is not a
// repository and the shared workspace strategy is used; with --git the copy becomes a
// repository and the worktree strategy is used.
//
// Exit code: 0 only when all four tasks are COMPLETED and the final report says COMPLETE;
// 1 when the scenario failed (the temporary directory is then kept); 2 on a usage error.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('./lib/yaml.cjs');
const store = require('./lib/store.cjs');

const SKILL = path.resolve(__dirname, '..');
const OO = path.join(SKILL, 'scripts', 'oo.cjs');
const DEMO = path.join(SKILL, 'demo');
const TOTAL_STEPS = 11;
const TASKS = ['SLUG-001', 'WORD-001', 'SUM-001', 'DOC-001'];
const USAGE = 'usage: node scripts/demo.cjs [--keep] [--git]\n'
  + '  --keep  keep the temporary directory (printed at the end) instead of deleting it\n'
  + '  --git   make the copy a git repository: the worktree strategy with real branches and merges\n';

class DemoError extends Error {}

function fail(message) {
  throw new DemoError(message);
}

function check(cond, message) {
  if (!cond) fail(message);
}

function out(line) {
  process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------------------
// Arguments and temporary directory
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { keep: false, git: false };
  for (const a of argv) {
    if (a === '--keep') o.keep = true;
    else if (a === '--git') o.git = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else return { error: `unknown argument ${JSON.stringify(a)}` };
  }
  return o;
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (_) {
    // a directory still held open by another process is not a demo failure
  }
}

function cleanEnv(extra) {
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) if (k.startsWith('OPUS_ORCH_')) delete env[k];
  delete env.NODE_TEST_CONTEXT; // the nested node --test of the fixture must run as a normal run
  return Object.assign(env, extra);
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) fail(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout || '').trim()}`);
  return (r.stdout || '').trim();
}

function shell(command, cwd) {
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', windowsHide: true, env: cleanEnv({}) });
  return { code: r.status, output: ((r.stdout || '') + (r.stderr || '')).trim() };
}

function setupDirectories(useGit) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'oo-demo-')));
  const dir = path.join(root, 'project');
  const home = path.join(root, 'home');
  const worktrees = path.join(root, 'worktrees');
  fs.mkdirSync(home);
  fs.mkdirSync(worktrees);
  fs.cpSync(path.join(DEMO, 'project'), dir, { recursive: true });
  if (useGit) {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.name', 'Demo User']);
    git(dir, ['config', 'user.email', 'demo@example.invalid']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    git(dir, ['config', 'core.autocrlf', 'false']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'fixture project']);
  }
  return { root, dir, home, worktrees };
}

// ---------------------------------------------------------------------------
// The driver: runs oo, records every command, prints one entry per step
// ---------------------------------------------------------------------------

function makeDriver(dirs, useGit) {
  const env = cleanEnv({ OPUS_ORCH_PROJECT_DIR: dirs.dir, OPUS_ORCH_HOME: dirs.home });
  const paths = store.resolvePaths({ projectDir: dirs.dir });
  const d = {
    dirs, useGit, paths, step: 0, lines: [], commands: [], pendingTitle: null,
    runId() { return fs.readFileSync(paths.currentFile, 'utf8').trim(); },
    runDir() { return path.join(paths.runsDir, d.runId()); },
    task(id) { return store.loadTask(paths, d.runId(), id); },
    run() { return store.loadRun(paths); },
    begin(title) {
      d.step += 1;
      d.title = title;
      d.lines = [];
    },
    /** Runs oo; the exit code must be the expected one. Returns the output text. */
    oo(args, o = {}) {
      const r = spawnSync(process.execPath, [OO, ...args], {
        cwd: dirs.dir, env, input: o.input === undefined ? '' : o.input, encoding: 'utf8', timeout: 300000, windowsHide: true,
      });
      const text = (r.stdout || '') + (r.stderr || '');
      const expected = o.expect === undefined ? 0 : o.expect;
      const shown = o.label || args.join(' ');
      d.lines.push({ text: `oo ${shown}`, code: r.status, expected });
      d.commands.push({ step: d.step, args, code: r.status, expected });
      if (r.status !== expected) {
        d.end();
        fail(`oo ${shown} exited ${r.status}, expected ${expected}\n${text}`);
      }
      return text;
    },
    /** Prints the step: one entry with the first command, continuation lines for the rest. */
    end() {
      if (!d.lines.length) return;
      const tag = `[${String(d.step).padStart(2)}/${TOTAL_STEPS}]`;
      d.lines.forEach((l, i) => {
        const note = l.code === l.expected ? '' : ' (UNEXPECTED)';
        const expectedNote = l.expected !== 0 && l.code === l.expected ? ' (expected: the verification must fail here)' : '';
        const head = i === 0 ? `${tag} ${d.title}: ` : `${' '.repeat(tag.length)}   `;
        out(`${head}${l.text} -> exit ${l.code}${note}${expectedNote}`);
      });
      d.lines = [];
    },
  };
  return d;
}

// ---------------------------------------------------------------------------
// Scripted workers and reviewers (SIMULATED: no model)
// ---------------------------------------------------------------------------

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function fence(obj, prose) {
  return `${prose}\n\n\`\`\`yaml\n${yaml.stringify(obj)}\`\`\`\n`;
}

/**
 * Where a scripted worker does its work for the task's current dispatch. Shared strategy: the
 * project copy. Worktree strategy: its own git worktree and branch (as the Agent tool's
 * isolation: worktree would give it), made from the main checkout's HEAD and merged with the
 * integration head named in the worker package, as the package instructs.
 */
function workspaceFor(d, id) {
  if (!d.useGit) return { dir: d.dirs.dir, branch: null };
  const t = d.task(id);
  const dir = path.join(d.dirs.worktrees, id);
  const branch = `demo/${id.toLowerCase()}`;
  if (!fs.existsSync(dir)) git(d.dirs.dir, ['worktree', 'add', '-q', '-b', branch, dir, 'HEAD']);
  check(t.dispatch && t.dispatch.integration_head, `${id}: the dispatch records no integration head`);
  git(dir, ['merge', '--no-edit', t.dispatch.integration_head]);
  return { dir, branch };
}

/**
 * A scripted worker: reads its package, writes the given files, runs the commands it was told
 * to run before reporting, commits in the worktree strategy, and returns the report text
 * (the same YAML block a real worker's final message ends with).
 */
function simulatedWorker(d, id, o) {
  const t = d.task(id);
  const pkg = read(path.join(d.dirs.dir, ...t.dispatch.package.split('/')));
  check(pkg.startsWith(`TASK ${id}:`), `${id}: the worker package does not start with the task header`);
  if (o.expectCorrection) check(/## Correction request/.test(pkg), `${id}: the second package carries no correction request`);
  else check(!/## Correction request/.test(pkg), `${id}: the first package already carries a correction request`);

  const ws = workspaceFor(d, id);
  for (const [rel, content] of Object.entries(o.files)) {
    const f = path.join(ws.dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  const ran = (o.commands || []).map((c) => ({ command: c, exit_code: shell(c, ws.dir).code }));
  const failed = ran.filter((c) => c.exit_code !== 0);
  const evidence = ran.length
    ? `SIMULATED worker ran ${ran.map((c) => `\`${c.command}\` (exit ${c.exit_code})`).join(' and ')}`
    : 'SIMULATED worker checked the file itself';
  let commit = null;
  if (d.useGit) {
    git(ws.dir, ['add', '-A']);
    git(ws.dir, ['commit', '-q', '-m', `${id}: simulated worker change`]);
    commit = git(ws.dir, ['rev-parse', 'HEAD']);
  }
  const report = {
    task_id: id,
    status: 'completed',
    summary: o.summary,
    files_changed: Object.keys(o.files),
    self_check: t.acceptance_criteria.map((c, i) => ({
      met: o.met ? o.met(i, failed.length === 0) : failed.length === 0,
      evidence: `${evidence}; criterion ${i + 1}`,
    })),
    commands_run: ran,
    commit,
    branch: ws.branch,
    issues: [],
    proposed_subtasks: [],
  };
  const args = ['result', id, '--stdin'];
  if (o.verify) args.push('--verify');
  if (d.useGit) args.push('--worktree', ws.dir, '--branch', ws.branch);
  return { args, input: fence(report, `SIMULATED worker message for ${id} (scripted code, no model).`), dir: ws.dir };
}

function fixtureFile(name) {
  return read(path.join(DEMO, 'scripted', name));
}

/** What each scripted worker writes. The first slugify worker only knows the specification. */
function workPlan(d, id, phase) {
  if (id === 'SLUG-001' && phase === 'first') {
    return {
      files: { 'src/slugify.js': fixtureFile('slugify.first.js') },
      summary: 'SIMULATED worker implemented slugify from the specification: lower case, accents removed, single dashes, no dash at either end',
      commands: ['node --test test/slugify.test.js'],
    };
  }
  if (id === 'SLUG-001') {
    return {
      files: { 'src/slugify.js': fixtureFile('slugify.corrected.js') },
      summary: 'SIMULATED worker changed slugify as the correction request asked, then re-ran the named checks',
      commands: ['node --test acceptance/slugify.acceptance.test.js', 'node --test test/slugify.test.js'],
    };
  }
  if (id === 'WORD-001') {
    return {
      files: { 'src/wordcount.js': fixtureFile('wordcount.js') },
      summary: 'SIMULATED worker implemented wordcount by splitting on whitespace',
      commands: ['node --test test/wordcount.test.js'],
    };
  }
  if (id === 'SUM-001') {
    return {
      files: { 'src/summary.js': fixtureFile('summary.js') },
      summary: 'SIMULATED worker added summarize using slugify and wordcount',
      commands: ['node --test test/summary.test.js'],
    };
  }
  // DOC-001: replace the API section of the README in the worker's own workspace
  const readmeBase = d.useGit ? git(d.dirs.dir, ['show', 'HEAD:README.md']) : read(path.join(d.dirs.dir, 'README.md'));
  const at = readmeBase.indexOf('## API');
  check(at >= 0, 'README.md has no API section to replace');
  return {
    files: { 'README.md': `${readmeBase.slice(0, at)}${fixtureFile('README.api.md')}` },
    summary: 'SIMULATED worker documented slugify, wordcount and summarize in the README',
    commands: [],
  };
}

/**
 * A scripted reviewer. It re-runs the task's own verification commands in the workspace the
 * verification used and approves only when every one exits 0, so the verdict is computed, not
 * fixed. The report has one criteria entry per acceptance criterion, as DESIGN 3.5 requires.
 */
function simulatedReview(d, id, reviewer) {
  const t = d.task(id);
  const v = t.evidence.verification;
  const cwd = path.resolve(d.dirs.dir, String(v.workspace));
  const results = (t.verification_commands || []).map((c) => ({ command: c, code: shell(c, cwd).code }));
  const ok = results.every((r) => r.code === 0);
  const what = results.length ? results.map((r) => `\`${r.command}\` exit ${r.code}`).join('; ') : 'no commands';
  const rep = {
    task_id: id,
    reviewer,
    verdict: ok ? 'approve' : 'request_changes',
    criteria: t.acceptance_criteria.map((c, i) => ({ met: ok, evidence: `SIMULATED reviewer (scripted code) re-ran ${what}; criterion ${i + 1}` })),
    findings: ok ? [] : [{ severity: 'major', file: (t.authorized_files || ['?'])[0], description: 'a verification command failed in the review re-run' }],
  };
  return fence(rep, `SIMULATED ${reviewer === 'orchestrator' ? 'orchestrator quality gate' : 'independent reviewer'} message for ${id} (scripted code, no model).`);
}

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

/** Runs oo review (and review-package first when the task needs an independent review). */
function reviewTask(d, id, integrate) {
  const t = d.task(id);
  check(t.status === 'REVIEWING', `${id} should be REVIEWING before the review (is ${t.status})`);
  if (t.routing.independent_review) {
    const pkg = d.oo(['review-package', id]);
    check(/REVIEW PACKAGE/.test(pkg), `oo review-package ${id} printed no review package`);
    const r = d.oo(['review', id, '--stdin'], { input: simulatedReview(d, id, 'opus-reviewer'), label: `review ${id} --stdin (independent reviewer, simulated)` });
    check(/INDEPENDENT REVIEW RECORDED/.test(r), `the independent review of ${id} was not recorded:\n${r}`);
  }
  const args = ['review', id, '--stdin'];
  if (integrate) args.push('--integrate');
  const r = d.oo(args, { input: simulatedReview(d, id, 'orchestrator'), label: `${args.join(' ')} (orchestrator gate, simulated)` });
  check(/APPROVED: /.test(r), `${id} was not approved:\n${r}`);
  if (integrate) check(/INTEGRATED: /.test(r), `${id} was not integrated:\n${r}`);
}

/** Dispatches the ready tasks with oo next and checks which ones were dispatched. */
function dispatch(d, expectIds, expectAbsent) {
  const text = d.oo(['next']);
  for (const id of expectIds) check(new RegExp(`=== ${id} `).test(text), `oo next did not dispatch ${id}:\n${text}`);
  for (const id of expectAbsent || []) check(!new RegExp(`=== ${id} `).test(text), `oo next dispatched ${id} too early:\n${text}`);
  return text;
}

function scenario(d) {
  const request = read(path.join(DEMO, 'request.md'));

  // 1. init
  d.begin('init');
  const initText = d.oo(['init', '--stdin'], { input: request, label: 'init --stdin (demo/request.md)' });
  const strategy = (/Workspace strategy: (\w+)/.exec(initText) || [])[1];
  check(strategy === (d.useGit ? 'worktree' : 'shared'), `expected the ${d.useGit ? 'worktree' : 'shared'} strategy, oo chose ${strategy}\n${initText}`);
  d.end();

  // 2. plan
  d.begin('plan');
  fs.mkdirSync(d.paths.inboxDir, { recursive: true });
  const specsFile = path.join(d.paths.inboxDir, 'specs.yaml');
  fs.copyFileSync(path.join(DEMO, 'specs.yaml'), specsFile);
  const planText = d.oo(['plan', '--file', specsFile], { label: 'plan --file .opus-inbox/specs.yaml (demo/specs.yaml)' });
  check(/PLAN SAVED: 4 task\(s\)/.test(planText), `oo plan did not save four tasks:\n${planText}`);
  check(/wave 1: (SLUG-001, WORD-001|WORD-001, SLUG-001)/.test(planText), `the plan does not start with the two independent tasks:\n${planText}`);
  d.end();

  // 3. concurrent dispatch of the two independent tasks, then their first results
  d.begin('concurrent dispatch of SLUG-001 and WORD-001');
  const nextText = dispatch(d, ['SLUG-001', 'WORD-001'], ['SUM-001', 'DOC-001']);
  check(/issue the 2 Agent call\(s\) below in ONE message/.test(nextText), `oo next did not dispatch both tasks as one parallel batch:\n${nextText}`);
  d.oo(['started', 'SLUG-001', 'WORD-001']);
  check(d.task('SLUG-001').status === 'RUNNING' && d.task('WORD-001').status === 'RUNNING', 'both tasks should be RUNNING');
  // both scripted workers are running at the same time: both workspaces exist before either reports
  const slug1 = simulatedWorker(d, 'SLUG-001', Object.assign({}, workPlan(d, 'SLUG-001', 'first')));
  const word1 = simulatedWorker(d, 'WORD-001', Object.assign({}, workPlan(d, 'WORD-001', 'first')));
  check(!d.useGit || slug1.dir !== word1.dir, 'the two workers share a workspace');
  d.oo(slug1.args, { input: slug1.input, label: 'result SLUG-001 --stdin (simulated worker report)' });
  d.oo(word1.args, { input: word1.input, label: 'result WORD-001 --stdin (simulated worker report)' });
  d.end();

  // 4. verification (oo runs the commands itself; the first slugify must fail the acceptance test)
  d.begin('verification');
  const w = d.oo(['verify', 'WORD-001']);
  check(/VERIFICATION PASSED: WORD-001/.test(w), `WORD-001 verification did not pass:\n${w}`);
  const s = d.oo(['verify', 'SLUG-001'], { expect: 1 });
  check(/VERIFICATION FAILED: SLUG-001 -> CORRECTION_REQUIRED/.test(s), `SLUG-001 verification did not fail as the scenario requires:\n${s}`);
  d.end();

  // 5. detection of the failing acceptance test, from the persisted evidence
  d.begin('detection of the failing acceptance test');
  const st = d.oo(['status']);
  check(/SLUG-001/.test(st), 'oo status does not list SLUG-001');
  const slug = d.task('SLUG-001');
  check(slug.status === 'CORRECTION_REQUIRED', `SLUG-001 should be CORRECTION_REQUIRED (is ${slug.status})`);
  const ev = slug.evidence.verification;
  check(ev && ev.passed === false, 'SLUG-001 evidence does not record a failed verification');
  const failing = ev.commands.filter((c) => c.exit_code !== 0);
  check(failing.length === 1 && /acceptance\/slugify\.acceptance\.test\.js/.test(failing[0].command), `the failing command should be the acceptance test, got ${JSON.stringify(failing.map((c) => c.command))}`);
  const passingUnit = ev.commands.find((c) => /test\/slugify\.test\.js/.test(c.command));
  check(passingUnit && passingUnit.exit_code === 0, 'the unit tests of slugify should have passed');
  const failedChecks = [...failing[0].output_tail.matchAll(/^\s*[✖x] (.+?)(?: \([\d.]+ms\))?$/gm)].map((m) => m[1]).filter((n) => !/^(failing tests|slugify)/i.test(n));
  check(failedChecks.length >= 1, `the output tail names no failing check:\n${failing[0].output_tail}`);
  d.end();
  out(`        detected: ${failing[0].command} exited ${failing[0].exit_code}; unit tests passed; failing checks: ${[...new Set(failedChecks)].join(' | ')}`);

  // 6. targeted correction request, built from the observed failure, then the corrected worker
  d.begin('targeted correction request');
  const assertionLine = (failing[0].output_tail.split('\n').find((l) => /expected|actual|\+ |\- /i.test(l) && !/^\s*at /.test(l)) || '').trim();
  const correction = {
    task_id: 'SLUG-001',
    failure: `${failing[0].command} exited ${failing[0].exit_code}; failing checks: ${[...new Set(failedChecks)].join('; ')}`,
    evidence: `${assertionLine || 'see the output tail'} (verification evidence ${ev.evidence_file})`,
    expected_behavior: 'the acceptance checks pass: a slug longer than 40 characters is cut to 40 characters and the cut leaves no trailing dash; a slug that already fits is unchanged',
    required_change: 'cut the finished slug to at most 40 characters and remove a dash that the cut leaves at the end; change nothing else',
    scope: ['src/slugify.js'],
    verification: ['node --test acceptance/slugify.acceptance.test.js', 'node --test test/slugify.test.js'],
  };
  const c = d.oo(['correct', 'SLUG-001', '--stdin'], { input: yaml.stringify(correction), label: 'correct SLUG-001 --stdin' });
  check(/CORRECTION RECORDED: SLUG-001 round 1/.test(c), `the correction was not recorded:\n${c}`);
  dispatch(d, ['SLUG-001'], ['WORD-001', 'SUM-001', 'DOC-001']);
  d.oo(['started', 'SLUG-001']);
  const slug2 = simulatedWorker(d, 'SLUG-001', Object.assign({ expectCorrection: true }, workPlan(d, 'SLUG-001', 'corrected')));
  d.oo(slug2.args, { input: slug2.input, label: 'result SLUG-001 --stdin (simulated worker report)' });
  d.end();

  // 7. re-verification
  d.begin('re-verification');
  const rv = d.oo(['verify', 'SLUG-001']);
  check(/VERIFICATION PASSED: SLUG-001/.test(rv), `SLUG-001 re-verification did not pass:\n${rv}`);
  d.end();

  // 8. review (independent where routing requires it, then the orchestrator's own gate)
  d.begin('review');
  reviewTask(d, 'WORD-001', false);
  reviewTask(d, 'SLUG-001', false);
  d.end();

  // 9. integration of all four tasks (the two dependent tasks are dispatched as they become ready)
  d.begin('integration of all four tasks');
  d.oo(['integrate', 'WORD-001']);
  d.oo(['integrate', 'SLUG-001']);
  dispatch(d, ['SUM-001'], ['DOC-001']);
  d.oo(['started', 'SUM-001']);
  const sum = simulatedWorker(d, 'SUM-001', Object.assign({ verify: true }, workPlan(d, 'SUM-001', 'first')));
  d.oo(sum.args, { input: sum.input, label: 'result SUM-001 --stdin --verify (simulated worker report)' });
  reviewTask(d, 'SUM-001', true);
  dispatch(d, ['DOC-001']);
  d.oo(['started', 'DOC-001']);
  const doc = simulatedWorker(d, 'DOC-001', Object.assign({ verify: true }, workPlan(d, 'DOC-001', 'first')));
  d.oo(doc.args, { input: doc.input, label: 'result DOC-001 --stdin --verify (simulated worker report)' });
  reviewTask(d, 'DOC-001', true);
  const idle = d.oo(['next']);
  check(/NOTHING DISPATCHED: all_done/.test(idle), `oo next should report all_done:\n${idle}`);
  d.end();

  // 10. deliver
  d.begin('deliver');
  const dl = d.oo(['deliver']);
  check(/DELIVERED/.test(dl), `oo deliver did not deliver:\n${dl}`);
  d.end();

  // 11. final-report
  d.begin('final-report');
  const fr = d.oo(['final-report']);
  d.end();
  return fr;
}

// ---------------------------------------------------------------------------
// Outcome from the persisted state
// ---------------------------------------------------------------------------

function outcome(d, finalText) {
  const problems = [];
  const rows = [];
  for (const id of TASKS) {
    const t = d.task(id);
    rows.push(`${id.padEnd(9)} ${String(t.status).padEnd(10)} correction rounds: ${t.review_round || 0}  dispatches: ${t.attempts}  verification runs: ${t.verification_runs || 0}`);
    if (t.status !== 'COMPLETED') problems.push(`${id} is ${t.status}, not COMPLETED`);
    const expectRounds = id === 'SLUG-001' ? 1 : 0;
    if ((t.review_round || 0) !== expectRounds) problems.push(`${id} has ${t.review_round || 0} correction round(s), expected ${expectRounds}`);
  }
  const reportFile = path.join(d.runDir(), 'final-report.md');
  const report = fs.existsSync(reportFile) ? read(reportFile) : '';
  if (!/Overall status: COMPLETE\b/.test(report)) problems.push('the final report does not say Overall status: COMPLETE');
  if (!/Overall status: COMPLETE\b/.test(finalText)) problems.push('oo final-report did not print Overall status: COMPLETE');
  if (!d.run().delivered) problems.push('the run is not marked delivered');
  // the finished fixture passes all of its own tests, outside oo
  const all = shell('node --test test/*.test.js acceptance/*.test.js', d.dirs.dir);
  if (all.code !== 0) problems.push(`the finished project's own tests fail (exit ${all.code})`);
  return { problems, rows, reportFile, projectTests: all.code };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.error) {
    process.stderr.write(`${o.error}\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  out('=== opus-orchestrator demonstration: SIMULATED agents ===');
  out('The workers and reviewers in this run are SIMULATED by scripted code (scripts/demo.cjs and demo/scripted/). No model is called and no real agent is launched.');
  out('Real in this run: the oo command line, the state it persists, the verification commands it executes, and the final report it writes.');
  out(o.git
    ? 'Workspace: a copy of demo/project made into a git repository: the worktree strategy with real branches, worktrees and merges.'
    : 'Workspace: a copy of demo/project that is not a repository: the shared strategy.');
  out('');

  const dirs = setupDirectories(o.git);
  out(`Demo directory: ${dirs.root}`);
  out(`Project copy:   ${dirs.dir}`);
  out('');
  const d = makeDriver(dirs, o.git);
  let code = 1;
  let ok = false;
  try {
    const finalText = scenario(d);
    const res = outcome(d, finalText);
    out('');
    out('Persisted task states (read from the run state, simulated workers):');
    for (const r of res.rows) out(`  ${r}`);
    out(`Finished project's own tests (node --test test/*.test.js acceptance/*.test.js): exit ${res.projectTests}`);
    out(`Final report: ${res.reportFile}`);
    if (res.problems.length) {
      out('');
      for (const p of res.problems) out(`PROBLEM: ${p}`);
      out('RESULT: FAILED (simulated-agent demonstration)');
    } else {
      out('RESULT: PASSED (simulated-agent demonstration: four tasks COMPLETED, final report COMPLETE; no real agent or model was involved)');
      ok = true;
      code = 0;
    }
  } catch (e) {
    d.end();
    out('');
    out(e instanceof DemoError ? `DEMO FAILED at step ${d.step}/${TOTAL_STEPS} (${d.title || 'setup'}): ${e.message}` : `DEMO FAILED with an unexpected error: ${e.stack || e.message}`);
    out('RESULT: FAILED (simulated-agent demonstration)');
  }
  if (o.keep || !ok) {
    out(`${ok ? 'Kept' : 'Kept for inspection'}: ${dirs.root}`);
  } else {
    removeDir(dirs.root);
    out('The temporary directory, including the final report named above, was deleted; run with --keep to keep it.');
  }
  return code;
}

process.exitCode = main();
