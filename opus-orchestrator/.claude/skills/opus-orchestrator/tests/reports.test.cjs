'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const yaml = require('../scripts/lib/yaml.cjs');
const reports = require('../scripts/lib/reports.cjs');

const CLI = path.resolve(__dirname, '..', 'scripts', 'verify_results.cjs');

// The agent result example of DESIGN.md 3.4, verbatim.
const DESIGN_RESULT = `task_id: AUTH-001
status: completed            # completed|failed|blocked|needs_decomposition
summary: one or two sentences
files_changed: [src/auth/token.js]
self_check:                  # one entry per acceptance criterion, in order (required when status is completed)
  - met: true
    evidence: test "rejects invalid refresh token" passes
commands_run:
  - {command: "npm test", exit_code: 0}
commit: null                 # commit sha when working in a git worktree
branch: null
issues: []                   # anything the orchestrator must know, including denied tools
proposed_subtasks: []        # only with needs_decomposition
`;

// The review example of DESIGN.md 3.5 (findings omitted because the verdict is approve).
const DESIGN_REVIEW = `task_id: AUTH-001
reviewer: opus-reviewer      # or "orchestrator"
verdict: approve             # approve|request_changes|reject
criteria:                    # exactly one entry per acceptance criterion, in order
  - {met: true, evidence: "tests/auth/refresh.test.js:14 covers the expired-token path; ran it, exit 0"}
checks: {}                   # optional extra answers
`;

// The correction example of DESIGN.md 3.6 with the "..." placeholders filled in.
const DESIGN_CORRECTION = `task_id: AUTH-001
failure: exact failure
evidence: command output, file:line
expected_behavior: expired refresh tokens are rejected with 401
required_change: the one change needed
scope: [src/auth/token.js]   # subset of authorized_files
verification: [npm test -- tests/auth]
`;

function task(extra = {}) {
  return {
    task_id: 'AUTH-001',
    title: 'Implement refresh-token handling',
    authorized_files: ['src/auth/', 'tests/auth/'],
    acceptance_criteria: ['expired refresh tokens are rejected'],
    ...extra,
  };
}

const TWO = task({ acceptance_criteria: ['expired refresh tokens are rejected', 'valid tokens are rotated'] });

function result(extra = {}) {
  return { ...yaml.parse(DESIGN_RESULT), ...extra };
}

function review(extra = {}) {
  return { ...yaml.parse(DESIGN_REVIEW), ...extra };
}

function correction(extra = {}) {
  return { ...yaml.parse(DESIGN_CORRECTION), ...extra };
}

function assertInvalid(r, re) {
  assert.equal(r.ok, false, `expected an error matching ${re}`);
  assert.ok(r.errors.some((e) => re.test(e)), `no error matches ${re}: ${JSON.stringify(r.errors)}`);
}

// ---------------------------------------------------------------------------
// validateAgentResult
// ---------------------------------------------------------------------------

test('validateAgentResult accepts the DESIGN.md 3.4 example', () => {
  const r = reports.validateAgentResult(yaml.parse(DESIGN_RESULT), task());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.result.task_id, 'AUTH-001');
  assert.equal(r.result.status, 'completed');
  assert.deepEqual(r.result.files_changed, ['src/auth/token.js']);
  assert.deepEqual(r.result.self_check, [{ met: true, evidence: 'test "rejects invalid refresh token" passes' }]);
  assert.deepEqual(r.result.commands_run, [{ command: 'npm test', exit_code: 0 }]);
  assert.equal(r.result.commit, null);
  assert.equal(r.result.branch, null);
});

