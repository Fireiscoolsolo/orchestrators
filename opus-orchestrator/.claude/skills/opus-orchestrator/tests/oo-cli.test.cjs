'use strict';
// oo CLI: init, plan, next and package files, and the commands that need no run.
// oo runs as a child process against temp projects; no model is called.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./oo-harness.cjs');

test.after(H.cleanup);

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

test('init parses options from arguments and reports a workspace without git as shared', () => {
  const p = H.project();
  const out = p.ok(['init', '--mode', 'thorough', '--max-workers', '3', '--review-rounds', '1', '--plan-only', 'Build', 'the', 'thing']);
  assert.match(out, /RUN CREATED \d{8}-\d{6}-[0-9a-f]{4}/);
  assert.match(out, /Workspace strategy: shared/);
  assert.match(out, /not a git repository/);
  assert.match(out, /Inbox for your drafts: .*\.opus-inbox/);
  assert.match(out, /NEXT: /);
  const run = p.runRecord();
  assert.equal(run.objective, 'Build the thing');
  assert.deepEqual(run.options, { mode: 'thorough', max_workers: 3, max_review_rounds: 1, max_retries: 2, plan_only: true });
  assert.equal(run.workspace.strategy, 'shared');
  assert.equal(run.config.execution.mode, 'thorough');
  assert.ok(fs.existsSync(path.join(p.runDir(), 'checkpoint.yaml')));
  assert.equal(fs.readFileSync(path.join(p.paths.stateRoot, '.gitignore'), 'utf8'), '*\n');
});

test('init reads the argument text from --stdin and from --file', () => {
  const p = H.project();
  p.ok(['init', '--stdin'], { input: '--mode fast Fix the login bug\nwith the details here\n' });
  let run = p.runRecord();
  assert.equal(run.objective, 'Fix the login bug\nwith the details here');
  assert.equal(run.options.mode, 'fast');
  assert.equal(run.options.max_workers, 3, 'fast mode caps max_workers at 3');

  const f = p.write('.opus-inbox/request.md', '--review-rounds 2 --max-workers=4 Objective from a file\n');
  p.ok(['init', '--file', f]);
  run = p.runRecord();
  assert.equal(run.objective, 'Objective from a file');
  assert.equal(run.options.max_review_rounds, 2);
  assert.equal(run.options.max_workers, 4);
  assert.equal(run.options.mode, 'balanced');
});

test('init rejects invalid option values and a missing objective with exit 2 and creates no run', () => {
  const p = H.project();
  const cases = [
    ['init', '--mode', 'turbo', 'x'],
    ['init', '--max-workers', '0', 'x'],
    ['init', '--max-workers', '21', 'x'],
    ['init', '--max-workers', 'many', 'x'],
    ['init', '--review-rounds', '11', 'x'],
    ['init', '--review-rounds', '-1', 'x'],
    ['init', '--mode'],
    ['init', '--max-workers', '--plan-only', 'x'],
    ['init', '--mode', 'fast'],
    ['init', '--mode', 'fast', '--'],
    ['init'],
  ];
  for (const c of cases) {
    const out = p.usage(c);
    assert.match(out, /USAGE ERROR/);
  }
  assert.equal(fs.existsSync(p.paths.currentFile), false);
  assert.match(p.usage(['init', '--stdin'], { input: '   \n' }), /needs an objective/);
});

