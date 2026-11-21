'use strict';
// Regression tests for the defects found by the live run and by hands-on use of the CLI
// (HARDEN-001). One section per defect.
// SIMULATED AGENTS: "workers" and "reviewers" are test code feeding YAML to oo; no model runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./oo-harness.cjs');
const yaml = require('../scripts/lib/yaml.cjs');
const packages = require('../scripts/lib/packages.cjs');
const reports = require('../scripts/lib/reports.cjs');

test.after(H.cleanup);

// ---------------------------------------------------------------------------
// 1 and 2: report parsing and the quoting instructions
// ---------------------------------------------------------------------------

test('simulated-agent: a report with Windows paths and regular expressions in double quotes is accepted', () => {
  const p = H.project();
  p.ok(['init', 'Backslashes']);
  p.plan([H.spec('A-001')]);
  p.ok(['next']);
  p.write('a-001.txt', 'A\n');
  const report = [
    'Done.', '', '```yaml',
    'task_id: A-001', 'status: completed', 'summary: "wrote C:\\Users\\ExampleUser\\proj\\a-001.txt"',
    'files_changed: ["a-001.txt"]', 'self_check:',
    '  - met: true', '    evidence: "regex ^\\S+\\d{3}$ matched in D:\\src\\check.js"',
    'commands_run:', '  - {command: "node D:\\src\\check.js", exit_code: 0}',
    'commit: null', 'branch: null', 'issues: []', '```', ''].join('\n');
  const out = p.ok(['result', 'A-001', '--stdin'], { input: report });
  assert.match(out, /RESULT ACCEPTED: A-001 -> IMPLEMENTED/);
  const t = p.task('A-001');
  assert.equal(t.result.summary, 'wrote C:\\Users\\ExampleUser\\proj\\a-001.txt');
  assert.equal(t.evidence.self_check[0].evidence, 'regex ^\\S+\\d{3}$ matched in D:\\src\\check.js');
});

