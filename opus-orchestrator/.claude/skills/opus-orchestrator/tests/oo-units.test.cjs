'use strict';
// Unit tests for the helper modules behind oo.cjs: cliargs, workspace attribution, packages and
// reportgen. Pure functions; no process is spawned.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cliargs = require('../scripts/lib/cliargs.cjs');
const ws = require('../scripts/lib/workspace.cjs');
const packages = require('../scripts/lib/packages.cjs');
const reportgen = require('../scripts/lib/reportgen.cjs');
const store = require('../scripts/lib/store.cjs');

test('parseInitText reads options only before the objective and keeps the objective verbatim', () => {
  const r = cliargs.parseInitText('--mode thorough --max-workers=4\n--plan-only --review-rounds 0 Build  the API --mode fast\n  with --status care\n');
  assert.deepEqual(r.errors, []);
  assert.equal(r.mode, 'thorough');
  assert.equal(r.max_workers, 4);
  assert.equal(r.review_rounds, 0);
  assert.equal(r.plan_only, true);
  assert.equal(r.status, false, '--status after the objective is part of it');
  assert.equal(r.objective, 'Build  the API --mode fast\n  with --status care');

  // regression: flag-like words inside the objective are not options
  let x = cliargs.parseInitText('Add a --mode switch to the CLI');
  assert.deepEqual([x.errors, x.mode, x.objective], [[], null, 'Add a --mode switch to the CLI']);
  x = cliargs.parseInitText('Document the --status flag');
  assert.deepEqual([x.errors, x.status, x.objective], [[], false, 'Document the --status flag']);
  x = cliargs.parseInitText('x --resume');
  assert.deepEqual([x.resume, x.objective], [false, 'x --resume']);
  x = cliargs.parseInitText('x --mode');
  assert.deepEqual([x.errors, x.objective], [[], 'x --mode']);

  // a bare -- ends the options explicitly
  x = cliargs.parseInitText('--mode fast -- --plan-only matters');
  assert.deepEqual([x.mode, x.plan_only, x.objective], ['fast', false, '--plan-only matters']);
  x = cliargs.parseInitText('-- --status');
  assert.deepEqual([x.status, x.objective], [false, '--status']);

  assert.equal(cliargs.parseInitText('--status').status, true);
  assert.equal(cliargs.parseInitText('--resume').resume, true);
  assert.equal(cliargs.parseInitText('--unknown-flag text').objective, '--unknown-flag text', 'an unknown --word starts the objective');
  assert.deepEqual(cliargs.initOptionOf('--mode=fast'), { name: 'mode', inline: 'fast', takesValue: true });
  assert.equal(cliargs.initOptionOf('--'), null);
  assert.equal(cliargs.initOptionOf('--stdin'), null);
});

test('parseInitText reports invalid and missing values among the leading options', () => {
  assert.match(cliargs.parseInitText('--mode turbo x').errors[0], /--mode must be one of/);
  assert.match(cliargs.parseInitText('--max-workers 0 x').errors[0], /--max-workers must be an integer from 1 to 20/);
  assert.match(cliargs.parseInitText('--max-workers 2.5 x').errors[0], /--max-workers/);
  assert.match(cliargs.parseInitText('--review-rounds 11 x').errors[0], /--review-rounds must be an integer from 0 to 10/);
  assert.match(cliargs.parseInitText('--mode').errors[0], /--mode needs a value/);
  const r = cliargs.parseInitText('--mode --plan-only x');
  assert.match(r.errors[0], /--mode needs a value/);
  assert.equal(r.plan_only, true);
  assert.equal(r.objective, 'x');
  assert.match(cliargs.parseInitText('--plan-only=yes x').errors[0], /does not take a value/);
});

test('parseArgv handles values, booleans, = and --; checkAllowed names the bad option', () => {
  const a = cliargs.parseArgv(['A-001', '--kind', 'crash', '--reason=it died', '--stdin', '--', '--not-an-option']);
  assert.deepEqual(a.pos, ['A-001', '--not-an-option']);
  assert.deepEqual(a.opts, { kind: 'crash', reason: 'it died', stdin: true });
  assert.throws(() => cliargs.parseArgv(['--reason']), /--reason needs a value/);
  assert.throws(() => cliargs.parseArgv(['--stdin=1']), /does not take a value/);
  assert.throws(() => cliargs.checkAllowed({ x: 1 }, ['kind'], 'worker-failed'), (e) => e.code === 'USAGE' && /worker-failed does not accept --x \(accepted: --kind\)/.test(e.message));
});

function task(id, status, files, history) {
  return { task_id: id, status, authorized_files: files, history: history || [{ ts: '2026-01-01T00:00:00.000Z', from: null, to: status }] };
}

test('attributeShared: own scope, other in-flight task scope, and violations', () => {
  const since = '2026-01-01T00:00:05.000Z';
  const me = task('A-001', 'IMPLEMENTED', ['src/a/']);
  const other = task('B-001', 'RUNNING', ['src/b.txt']);
  const doneBefore = task('C-001', 'COMPLETED', ['docs/'], [
    { ts: '2026-01-01T00:00:00.000Z', from: null, to: 'PENDING' },
    { ts: '2026-01-01T00:00:01.000Z', from: 'INTEGRATING', to: 'COMPLETED' },
  ]);
  const doneAfter = task('D-001', 'COMPLETED', ['lib/'], [
    { ts: '2026-01-01T00:00:00.000Z', from: null, to: 'PENDING' },
    { ts: '2026-01-01T00:00:03.000Z', from: 'READY', to: 'DISPATCHED' },
    { ts: '2026-01-01T00:00:09.000Z', from: 'INTEGRATING', to: 'COMPLETED' },
  ]);
  const r = ws.attributeShared(me, ['src/a/x.js', 'src/b.txt', 'docs/readme.md', 'lib/util.js', 'stray.txt'], [me, other, doneBefore, doneAfter], since);
  assert.deepEqual(r.own, ['src/a/x.js']);
  assert.deepEqual(r.ignored, [{ file: 'src/b.txt', owner: 'B-001' }, { file: 'lib/util.js', owner: 'D-001' }]);
  assert.deepEqual(r.violations, ['docs/readme.md', 'stray.txt']);
  assert.equal(r.ok, false);
  assert.equal(ws.statusAt(doneAfter, since), 'DISPATCHED');
  assert.equal(ws.ownedWorkSince(doneBefore, since), false);
});