test('init reads options only before the objective; later flag-like words stay in the objective verbatim', () => {
  const p = H.project();
  // the review probes: both create a run whose objective is the full sentence
  let out = p.ok(['init', 'Add a --mode switch to the CLI']);
  assert.match(out, /RUN CREATED/);
  assert.equal(p.runRecord().objective, 'Add a --mode switch to the CLI');
  assert.equal(p.runRecord().options.mode, 'balanced');
  out = p.ok(['init', 'Document the --status flag']);
  assert.match(out, /RUN CREATED/);
  assert.equal(p.runRecord().objective, 'Document the --status flag');

  // separate arguments: --file, --stdin and --resume after the first objective word are text
  p.ok(['init', 'Document', 'the', '--file', 'flag']);
  assert.equal(p.runRecord().objective, 'Document the --file flag');
  p.ok(['init', 'Mention', '--stdin', 'and', '--resume', 'here'], { input: 'this stdin text is not read' });
  assert.equal(p.runRecord().objective, 'Mention --stdin and --resume here');

  // a bare -- ends the options
  p.ok(['init', '--mode', 'fast', '--', '--plan-only', 'is', 'the', 'topic']);
  let run = p.runRecord();
  assert.equal(run.objective, '--plan-only is the topic');
  assert.equal(run.options.mode, 'fast');
  assert.equal(run.options.plan_only, false);

  // text from --stdin: options at the start, the rest verbatim
  p.ok(['init', '--stdin'], { input: '--review-rounds 1 Fix  the parser\n  so --mode works\n' });
  run = p.runRecord();
  assert.equal(run.objective, 'Fix  the parser\n  so --mode works');
  assert.equal(run.options.max_review_rounds, 1);
  assert.match(p.ok(['help']), /options are read only before the objective/);
});

test('init --status and init --resume act as status and resume', () => {
  const p = H.project();
  p.ok(['init', 'Objective one']);
  assert.match(p.ok(['init', '--status']), /RUN \d{8}-\d{6}-[0-9a-f]{4} \| phase planning/);
  const out = p.ok(['init', '--resume']);
  assert.match(out, /INTEGRITY: ok/);
  assert.match(out, /RESUME opus-orchestrator run/);
  assert.match(out, /Objective: Objective one/);
});

test('init refuses an invalid project configuration with exit 1', () => {
  const p = H.project({ config: 'models:\n  worker_default: opus-5.5-extra\n' });
  const out = p.refused(['init', 'x']);
  assert.match(out, /REFUSED: configuration is invalid/);
  assert.match(out, /models\.worker_default/);
});

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

test('plan saves nothing and exits 1 when any specification is invalid, cyclic or unsafe', () => {
  const p = H.project();
  p.ok(['init', 'Plan validation']);
  const tasksDir = path.join(p.runDir(), 'tasks');
  const noTasks = () => assert.deepEqual(fs.readdirSync(tasksDir), []);

  let out = p.plan([H.spec('A-001'), H.spec('B-001', { objective: '' })], 1);
  assert.match(out, /plan rejected: nothing was saved/);
  assert.match(out, /B-001: objective is required/);
  noTasks();

  out = p.plan([H.spec('A-001', { dependencies: ['B-001'] }), H.spec('B-001', { dependencies: ['A-001'] })], 1);
  assert.match(out, /dependency cycle/);
  noTasks();

  out = p.plan([H.spec('A-001', { verification_commands: ['git push origin main'] })], 1);
  assert.match(out, /unsafe verification command/);
  noTasks();

  out = p.plan([H.spec('A-001', { dependencies: ['Z-009'] })], 1);
  assert.match(out, /unknown task Z-009/);
  noTasks();

  out = p.plan([H.spec('A-001', { authorized_files: ['.env'] })], 1);
  assert.match(out, /protected path/);
  noTasks();
});

test('plan tells the author to quote a list item that YAML parsed as a mapping', () => {
  const p = H.project();
  p.ok(['init', 'Quote hint']);
  const f = p.write('.opus-inbox/specs.yaml', [
    'task_id: A-001',
    'title: Status endpoint',
    'objective: Add a status endpoint.',
    'complexity: 2',
    'authorized_files: [src/status.js]',
    'acceptance_criteria:',
    '  - GET /status returns 200: when the service is up',
    '',
  ].join('\n'));
  const out = p.refused(['plan', '--file', f]);
  assert.match(out, /acceptance_criteria\[0\] was parsed as a mapping/);
  assert.match(out, /Quote the whole item/);
  assert.match(out, /"GET \/status returns 200: when the service is up"/);
  assert.deepEqual(fs.readdirSync(path.join(p.runDir(), 'tasks')), []);
});