test('validateAgentResult accepts the example extracted from a free-text message', () => {
  const message = 'Done. Details below.\n\n```yaml\n' + DESIGN_RESULT + '```\n';
  const r = reports.validateAgentResult(yaml.parse(yaml.extractYamlBlock(message)), task());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('validateAgentResult rejects a non-object', () => {
  for (const v of [null, undefined, 'task_id: AUTH-001', 42, ['a']]) {
    const r = reports.validateAgentResult(v, task());
    assertInvalid(r, /must be a mapping/);
    assert.equal(r.result, null);
  }
});

test('validateAgentResult rejects a wrong or missing task_id', () => {
  assertInvalid(reports.validateAgentResult(result({ task_id: 'AUTH-002' }), task()), /task_id "AUTH-002" does not match the task "AUTH-001"/);
  const r = result();
  delete r.task_id;
  assertInvalid(reports.validateAgentResult(r, task()), /task_id is required/);
});

test('validateAgentResult rejects an unknown status', () => {
  assertInvalid(reports.validateAgentResult(result({ status: 'done' }), task()), /status must be one of completed\|failed\|blocked\|needs_decomposition/);
});

test('validateAgentResult rejects a missing or empty summary', () => {
  const r = result();
  delete r.summary;
  assertInvalid(reports.validateAgentResult(r, task()), /summary must be a non-empty string/);
  assertInvalid(reports.validateAgentResult(result({ summary: '   ' }), task()), /summary must be a non-empty string/);
});

test('validateAgentResult rejects files_changed that is not a list of strings', () => {
  assertInvalid(reports.validateAgentResult(result({ files_changed: 'src/a.js' }), task()), /files_changed must be a list of strings/);
  assertInvalid(reports.validateAgentResult(result({ files_changed: ['src/a.js', 3] }), task()), /files_changed\[1\] must be a non-empty string/);
});

test('validateAgentResult requires exactly one self_check entry per criterion when completed', () => {
  // too few
  assertInvalid(reports.validateAgentResult(result(), TWO), /self_check has 1 entries but the task has 2 acceptance criteria/);
  // too many
  const extra = result({ self_check: [{ met: true, evidence: 'a' }, { met: true, evidence: 'b' }] });
  assertInvalid(reports.validateAgentResult(extra, task()), /self_check has 2 entries but the task has 1/);
  // missing
  const missing = result();
  delete missing.self_check;
  assertInvalid(reports.validateAgentResult(missing, task()), /self_check must be a list with one entry per acceptance criterion/);
  // exactly right with two criteria
  const ok = result({ self_check: [{ met: true, evidence: 'a' }, { met: false, evidence: 'b not done' }] });
  assert.equal(reports.validateAgentResult(ok, TWO).ok, true);
});

test('validateAgentResult rejects a self_check entry without evidence or with a non-boolean met', () => {
  assertInvalid(reports.validateAgentResult(result({ self_check: [{ met: true }] }), task()), /self_check\[0\]\.evidence must be a non-empty string/);
  assertInvalid(reports.validateAgentResult(result({ self_check: [{ met: true, evidence: '' }] }), task()), /self_check\[0\]\.evidence must be a non-empty string/);
  assertInvalid(reports.validateAgentResult(result({ self_check: [{ met: 'yes', evidence: 'x' }] }), task()), /self_check\[0\]\.met must be true or false/);
  assertInvalid(reports.validateAgentResult(result({ self_check: ['passed'] }), task()), /self_check\[0\] must be a mapping/);
});

test('validateAgentResult does not require self_check for failed and blocked results', () => {
  for (const status of ['failed', 'blocked']) {
    const r = result({ status });
    delete r.self_check;
    const v = reports.validateAgentResult(r, TWO);
    assert.equal(v.ok, true, `${status}: ${JSON.stringify(v.errors)}`);
    assert.equal(v.result.self_check, null);
  }
});

test('validateAgentResult requires proposed_subtasks for needs_decomposition', () => {
  const r = result({ status: 'needs_decomposition' });
  delete r.self_check;
  assertInvalid(reports.validateAgentResult(r, task()), /needs_decomposition requires a non-empty proposed_subtasks/);
  delete r.proposed_subtasks;
  assertInvalid(reports.validateAgentResult(r, task()), /needs_decomposition requires a non-empty proposed_subtasks/);
  r.proposed_subtasks = [{ task_id: 'AUTH-002', title: 'split part', objective: 'x' }];
  assert.equal(reports.validateAgentResult(r, task()).ok, true);
});

test('validateAgentResult rejects malformed commands_run, commit and issues', () => {
  assertInvalid(reports.validateAgentResult(result({ commands_run: 'npm test' }), task()), /commands_run must be a list/);
  assertInvalid(reports.validateAgentResult(result({ commands_run: [{ exit_code: 0 }] }), task()), /commands_run\[0\] must be a mapping with a non-empty command/);
  assertInvalid(reports.validateAgentResult(result({ commands_run: [{ command: 'x', exit_code: 'zero' }] }), task()), /commands_run\[0\]\.exit_code must be an integer/);
  assertInvalid(reports.validateAgentResult(result({ commit: 123 }), task()), /commit must be a string or null/);
  assertInvalid(reports.validateAgentResult(result({ issues: 'none' }), task()), /issues must be a list/);
});

test('validateAgentResult reports several errors at once', () => {
  const r = reports.validateAgentResult({ task_id: 'X-001', status: 'odd' }, task());
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 3, JSON.stringify(r.errors));
});

test('validateAgentResult redacts secrets in every string field of the returned result', () => {
  const secrets = ['sk-ant-AbCdEfGhIjKlMnOpQrStUv123456', 'hunter2hunter2', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'tok3nV4lue99'];
  const r = reports.validateAgentResult(
    result({
      summary: `rotated keys; used ${secrets[0]} for the smoke test`,
      self_check: [{ met: true, evidence: `ran with DB_PASSWORD=${secrets[1]}` }],
      commands_run: [{ command: `GITHUB_TOKEN=${secrets[2]} npm test`, exit_code: 0 }],
      issues: [`curl -H "Authorization: Bearer ${secrets[3]}" was needed`, { note: `nested ${secrets[0]}` }],
      branch: `feature/${secrets[2]}`,
      extra_field: { deep: [`API_KEY=${secrets[1]}`] },
    }),
    task()
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const text = JSON.stringify(r.result);
  for (const s of secrets) assert.ok(!text.includes(s), `secret ${s} leaked: ${text}`);
  assert.match(r.result.summary, /\[REDACTED\]/);
  assert.match(r.result.self_check[0].evidence, /DB_PASSWORD=\[REDACTED\]/);
  assert.match(r.result.commands_run[0].command, /GITHUB_TOKEN=\[REDACTED\] npm test/);
  assert.match(r.result.issues[0], /Bearer \[REDACTED\]/);
  assert.match(r.result.issues[1].note, /\[REDACTED\]/);
  assert.match(r.result.extra_field.deep[0], /API_KEY=\[REDACTED\]/);
});

test('validateAgentResult does not mutate its input', () => {
  const input = result({ summary: 'used API_KEY=abc123secretvalue' });
  const copy = structuredClone(input);
  reports.validateAgentResult(input, task());
  assert.deepEqual(input, copy);
});

test('validateAgentResult error messages do not echo secrets', () => {
  const r = reports.validateAgentResult(result({ task_id: 'sk-ant-AbCdEfGhIjKlMnOpQrStUv123456' }), task());
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r.errors).includes('sk-ant-AbCdEfGhIjKlMnOpQrStUv123456'));
});