test('simulated-agent: an unparsable report is refused with the line and the request to resend it with single-quoted strings', () => {
  const p = H.project();
  p.ok(['init', 'Resend']);
  p.plan([H.spec('A-001')]);
  p.ok(['next']);
  const bad = '```yaml\ntask_id: A-001\nstatus: completed\nsummary: ok\nfiles_changed: []\nself_check:\n  - met: true\n    evidence: test: passed\n```\n';
  let out = p.refused(['result', 'A-001', '--stdin'], { input: bad });
  assert.match(out, /not valid YAML \(line 7 of the yaml block\): mapping values are not allowed here/);
  assert.match(out, /ask the agent to resend the report with every evidence string, command and path in single quotes/);
  assert.match(out, /forward slashes/);
  assert.equal(p.status('A-001'), 'DISPATCHED');
  // the same refusal for a review
  p.write('a-001.txt', 'A\n');
  p.ok(['result', 'A-001', '--stdin'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  p.ok(['verify', 'A-001']);
  const badReview = '```yaml\ntask_id: A-001\nreviewer: orchestrator\nverdict: approve\ncriteria:\n  - met: true\n    evidence: x: y\nfindings: []\n```\n';
  out = p.refused(['review', 'A-001', '--stdin'], { input: badReview });
  assert.match(out, /not valid YAML \(line 6 of the yaml block\)/);
  assert.match(out, /ask the agent to resend the report with every evidence string, command and path in single quotes/);
});

test('worker and reviewer packages, the templates and the five agent files ask for single-quoted strings and forward slashes', () => {
  const task = { task_id: 'A-001', title: 't', objective: 'o', acceptance_criteria: ['one'], authorized_files: ['a.txt'] };
  for (const text of [packages.workerPackage(task, { workspace: { mode: 'shared', workDir: '/w' } }), packages.reviewPackage(task, {})]) {
    assert.match(text, /single-quoted string/);
    assert.match(text, /forward slashes in paths/);
    const block = yaml.extractYamlBlock(text);
    assert.ok(block, 'the report format block parses out');
    assert.doesNotThrow(() => yaml.parse(block));
    assert.match(block, /evidence: '/);
  }
  const dir = path.join(H.SKILL, 'agents');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 5);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(text, /single-quoted string/, f);
    assert.match(text, /forward slashes in paths/, f);
    const block = yaml.extractYamlBlock(text);
    assert.match(block, /evidence: '/, f);
  }
});

// ---------------------------------------------------------------------------
// 3: correction re-verification
// ---------------------------------------------------------------------------

test('simulated-agent: a correction verification command fails verification and then passes, and is recorded in the evidence', () => {
  const p = H.project();
  p.ok(['init', 'Correction commands']);
  p.plan([H.spec('T-001')]);
  const good = 'node -e "process.exit(require(\'fs\').readFileSync(\'t-001.txt\',\'utf8\').trim()===\'good\'?0:1)"';
  const work = (content) => {
    p.ok(['next']);
    p.ok(['started', 'T-001']);
    p.write('t-001.txt', content);
    p.ok(['result', 'T-001', '--stdin'], { input: H.report('T-001', { files: ['t-001.txt'] }) });
  };

  // round 0: the task's own command (the file exists) passes although the content is wrong
  work('bad\n');
  p.ok(['verify', 'T-001']);
  assert.deepEqual(p.task('T-001').evidence.verification.correction_commands, []);
  p.ok(['review', 'T-001', '--stdin'], { input: H.review('T-001', { verdict: 'request_changes' }) });

  // an unsafe correction command is refused like an unsafe task command
  let out = p.refused(['correct', 'T-001', '--stdin'], { input: H.correction('T-001', { verification_commands: ['git push --force'] }) });
  assert.match(out, /unsafe verification_commands command/);
  assert.equal(p.status('T-001'), 'CORRECTION_REQUIRED');

  p.ok(['correct', 'T-001', '--stdin'], { input: H.correction('T-001', { verification_commands: [good] }) });
  assert.deepEqual(p.task('T-001').correction.verification_commands, [good]);

  // round 1: the worker did not fix it; the task's own command still passes but the correction command fails
  work('bad again\n');
  const pkg = fs.readFileSync(path.join(p.runDir(), 'packages', 'T-001-d2.md'), 'utf8');
  assert.match(pkg, /The orchestrator also runs these after you report/);
  out = p.refused(['verify', 'T-001']);
  assert.match(out, /VERIFICATION FAILED: T-001 -> CORRECTION_REQUIRED/);
  assert.match(out, /Failing command: node -e "process\.exit\(require\('fs'\)\.readFileSync\('t-001\.txt'/);
  let v = p.task('T-001').evidence.verification;
  assert.equal(v.passed, false);
  assert.equal(v.commands.length, 2, 'the task command and the correction command both ran');
  assert.deepEqual(v.commands.map((c) => c.exit_code), [0, 1]);
  assert.deepEqual(v.correction_commands, [good]);
  assert.match(fs.readFileSync(path.join(p.dir, v.evidence_file), 'utf8'), /Correction-round commands \(from the correction request\): node -e/);

  // round 2: fixed
  p.ok(['correct', 'T-001', '--stdin'], { input: H.correction('T-001', { verification_commands: [good], strategy_change: 'write the right content' }) });
  work('good\n');
  out = p.ok(['verify', 'T-001']);
  assert.match(out, /VERIFICATION PASSED: T-001/);
  v = p.task('T-001').evidence.verification;
  assert.deepEqual(v.commands.map((c) => c.exit_code), [0, 0]);
  assert.deepEqual(v.correction_commands, [good]);
});

test('validateCorrection accepts verification_commands, defaults them to an empty list and rejects non-lists and empty items', () => {
  const task = { task_id: 'A-001', authorized_files: ['a.txt'] };
  const base = { failure: 'f', evidence: 'e', expected_behavior: 'x', required_change: 'r', verification: ['node --version'] };
  let v = reports.validateCorrection(base, task, { round: 1 });
  assert.ok(v.ok);
  assert.deepEqual(v.correction.verification_commands, []);
  v = reports.validateCorrection(Object.assign({}, base, { verification_commands: ['node --version'] }), task, { round: 1 });
  assert.deepEqual(v.correction.verification_commands, ['node --version']);
  assert.match(reports.validateCorrection(Object.assign({}, base, { verification_commands: 'node --version' }), task, { round: 1 }).errors.join(), /must be a list/);
  assert.match(reports.validateCorrection(Object.assign({}, base, { verification_commands: [''] }), task, { round: 1 }).errors.join(), /non-empty string/);
});


// ---------------------------------------------------------------------------
// 4: final report paths
// ---------------------------------------------------------------------------

test('simulated-agent: a file reported by absolute path is listed once, project-relative, in the final report', () => {
  const p = H.project();
  p.ok(['init', 'Absolute paths']);
  p.plan([H.spec('A-001', { authorized_files: ['src/'], verification_commands: [H.existsCmd('src/a.txt')] }), H.spec('B-001')]);
  p.ok(['next']);
  p.write('src/a.txt', 'A\n');
  p.write('b-001.txt', 'B\n');
  const fwd = p.dir.split(path.sep).join('/');
  // the worker reports the file by its absolute Windows-style path (backslashes, drive letter in other case)
  const winAbs = `${p.dir.split(path.sep).join('\\')}\\src\\a.txt`;
  const lowerDrive = /^[A-Za-z]:/.test(winAbs) ? winAbs[0].toLowerCase() + winAbs.slice(1) : winAbs;
  const files = [lowerDrive, 'src/a.txt', `${fwd}/src/a.txt`, 'C:/elsewhere/other.txt'];
  const block = ['```yaml', 'task_id: A-001', 'status: completed', "summary: 'wrote src/a.txt'", 'files_changed:',
    ...files.map((f) => `  - '${f}'`), 'self_check:', "  - met: true", "    evidence: 'file exists'", '```', ''].join('\n');
  p.ok(['result', 'A-001', '--stdin'], { input: block });
  assert.deepEqual(p.task('A-001').result.files_changed, ['src/a.txt', 'C:/elsewhere/other.txt']);
  p.ok(['result', 'B-001', '--stdin'], { input: H.report('B-001', { files: [`${fwd}/b-001.txt`] }) });
  assert.deepEqual(p.task('B-001').result.files_changed, ['b-001.txt']);
  p.ok(['verify', 'A-001']);
  p.ok(['verify', 'B-001']);
  const out = p.ok(['final-report']);
  const section = out.split('## Files modified')[1].split('## Commands executed')[0];
  assert.equal(section.split('src/a.txt').length - 1, 1, `src/a.txt is listed once:\n${section}`);
  assert.match(section, /- src\/a\.txt \(A-001, observed by verification\)/);
  assert.match(section, /- b-001\.txt \(B-001, observed by verification\)/);
  assert.ok(!section.includes('\\'), 'no backslash path remains');
});

// ---------------------------------------------------------------------------
// 5: self-implemented task worktree location
// ---------------------------------------------------------------------------

test('simulated-agent: the worktree of a self-implemented task lies under the inbox and verification, review and integration work from it', () => {
  const p = H.project({ git: true });
  p.ok(['init', 'Self worktree']);
  p.plan([H.spec('O-001', { assigned_role: 'orchestrator' })]);
  let out = p.ok(['next']);
  const run = p.runRecord().run_id;
  const m = out.match(/git worktree add -b (\S+) "([^"]+)" (\S+)/);
  assert.ok(m, `oo next prints the worktree command:\n${out}`);
  const [, branch, dir, head] = m;
  const inboxWorktrees = path.join(p.dir, '.opus-inbox', 'worktrees');
  assert.ok(path.resolve(dir).startsWith(inboxWorktrees + path.sep), `${dir} is under .opus-inbox/worktrees`);
  assert.ok(!dir.replace(/\\/g, '/').includes('/.claude/'), 'the path does not go through .claude');
  assert.ok(path.resolve(dir).includes(run), 'the path names the run');
  assert.match(out, /oo result O-001 --stdin --worktree/);
  const pkg = fs.readFileSync(path.join(p.runDir(), 'packages', 'O-001-d1.md'), 'utf8');
  assert.ok(pkg.includes(dir), 'the package names the same worktree');

  // the orchestrator creates the worktree and works in it
  H.g(p.dir, 'worktree', 'add', '-q', '-b', branch, dir, head);
  fs.writeFileSync(path.join(dir, 'o-001.txt'), 'O\n');
  H.g(dir, 'add', '-A');
  H.g(dir, 'commit', '-q', '-m', 'O-001: self-implemented');
  out = p.ok(['result', 'O-001', '--stdin', '--worktree', dir, '--branch', branch], { input: H.report('O-001', { files: ['o-001.txt'], branch }) });
  assert.match(out, /RESULT ACCEPTED: O-001 -> IMPLEMENTED/);
  out = p.ok(['verify', 'O-001']);
  assert.match(out, /VERIFICATION PASSED: O-001/);
  assert.equal(path.resolve(p.dir, p.task('O-001').evidence.verification.workspace), path.resolve(dir));
  p.ok(['review-package', 'O-001']);
  p.ok(['review', 'O-001', '--stdin'], { input: H.review('O-001', { reviewer: 'opus-reviewer' }) });
  out = p.ok(['review', 'O-001', '--stdin', '--integrate'], { input: H.review('O-001') });
  assert.match(out, /INTEGRATED: O-001 -> COMPLETED \(merge commit [0-9a-f]{40}/);
  assert.equal(p.git('show', `${p.runRecord().workspace.integration_branch}:o-001.txt`), 'O');
  p.ok(['deliver']);
  out = p.ok(['cleanup']);
  assert.match(out, /worktree .*O-001-d1: removed/);
  assert.ok(!fs.existsSync(dir), 'cleanup removed the inbox worktree');
});

// ---------------------------------------------------------------------------
// 6: final audit on deliver
// ---------------------------------------------------------------------------

const AUDIT_SCRIPT = "process.exit(require('fs').existsSync('audit-fail.flag') ? 1 : 0);\n";

/** A project in the given mode with one completed, integrated task. */
function integratedProject(mode, config) {
  const p = H.project({ config });
  p.write('check-audit.cjs', AUDIT_SCRIPT);
  p.ok(['init', '--mode', mode, 'Final audit']);
  p.plan([H.spec('A-001')]);
  p.ok(['next']);
  p.write('a-001.txt', 'A\n');
  p.ok(['result', 'A-001', '--stdin', '--verify'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  p.ok(['review', 'A-001', '--stdin', '--integrate'], { input: H.review('A-001') });
  assert.equal(p.status('A-001'), 'COMPLETED');
  return p;
}

test('simulated-agent: deliver in a final_audit mode runs the regression command; a failing audit delivers nothing and saves the evidence', () => {
  const p = integratedProject('thorough', 'verification:\n  regression_command: node check-audit.cjs\n');
  p.write('audit-fail.flag', 'x\n');
  let out = p.refused(['deliver']);
  assert.match(out, /FINAL AUDIT FAILED: nothing delivered/);
  assert.match(out, /Failing command: node check-audit\.cjs/);
  assert.match(out, /Exit code: 1/);
  assert.ok(!p.runRecord().delivered, 'nothing was delivered');
  assert.ok(!p.runRecord().delivery, 'no delivery was recorded');
  assert.notEqual(p.runRecord().phase, 'delivered');
  const audit = p.runRecord().final_audit;
  assert.equal(audit.passed, false);
  assert.ok(fs.existsSync(path.join(p.dir, audit.evidence_file)), 'the evidence file was saved');
  assert.match(fs.readFileSync(path.join(p.dir, audit.evidence_file), 'utf8'), /Final audit of run[\s\S]*\$ node check-audit\.cjs[\s\S]*exit 1[\s\S]*Verdict: failed/);

  fs.rmSync(path.join(p.dir, 'audit-fail.flag'));
  out = p.ok(['deliver']);
  assert.match(out, /FINAL AUDIT PASSED: node check-audit\.cjs/);
  assert.match(out, /DELIVERED: shared workspace/);
  assert.equal(p.runRecord().delivered, true);
  assert.equal(p.runRecord().final_audit.passed, true);
});

test('simulated-agent: deliver says that no final audit command is configured and proceeds; a mode without final_audit runs no audit', () => {
  const p = integratedProject('thorough');
  const out = p.ok(['deliver']);
  assert.match(out, /FINAL AUDIT: mode thorough asks for a final audit, but no final audit command is configured/);
  assert.match(out, /DELIVERED: shared workspace/);

  const q = integratedProject('balanced', 'verification:\n  regression_command: node check-audit.cjs\n');
  q.write('audit-fail.flag', 'x\n');
  const out2 = q.ok(['deliver']);
  assert.doesNotMatch(out2, /FINAL AUDIT/);
  assert.match(out2, /DELIVERED/);
});

// ---------------------------------------------------------------------------
// 7: second reviewer for high-risk work
// ---------------------------------------------------------------------------

test('simulated-agent: approval of a high-risk task needs as many approving independent reviews as reviewers_high_risk', () => {
  const p = H.project();
  p.ok(['init', '--mode', 'maximum', 'Two reviewers']);
  p.plan([H.spec('H-001', { risk: 'high' })]);
  p.ok(['next']);
  p.write('h-001.txt', 'H\n');
  p.ok(['result', 'H-001', '--stdin', '--verify'], { input: H.report('H-001', { files: ['h-001.txt'] }) });

  p.ok(['review-package', 'H-001']);
  p.ok(['review', 'H-001', '--stdin'], { input: H.review('H-001', { reviewer: 'opus-reviewer' }) });
  assert.match(p.checkpoint().next_actions[0], /^oo review-package H-001 \(independent review required: 2 approving reviews for a high-risk task, 1 so far/);
  let out = p.refused(['review', 'H-001', '--stdin'], { input: H.review('H-001') });
  assert.match(out, /approval of H-001 refused; task state unchanged/);
  assert.match(out, /requires 2 approving independent reviews in the current round \(round 0\); 1 recorded/);
  assert.match(out, /NEXT: oo review-package H-001, launch the next reviewer/);
  assert.equal(p.status('H-001'), 'REVIEWING');
  assert.equal(p.task('H-001').evidence.reviews.length, 1, 'the refused approval was not stored');

  p.ok(['review-package', 'H-001']);
  out = p.ok(['review', 'H-001', '--stdin'], { input: H.review('H-001', { reviewer: 'opus-reviewer' }) });
  assert.match(out, /NEXT: oo review H-001 --stdin with your own review/);
  assert.match(p.ok(['review', 'H-001', '--stdin'], { input: H.review('H-001') }), /APPROVED: H-001 -> APPROVED/);
});

test('simulated-agent: a high-risk task needs one independent review where reviewers_high_risk is 1', () => {
  const p = H.project();
  p.ok(['init', '--mode', 'balanced', 'One reviewer']);
  p.plan([H.spec('H-001', { risk: 'high' })]);
  p.ok(['next']);
  p.write('h-001.txt', 'H\n');
  p.ok(['result', 'H-001', '--stdin', '--verify'], { input: H.report('H-001', { files: ['h-001.txt'] }) });
  p.ok(['review-package', 'H-001']);
  p.ok(['review', 'H-001', '--stdin'], { input: H.review('H-001', { reviewer: 'opus-reviewer' }) });
  assert.match(p.ok(['review', 'H-001', '--stdin'], { input: H.review('H-001') }), /APPROVED: H-001 -> APPROVED/);
});

// ---------------------------------------------------------------------------
// 8: oo learn does not record a run's outcomes twice
// ---------------------------------------------------------------------------

test('simulated-agent: oo learn run twice for the same run records its observations once', () => {
  const p = H.project({ config: 'improvement:\n  min_samples: 1\n' });
  p.ok(['init', 'Learn twice']);
  p.plan([H.spec('A-001'), H.spec('B-001', { verification_commands: [H.FAIL_CMD] })]);
  p.ok(['next']);
  p.write('a-001.txt', 'A\n');
  p.write('b-001.txt', 'B\n');
  p.ok(['result', 'A-001', '--stdin', '--verify'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  p.ok(['result', 'B-001', '--stdin'], { input: H.report('B-001', { files: ['b-001.txt'] }) });
  p.refused(['verify', 'B-001']);
  const lines = () => fs.readFileSync(p.paths.observationsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let out = p.ok(['learn']);
  const first = lines().length;
  assert.ok(first >= 3, 'two worker outcomes and one verification failure');
  assert.match(out, new RegExp(`LEARN: ${first} observation\\(s\\) collected from the current run; ${first} observation\\(s\\) on record`));
  out = p.ok(['learn']);
  assert.match(out, new RegExp(`LEARN: 0 observation\\(s\\) collected from the current run; ${first} observation\\(s\\) on record`));
  assert.equal(lines().length, first, 'the second learn appended nothing');
  const keys = lines().map((o) => `${o.category}|${o.task_id}|${o.text}`);
  assert.equal(new Set(keys).size, keys.length, 'no observation is on record twice');

  // an outcome that changed since the first learn is recorded (the latest per task counts)
  p.ok(['correct', 'B-001', '--stdin'], { input: H.correction('B-001') });
  out = p.ok(['learn']);
  assert.match(out, /LEARN: [1-9]\d* observation\(s\) collected/);
  p.ok(['learn']);
  assert.match(p.ok(['learn']), /LEARN: 0 observation\(s\) collected/);
});

// ---------------------------------------------------------------------------
// 9: the source of a context figure
// ---------------------------------------------------------------------------

test('oo context --utilization records the figure with source user; a status-line figure keeps source statusline', () => {
  const p = H.project();
  p.ok(['init', 'Context source']);
  let out = p.ok(['context', '--utilization', '42%']);
  assert.match(out, /CONTEXT: [a-z_]+ \(42% used, target \d+%, source user\)/);
  assert.equal(JSON.parse(fs.readFileSync(p.paths.contextFile, 'utf8')).source, 'user');
  assert.match(p.ok(['context']), /\(42% used, target \d+%, source user\)/);
  assert.equal(JSON.parse(p.ok(['status', '--json'])).context.source, 'user');

  // the status-line bridge writes no source field: its figure is reported as statusline
  fs.writeFileSync(p.paths.contextFile, JSON.stringify({ used_percentage: 33, context_window_size: 200000, ts: new Date().toISOString() }));
  assert.match(p.ok(['context']), /\(33% used, target \d+%, source statusline\)/);
});

// ---------------------------------------------------------------------------
// 10: oo authorize must raise the limit
// ---------------------------------------------------------------------------

test('oo authorize refuses a value that is not higher than the effective limit and still raises with a higher one', () => {
  const p = H.project({ config: 'budget:\n  agent_call_limit: 50\n' });
  p.ok(['init', 'Authorize']);
  const auth = (limit, value) => ['authorize', '--limit', limit, '--value', String(value), '--by', 'user', '--reason', 'the user said so'];
  let out = p.refused(auth('agent_call_limit', 1));
  assert.match(out, /agent_call_limit is already 50; --value 1 is not higher, so the limit is not raised/);
  assert.doesNotMatch(out, /raised to/);
  assert.match(p.refused(auth('agent_call_limit', 50)), /already 50/);
  assert.deepEqual(p.runRecord().authorizations, [], 'a refused authorization is not recorded');
  out = p.ok(auth('agent_call_limit', 60));
  assert.match(out, /AUTHORIZED: agent_call_limit raised to 60/);
  assert.match(p.refused(auth('agent_call_limit', 55)), /already 60/, 'the effective limit includes the earlier authorization');
  // a limit that is not set cannot be raised; the retry and round limits compare with their effective value
  assert.match(p.refused(auth('token_limit', 1000)), /token_limit has no limit set/);
  assert.match(p.refused(auth('max_retries', 2)), /max_retries is already 2/);
  assert.match(p.ok(auth('max_retries', 4)), /max_retries raised to 4/);
  assert.match(p.refused(auth('max_review_rounds', 3)), /max_review_rounds is already 3/);
});

// ---------------------------------------------------------------------------
// 11: no worker model for work the orchestrator does itself
// ---------------------------------------------------------------------------

test('a task planned or escalated with role orchestrator shows no worker model in oo plan and oo status', () => {
  const p = H.project();
  p.ok(['init', 'Orchestrator role']);
  const plan = p.plan([H.spec('O-001', { assigned_role: 'orchestrator' }), H.spec('A-001')]);
  assert.match(plan, /role orchestrator \| agent none \(the orchestrator does it\) \| model self \|/);
  assert.match(plan, /role implementation-worker \| agent [^|]+\| model haiku \|/, 'a worker task still shows its model');
  let out = p.ok(['status']);
  assert.match(out, /O-001\s+PENDING\s+orchestrator\/self\b/);
  assert.match(out, /A-001\s+PENDING\s+implementation-worker\/haiku/);
  assert.equal(JSON.parse(p.ok(['status', '--json'])).tasks.find((t) => t.task_id === 'O-001').model, 'self');

  // escalate a worker task to the orchestrator
  p.ok(['next']);
  p.ok(['started', 'A-001']);
  p.ok(['worker-failed', 'A-001', '--kind', 'tool', '--reason', 'tool broke']);
  p.ok(['fail', 'A-001', '--reason', 'give it to the orchestrator']);
  out = p.ok(['escalate', 'A-001', '--role', 'orchestrator', '--reason', 'do it yourself']);
  assert.match(out, /ESCALATED: A-001 -> READY: role implementation-worker -> orchestrator, model haiku -> self/);
  out = p.ok(['status']);
  assert.match(out, /A-001\s+READY\s+orchestrator\/self\b/);
  assert.doesNotMatch(out.split('\n').filter((l) => /^\s+[AO]-001/.test(l)).join('\n'), /haiku/);
});