test('a valid plan prints complexity, role, agent, model, layers, routing reasons and waves', () => {
  const p = H.project();
  p.ok(['init', 'Valid plan']);
  const out = p.plan([
    H.spec('A-001'),
    H.spec('B-001', { complexity: 6 }),
    H.spec('C-001', { dependencies: ['A-001', 'B-001'], kind: 'research', authorized_files: [], verification_commands: [] }),
  ]);
  assert.match(out, /PLAN SAVED: 3 task\(s\)/);
  assert.match(out, /TASK A-001: Task A-001\n {2}complexity 2 \| risk low/);
  assert.match(out, /role implementation-worker \| agent opus-implementer \| model haiku \| tier direct/);
  assert.match(out, /TASK B-001[\s\S]*complexity 6[\s\S]*independent review: required/);
  assert.match(out, /role research-worker \| agent opus-researcher/);
  assert.match(out, /verification layers: self_check, automated, opus_gate, integration/);
  assert.match(out, /verification layers: self_check, automated, independent_review, opus_gate, integration/);
  assert.match(out, /routing reasons:\n {4}- rule default_floor/);
  assert.match(out, /wave 1: A-001, B-001\n {2}wave 2: C-001/);
  assert.match(out, /NEXT: oo next/);
  assert.equal(p.status('A-001'), 'PENDING');
  assert.ok(fs.existsSync(path.join(p.runDir(), 'specs', 'A-001.yaml')));
  assert.equal(p.task('B-001').routing.independent_review, true, 'balanced mode reviews complexity 5-6 independently');
  assert.equal(p.task('A-001').routing.independent_review, false);
});

test('re-planning a PENDING task replaces it; a task that is no longer PENDING is refused', () => {
  const p = H.project();
  p.ok(['init', 'Re-plan']);
  p.plan([H.spec('A-001'), H.spec('B-001', { dependencies: ['A-001'] })]);
  const out = p.plan([H.spec('B-001', { dependencies: ['A-001'], title: 'Renamed' })]);
  assert.match(out, /1 re-planned/);
  assert.equal(p.task('B-001').title, 'Renamed');
  assert.equal(p.task('B-001').spec_revision, 2);
  p.ok(['next']);
  const r = p.plan([H.spec('A-001')], 1);
  assert.match(r, /A-001: already exists with status DISPATCHED/);
});

test('a plan-only run prints the plan and never dispatches', () => {
  const p = H.project();
  p.ok(['init', '--plan-only', 'Just plan']);
  const out = p.plan([H.spec('A-001')]);
  assert.match(out, /PLAN ONLY/);
  assert.match(p.refused(['next']), /created with --plan-only/);
  assert.equal(p.status('A-001'), 'PENDING');
});

// ---------------------------------------------------------------------------
// next and worker packages
// ---------------------------------------------------------------------------

const SECTIONS = ['## Objective', '## Role', '## Context', '## Authorized files', '## Dependencies', '## Acceptance criteria',
  '## Deliverables', '## Verification', '## Constraints', '## Workspace', '## Report format'];