test('snapshotIgnore lists git data, node_modules, agent worktrees, the state directory and the inbox', () => {
  const paths = store.resolvePaths({ projectDir: path.join(path.sep, 'p') });
  assert.deepEqual(ws.snapshotIgnore(paths), ['.git', 'node_modules', '.claude/worktrees', '.claude/opus-orchestrator', '.opus-inbox']);
  const outside = store.resolvePaths({ projectDir: path.join(path.sep, 'p'), stateDir: path.join(path.sep, 'elsewhere') });
  assert.deepEqual(ws.snapshotIgnore(outside), ['.git', 'node_modules', '.claude/worktrees', '.opus-inbox']);
});

const T = {
  task_id: 'A-001', title: 'Title', objective: 'Do it.', context: '', authorized_files: [], dependencies: [],
  acceptance_criteria: ['one', 'two'], deliverables: [], verification: [], verification_commands: [], constraints: [],
  tool_permissions: [], routing: { role: 'research-worker' }, review_round: 1,
};

test('workerPackage: read-only task, correction section, report template with one entry per criterion', () => {
  const text = packages.workerPackage(Object.assign({}, T, {
    correction: { round: 1, failure: 'f', evidence: 'e', expected_behavior: 'x', required_change: 'r', scope: [], verification: ['npm test'], strategy_change: 's' },
  }), { brief: 'Investigate.', agent: 'opus-researcher', workspace: { mode: 'shared', workDir: '/p' } });
  assert.match(text, /## Authorized files\nRead-only task: do not create, modify or delete any file\./);
  assert.match(text, /## Role\nresearch-worker \(agent opus-researcher\)\. Investigate\./);
  assert.match(text, /## Correction request \(round 1\)\n[\s\S]*- Strategy change: s/);
  assert.match(text, /Shared workspace: read files in \/p/);
  assert.equal((text.match(/ {2}- met: true/g) || []).length, 2);
  const order = ['## Workspace', '## Correction request', '## Report format'].map((s) => text.indexOf(s));
  assert.ok(order[0] < order[1] && order[1] < order[2]);
  const iso = packages.workerPackage(T, { workspace: { mode: 'isolated', integrationHead: 'abc123', integrationBranch: 'opus-orch/x/integration' } });
  assert.match(iso, /Before anything else run: git merge --no-edit abc123/);
  const ro = packages.workerPackage(T, { workspace: { mode: 'readonly', workDir: '/int' } });
  assert.match(ro, /Read the files in \/int: the integration worktree/);
});

test('shortPrompt and agentCallLine', () => {
  assert.equal(packages.shortPrompt('/r/p.md', null), 'Read the file /r/p.md and carry out the task package in it exactly. It is your complete brief. End with the report block it specifies.');
  assert.match(packages.shortPrompt('/r/p.md', '/s/agents/a.md'), /^First read \/s\/agents\/a\.md and follow it as your role definition\. Then read the file \/r\/p\.md/);
  assert.equal(packages.agentCallLine({ subagentType: 'x', model: 'haiku', isolation: 'worktree', description: 'A "q"' }), 'Agent call: subagent_type=x | model=haiku | isolation=worktree | description="A \\"q\\""');
  assert.equal(packages.describeTask({ task_id: 'A-001', title: 'x'.repeat(100) }).length, 60);
});

test('reportgen prints a dollar cost only when a measured cost was recorded', () => {
  assert.equal(reportgen.costText({ cost_usd: null, cost_measured: false }), 'not measured');
  assert.equal(reportgen.costText({ cost_usd: 1.5, cost_measured: false }), 'not measured');
  assert.equal(reportgen.costText({ cost_usd: 1.5, cost_measured: true }), '$1.50 (measured)');
  assert.equal(reportgen.tokensText({ tokens: { total: 9 }, tokens_measured: false }), 'not measured');
  assert.equal(reportgen.overallStatus([{ status: 'COMPLETED' }, { status: 'CANCELLED' }]), 'PARTIAL');
  assert.equal(reportgen.overallStatus([{ status: 'COMPLETED' }]), 'COMPLETE');
  assert.equal(reportgen.overallStatus([{ status: 'FAILED' }]), 'FAILED');
  const run = { run_id: 'r', objective: 'o', usage: { cost_measured: false }, workspace: { strategy: 'shared' } };
  const tasks = [{ task_id: 'A-001', title: 't', status: 'REVIEWING', evidence: { verification: { passed: false, commands: [], reasons: ['x'] } } }];
  const r = reportgen.finalReport(run, tasks, { now: 'n' });
  assert.match(r.text, /- A-001 t: verification FAILED/);
  assert.match(r.text, /## Verified tasks\n\nNone\./);
  assert.doesNotMatch(r.text, /\$/);
});