// ---------------------------------------------------------------------------
// validateReview
// ---------------------------------------------------------------------------

test('validateReview accepts the DESIGN.md 3.5 example (approve)', () => {
  const r = reports.validateReview(yaml.parse(DESIGN_REVIEW), task());
  assert.deepEqual(r.errors, []);
  assert.equal(r.review.verdict, 'approve');
  assert.deepEqual(r.review.findings, []);
});

test('validateReview accepts request_changes with findings', () => {
  const r = reports.validateReview(
    review({
      verdict: 'request_changes',
      criteria: [{ met: true, evidence: 'ok' }, { met: false, evidence: 'no test for rotation' }],
      findings: [{ severity: 'major', file: 'src/auth/token.js', description: 'rotation missing' }],
    }),
    TWO
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('validateReview rejects an approve verdict with any unmet criterion', () => {
  const r = review({ criteria: [{ met: true, evidence: 'a' }, { met: false, evidence: 'b missing' }] });
  assertInvalid(reports.validateReview(r, TWO), /verdict approve requires every criterion met; unmet: 2/);
});

test('validateReview rejects a criteria list of the wrong length', () => {
  assertInvalid(reports.validateReview(review(), TWO), /criteria has 1 entries but the task has 2 acceptance criteria/);
  assertInvalid(reports.validateReview(review({ criteria: [] }), task()), /criteria has 0 entries but the task has 1/);
  assertInvalid(reports.validateReview(review({ criteria: null }), task()), /criteria must be a list/);
});

test('validateReview rejects an entry with empty evidence or a non-boolean met', () => {
  assertInvalid(reports.validateReview(review({ criteria: [{ met: true, evidence: '' }] }), task()), /criteria\[0\]\.evidence must be a non-empty string/);
  assertInvalid(reports.validateReview(review({ criteria: [{ met: true, evidence: '   ' }] }), task()), /criteria\[0\]\.evidence must be a non-empty string/);
  assertInvalid(reports.validateReview(review({ criteria: [{ met: true }] }), task()), /criteria\[0\]\.evidence must be a non-empty string/);
  assertInvalid(reports.validateReview(review({ criteria: [{ met: 'true', evidence: 'x' }] }), task()), /criteria\[0\]\.met must be true or false/);
});

test('validateReview rejects request_changes or reject without findings', () => {
  for (const verdict of ['request_changes', 'reject']) {
    assertInvalid(reports.validateReview(review({ verdict }), task()), new RegExp(`verdict ${verdict} requires a non-empty findings list`));
    assertInvalid(reports.validateReview(review({ verdict, findings: [] }), task()), new RegExp(`verdict ${verdict} requires a non-empty findings list`));
  }
});

test('validateReview rejects findings with a bad severity or no description', () => {
  const base = { verdict: 'reject' };
  assertInvalid(reports.validateReview(review({ ...base, findings: [{ severity: 'critical', description: 'x' }] }), task()), /findings\[0\]\.severity must be one of blocker\|major\|minor\|note/);
  assertInvalid(reports.validateReview(review({ ...base, findings: [{ severity: 'major' }] }), task()), /findings\[0\]\.description must be a non-empty string/);
  assertInvalid(reports.validateReview(review({ ...base, findings: ['bad'] }), task()), /findings\[0\] must be a mapping/);
});

test('validateReview rejects a wrong task_id, missing reviewer and unknown verdict', () => {
  assertInvalid(reports.validateReview(review({ task_id: 'AUTH-009' }), task()), /does not match the task/);
  assertInvalid(reports.validateReview(review({ reviewer: '' }), task()), /reviewer must be a non-empty string/);
  assertInvalid(reports.validateReview(review({ verdict: 'lgtm' }), task()), /verdict must be one of approve\|request_changes\|reject/);
  assertInvalid(reports.validateReview('verdict: approve', task()), /must be a mapping/);
});

test('validateReview redacts secrets in the returned review', () => {
  const r = reports.validateReview(review({ criteria: [{ met: true, evidence: 'ran with API_TOKEN=zzTopSecret123' }] }), task());
  assert.equal(r.ok, true);
  assert.ok(!JSON.stringify(r.review).includes('zzTopSecret123'));
});

// ---------------------------------------------------------------------------
// validateCorrection
// ---------------------------------------------------------------------------

test('validateCorrection accepts the DESIGN.md 3.6 example in round 1', () => {
  const r = reports.validateCorrection(yaml.parse(DESIGN_CORRECTION), task(), { round: 1 });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.correction.scope, ['src/auth/token.js']);
  assert.deepEqual(r.correction.verification, ['npm test -- tests/auth']);
  assert.equal(r.correction.round, 1);
});

test('validateCorrection requires failure, evidence, expected_behavior and required_change', () => {
  for (const key of ['failure', 'evidence', 'expected_behavior', 'required_change']) {
    const c = correction();
    delete c[key];
    assertInvalid(reports.validateCorrection(c, task(), { round: 1 }), new RegExp(`^${key} must be a non-empty string`));
    assertInvalid(reports.validateCorrection(correction({ [key]: ' ' }), task(), { round: 1 }), new RegExp(`^${key} must be a non-empty string`));
  }
});

test('validateCorrection requires a non-empty verification list', () => {
  const c = correction();
  delete c.verification;
  assertInvalid(reports.validateCorrection(c, task(), { round: 1 }), /verification must be a non-empty list/);
  assertInvalid(reports.validateCorrection(correction({ verification: [] }), task(), { round: 1 }), /verification must be a non-empty list/);
  assertInvalid(reports.validateCorrection(correction({ verification: 'npm test' }), task(), { round: 1 }), /verification must be a non-empty list/);
  assertInvalid(reports.validateCorrection(correction({ verification: [''] }), task(), { round: 1 }), /verification\[0\] must be a non-empty string/);
});

test('validateCorrection rejects a scope outside the task authorized files', () => {
  assertInvalid(reports.validateCorrection(correction({ scope: ['src/billing/pay.js'] }), task(), { round: 1 }), /scope lies outside the task's authorized_files: src\/billing\/pay\.js/);
  assertInvalid(reports.validateCorrection(correction({ scope: ['src/auth/../../etc/passwd'] }), task(), { round: 1 }), /outside the task's authorized_files/);
  assertInvalid(reports.validateCorrection(correction({ scope: 'src/auth/token.js' }), task(), { round: 1 }), /scope must be a list/);
  // a subdirectory of an authorized directory is inside
  assert.equal(reports.validateCorrection(correction({ scope: ['src/auth/sub/', 'tests/auth/a.test.js'] }), task(), { round: 1 }).ok, true);
});

test('validateCorrection defaults scope to the authorized files', () => {
  const c = correction();
  delete c.scope;
  const r = reports.validateCorrection(c, task(), { round: 1 });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.correction.scope, ['src/auth/', 'tests/auth/']);
});

test('validateCorrection rejects an unsafe verification command', () => {
  assertInvalid(reports.validateCorrection(correction({ verification: ['npm test', 'git push origin main'] }), task(), { round: 1 }), /unsafe verification command "git push origin main"/);
  assertInvalid(reports.validateCorrection(correction({ verification: ['rm -rf /'] }), task(), { round: 1 }), /unsafe verification command/);
  assertInvalid(
    reports.validateCorrection(correction({ verification: ['make deploy'] }), task(), { round: 1, extraUnsafe: ['make\\s+deploy'] }),
    /unsafe verification command "make deploy": matches configured unsafe pattern/
  );
});

test('validateCorrection requires strategy_change from round 2 on', () => {
  assert.equal(reports.validateCorrection(correction(), task(), { round: 1 }).ok, true);
  assertInvalid(reports.validateCorrection(correction(), task(), { round: 2 }), /strategy_change is required from the second correction round on \(this is round 2\)/);
  assertInvalid(reports.validateCorrection(correction({ strategy_change: '' }), task(), { round: 3 }), /strategy_change is required/);
  const ok = reports.validateCorrection(correction({ strategy_change: 'write the failing test first, then fix' }), task(), { round: 2 });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.correction.strategy_change, 'write the failing test first, then fix');
});

test('validateCorrection rejects a non-object and a mismatched task_id', () => {
  assertInvalid(reports.validateCorrection(null, task(), { round: 1 }), /must be a mapping/);
  assertInvalid(reports.validateCorrection(correction({ task_id: 'OTHER-001' }), task(), { round: 1 }), /does not match the task/);
});

// ---------------------------------------------------------------------------
// verify_results.cjs CLI
// ---------------------------------------------------------------------------

const SPEC_YAML = `task_id: AUTH-001
title: Implement refresh-token handling
objective: Refresh tokens are rotated on use.
complexity: 3
authorized_files: [src/auth/, tests/auth/]
acceptance_criteria:
  - expired refresh tokens are rejected
`;

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oo-reports-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cli(args) {
  return cp.spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
}

test('verify_results.cjs exits 0 for a valid result file and a valid review file', () => {
  withTmp((dir) => {
    const spec = path.join(dir, 'spec.yaml');
    fs.writeFileSync(spec, SPEC_YAML);
    const res = path.join(dir, 'result.yaml');
    fs.writeFileSync(res, DESIGN_RESULT);
    let r = cli(['result', res, '--spec', spec]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /RESULT OK for AUTH-001/);

    // a free-text message with a fenced yaml block works as well
    const msg = path.join(dir, 'message.txt');
    fs.writeFileSync(msg, 'All done.\n\n```yaml\n' + DESIGN_RESULT + '```\n');
    r = cli(['result', msg, '--spec', spec]);
    assert.equal(r.status, 0, r.stdout + r.stderr);

    const rev = path.join(dir, 'review.yaml');
    fs.writeFileSync(rev, DESIGN_REVIEW);
    r = cli(['review', rev, '--spec', spec]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /REVIEW OK for AUTH-001/);
  });
});

test('verify_results.cjs exits 1 and prints the errors for an invalid result or review file', () => {
  withTmp((dir) => {
    const spec = path.join(dir, 'spec.yaml');
    fs.writeFileSync(spec, SPEC_YAML);
    const res = path.join(dir, 'result.yaml');
    fs.writeFileSync(res, DESIGN_RESULT.replace('status: completed', 'status: finished').replace(/self_check:[\s\S]*?commands_run:/, 'commands_run:'));
    let r = cli(['result', res, '--spec', spec]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /ERROR: status must be one of/);
    assert.match(r.stdout, /RESULT INVALID/);

    const rev = path.join(dir, 'review.yaml');
    fs.writeFileSync(rev, DESIGN_REVIEW.replace('verdict: approve', 'verdict: reject'));
    r = cli(['review', rev, '--spec', spec]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /ERROR: verdict reject requires a non-empty findings list/);

    // unparseable YAML is reported, not thrown
    const bad = path.join(dir, 'bad.yaml');
    fs.writeFileSync(bad, 'task_id: [unclosed\n');
    r = cli(['review', bad, '--spec', spec]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /ERROR:/);
  });
});

test('verify_results.cjs picks the matching spec from a multi-document file and exits 2 on usage errors', () => {
  withTmp((dir) => {
    const spec = path.join(dir, 'specs.yaml');
    fs.writeFileSync(spec, SPEC_YAML.replace('AUTH-001', 'AUTH-000') + '---\n' + SPEC_YAML);
    const res = path.join(dir, 'result.yaml');
    fs.writeFileSync(res, DESIGN_RESULT);
    assert.equal(cli(['result', res, '--spec', spec]).status, 0);
    assert.equal(cli(['result', res]).status, 2);
    assert.equal(cli(['bogus', res, '--spec', spec]).status, 2);
  });
});