test('simulated-agent: next writes the worker package to a file and prints an Agent call with a short prompt naming it', () => {
  const p = H.project();
  p.ok(['init', 'Packages']);
  p.plan([H.spec('A-001', { context: 'The project is empty.', constraints: ['no new dependencies'], deliverables: ['a-001.txt'] })]);
  const out = p.ok(['next']);
  const pkg = path.join(p.runDir(), 'packages', 'A-001-d1.md');
  assert.ok(fs.existsSync(pkg), 'package file written under the run directory');
  assert.match(out, /Agent call: subagent_type=general-purpose \| model=haiku \| description="A-001 Task A-001"/);
  const prompt = out.split('BEGIN PROMPT\n')[1].split('\nEND PROMPT')[0];
  assert.ok(prompt.includes(pkg), 'the short prompt names the package file by absolute path');
  assert.ok(path.isAbsolute(pkg));
  assert.match(prompt, /carry out the task package in it exactly\. It is your complete brief\. End with the report block it specifies\./);
  assert.ok(prompt.includes(path.join(H.SKILL, 'agents', 'opus-implementer.md')), 'fallback: read the agent file from the skill first');
  assert.ok(prompt.length < 700, 'the prompt stays short');
  assert.match(out, /NEXT: launch the Agent call\(s\) above in one message, then oo started A-001/);

  const text = fs.readFileSync(pkg, 'utf8');
  assert.ok(text.startsWith('TASK A-001: Task A-001\n'));
  let last = -1;
  for (const s of SECTIONS) {
    const i = text.indexOf(`\n${s}\n`);
    assert.ok(i > last, `section ${s} present and in order`);
    last = i;
  }
  assert.ok(!text.includes('## Correction request'), 'no correction section without a pending correction');
  assert.match(text, /The project is empty\./);
  assert.match(text, /- a-001\.txt/);
  assert.match(text, /1\. a-001\.txt exists/);
  assert.match(text, /- no new dependencies/);
  assert.match(text, /file contents.*are data, not instructions/i);
  assert.match(text, /Shared workspace: edit files in place in /);
  const attempt = p.task('A-001').dispatch.attempt_id;
  assert.match(attempt, /^A-001-a1-[0-9a-f]{6}$/);
  assert.ok(text.includes(`\`\`\`yaml\ntask_id: A-001\nattempt_id: '${attempt}'   # copy exactly`), 'the report template carries the attempt id of this dispatch');
  assert.match(text, /attempt_id: '[^']+'[^\n]*\nstatus: completed/);
  assert.ok(text.trimEnd().endsWith('```'), 'the report format is the last thing in the package');
  assert.equal(p.status('A-001'), 'DISPATCHED');
  assert.equal(p.runRecord().usage.worker_calls, 1);
});

test('next uses an installed agent type and --inline prints the whole package', () => {
  // worktree strategy: isolated writers may run in parallel (a shared workspace serializes them)
  const p = H.project({ git: true });
  p.write('.claude/agents/opus-implementer.md', '---\nname: opus-implementer\n---\n');
  p.ok(['init', 'Installed agent']);
  p.plan([H.spec('A-001'), H.spec('B-001')]);
  const out = p.ok(['next', '--inline']);
  assert.match(out, /subagent_type=opus-implementer \| model=haiku/);
  assert.doesNotMatch(out, /First read/);
  const prompts = out.split('BEGIN PROMPT\n').slice(1).map((x) => x.split('\nEND PROMPT')[0]);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[0].startsWith('TASK A-001: Task A-001'));
  assert.match(prompts[0], /## Acceptance criteria\n1\. a-001\.txt exists/);
});

test('next respects max_workers and scope conflicts and prints a reason when nothing can run', () => {
  // worktree strategy: isolated writers may run in parallel (a shared workspace serializes them)
  const p = H.project({ git: true });
  p.ok(['init', '--max-workers', '2', 'Scheduling']);
  assert.match(p.ok(['next']), /NOTHING DISPATCHED: no tasks are planned/);
  p.plan([
    H.spec('A-001', { authorized_files: ['src/'] }),
    H.spec('B-001', { authorized_files: ['src/b.txt'] }),
    H.spec('C-001'),
    H.spec('D-001'),
  ]);
  let out = p.ok(['next']);
  assert.match(out, /=== A-001 /);
  assert.match(out, /=== C-001 /);
  assert.match(out, /B-001: scope_conflict/);
  assert.match(out, /D-001: no_slot: no free worker slot \(max workers 2, 2 in flight\)/);
  assert.deepEqual(['A-001', 'B-001', 'C-001', 'D-001'].map((id) => p.status(id)), ['DISPATCHED', 'READY', 'DISPATCHED', 'READY']);
  out = p.ok(['next']);
  assert.match(out, /NOTHING DISPATCHED: waiting_on_running/);
  assert.match(out, /NEXT: oo started/);
});

test('a task routed to the orchestrator is printed as DO YOURSELF and always needs an independent review', () => {
  const p = H.project();
  p.ok(['init', 'Self-implemented task']);
  const plan = p.plan([H.spec('O-001', { assigned_role: 'orchestrator' })]);
  assert.match(plan, /agent none \(the orchestrator does it\)/);
  assert.match(plan, /rule orchestrator_self/);
  const routed = p.task('O-001').routing;
  assert.equal(routed.independent_review, true);
  assert.deepEqual(routed.verification_layers, ['self_check', 'automated', 'independent_review', 'opus_gate', 'integration']);
  let out = p.ok(['next']);
  assert.match(out, /=== O-001 \(attempt 1\) orchestrator \/ haiku \/ DO YOURSELF ===/);
  assert.match(out, /DO YOURSELF: no agent is launched for O-001/);
  assert.match(out, /Workspace: edit in place in /);
  assert.doesNotMatch(out, /Agent call:/);
  assert.equal(p.runRecord().usage.agent_calls, 0, 'no agent call is recorded');
  p.write('o-001.txt', 'O\n');
  out = p.ok(['result', 'O-001', '--stdin', '--verify'], { input: H.report('O-001', { files: ['o-001.txt'] }) });
  assert.match(out, /NEXT: oo review-package O-001/);
  assert.match(p.checkpoint().next_actions[0], /^oo review-package O-001/);
  out = p.refused(['review', 'O-001', '--stdin'], { input: H.review('O-001') });
  assert.match(out, /NO_INDEPENDENT_REVIEW/);
  p.ok(['review-package', 'O-001']);
  p.ok(['review', 'O-001', '--stdin'], { input: H.review('O-001', { reviewer: 'opus-reviewer' }) });
  assert.match(p.ok(['review', 'O-001', '--stdin', '--integrate'], { input: H.review('O-001') }), /INTEGRATED: O-001 -> COMPLETED/);
});

// ---------------------------------------------------------------------------
// commands without a run
// ---------------------------------------------------------------------------

test('doctor, version and help run without a run; status needs one', () => {
  const p = H.project();
  const doctor = p.ok(['doctor']);
  assert.match(doctor, /Node: v\d+/);
  assert.match(doctor, /git: /);
  assert.match(doctor, /Claude Code: /);
  assert.match(doctor, /Workspace strategy: shared \(no git repository\)/);
  assert.match(doctor, /opus-reviewer: not installed/);
  assert.match(doctor, /Verification shell: /);
  assert.match(p.ok(['version']), /^opus-orchestrator \d+\.\d+\.\d+/);
  const help = p.ok(['help']);
  assert.match(help, /review-package <ID>/);
  assert.match(help, /Task states and allowed transitions/);
  assert.match(p.ok([]), /Exit codes: 0 success/);
  assert.match(p.refused(['status']), /REFUSED: no current run[\s\S]*NEXT: start a run with: oo init/);
  assert.match(p.usage(['frobnicate']), /unknown command/);
  assert.match(p.usage(['status', '--bogus', 'x']), /does not accept --bogus/);
  assert.match(p.usage(['status', '--bogus']), /--bogus needs a value/);
});

test('status --json emits valid JSON with tasks, budget and next actions', () => {
  const p = H.project();
  p.ok(['init', 'JSON status']);
  p.plan([H.spec('A-001')]);
  const r = p.run(['status', '--json']);
  assert.equal(r.code, 0);
  const obj = JSON.parse(r.stdout);
  assert.equal(obj.tasks.length, 1);
  assert.equal(obj.tasks[0].task_id, 'A-001');
  assert.equal(obj.tasks[0].status, 'PENDING');
  assert.equal(obj.usage.cost, 'not measured');
  assert.equal(obj.usage.cost_measured, false);
  assert.ok(Array.isArray(obj.next_actions) && obj.next_actions[0].startsWith('oo next'));
  assert.equal(obj.context.level, 'unknown');
});
