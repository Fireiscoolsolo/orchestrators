'use strict';
// Pure-logic tests: YAML subset, contract/report/review validation, scheduling, routing, argument parsing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('../miniyaml.cjs');
const V = require('../validate.cjs');
const S = require('../dependency_scheduler.cjs');
const R = require('../routing.cjs');
const fo = require('../fo.cjs');

const SKILL = path.resolve(__dirname, '..', '..');
const cfg = fo.loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'fo-unit-')));

const contract = (o) => Object.assign({
  task_id: 'T-001', title: 'A task', objective: 'Deliver the thing described by the criteria', priority: 'medium',
  dependencies: [], complexity_score: 3, risk_level: 'low', file_scope: ['src/'],
  acceptance_criteria: ['the unit tests exit with code 0'], verification: ['run the unit tests'], verification_commands: ['npm test'],
}, o);
const valid = (o) => {
  const r = V.validateContract(contract(o));
  assert.deepEqual(r.errors, []);
  return r.contract;
};

// ------------------------------------------------------------------ yaml

test('yaml: parses the contract example from the specification', () => {
  const doc = yaml.parse([
    'task_id: AUTH-001', 'title: Implement token refresh handling', 'objective: Ensure expired access tokens are refreshed correctly',
    'priority: high', '', 'dependencies:', '  - AUTH-000', '', 'complexity_score: 7', 'risk_level: medium', '',
    'assigned_role: implementation-worker', 'preferred_model: opus', '', 'file_scope:', '  - src/auth/', '  - tests/auth/', '',
    'acceptance_criteria:', '  - Expired access tokens trigger refresh handling', '  - Invalid refresh tokens are rejected', '',
    'verification:', '  - Run authentication unit tests', '', 'status: pending', 'review_round: 0',
  ].join('\n'));
  assert.equal(doc.task_id, 'AUTH-001');
  assert.equal(doc.complexity_score, 7);
  assert.deepEqual(doc.dependencies, ['AUTH-000']);
  assert.deepEqual(doc.file_scope, ['src/auth/', 'tests/auth/']);
  assert.equal(doc.review_round, 0);
});

test('yaml: nested mappings, sequences of mappings, flow collections, scalars', () => {
  const doc = yaml.parse([
    '# a comment', 'verification:', '  tests_run: true', '  tests_passed: false', '  build_passed: null   # trailing comment',
    '  commands:', '    - cmd: npm test -- tests/auth', '      exit_code: 0', '    - cmd: "node -e \\"1\\""', '      exit_code: 1',
    'known_issues: []', 'meta: {a: 1, b: two}', 'tags: [x, "y z", 3]', "quoted: 'it''s fine'", 'path: C:\\Users\\dev\\repo',
    'commit: 0012345', 'ratio: 0.5', 'text: |', '  line one', '  line two', 'folded: >', '  joined', '  words',
    'seq_same_indent:', '- one', '- two', 'after: done',
  ].join('\n'));
  assert.equal(doc.verification.tests_run, true);
  assert.equal(doc.verification.tests_passed, false);
  assert.equal(doc.verification.build_passed, null);
  assert.deepEqual(doc.verification.commands, [{ cmd: 'npm test -- tests/auth', exit_code: 0 }, { cmd: 'node -e "1"', exit_code: 1 }]);
  assert.deepEqual(doc.known_issues, []);
  assert.deepEqual(doc.meta, { a: 1, b: 'two' });
  assert.deepEqual(doc.tags, ['x', 'y z', 3]);
  assert.equal(doc.quoted, "it's fine");
  assert.equal(doc.path, 'C:\\Users\\dev\\repo');
  assert.equal(doc.commit, '0012345', 'leading zeros survive');
  assert.equal(doc.ratio, 0.5);
  assert.equal(doc.text, 'line one\nline two');
  assert.equal(doc.folded, 'joined words');
  assert.deepEqual(doc.seq_same_indent, ['one', 'two']);
  assert.equal(doc.after, 'done');
});

test('yaml: malformed input raises YamlError with a line number', () => {
  assert.throws(() => yaml.parse('a: 1\n\tb: 2'), (e) => e instanceof yaml.YamlError && e.line === 2);
  assert.throws(() => yaml.parse('a: 1\na: 2'), /duplicate key/);
  assert.throws(() => yaml.parse('a:\n  b: 1\n c: 2'), yaml.YamlError);
  assert.throws(() => yaml.parse('a: [1, 2'), /flow sequence/);
  assert.throws(() => yaml.parse('__proto__: 1'), /not allowed/);
});

test('yaml: dump and parse round-trip', () => {
  const obj = {
    task_id: 'X-1', summary: 'has: colon and # hash', list: ['a', { cmd: 'npm test', exit_code: 0 }], empty: [], none: null,
    nested: { ok: true, n: 3, s: '007', multi: 'two\nlines' },
  };
  assert.deepEqual(yaml.parse(yaml.dump(obj)), obj);
});

test('yaml: extractYamlBlock takes the last fenced yaml block of a worker message', () => {
  const msg = 'Done.\n```yaml\ntask_id: OLD-1\n```\nmore text\n```yaml\ntask_id: NEW-1\nstatus: implemented\n```\n';
  assert.equal(yaml.parse(yaml.extractYamlBlock(msg)).task_id, 'NEW-1');
  assert.equal(yaml.extractYamlBlock('task_id: RAW-1'), 'task_id: RAW-1');
});

// ------------------------------------------------------------- contracts

test('contract: the shipped template validates and derives its score from the factors', () => {
  const res = V.validateContract(yaml.parse(fs.readFileSync(path.join(SKILL, 'templates', 'task-contract.yaml'), 'utf8')));
  assert.deepEqual(res.errors, []);
  assert.equal(res.contract.complexity_score, 5);
  assert.equal(res.contract.security_sensitive, true);
});

test('contract: the quality gate rejects incomplete or unsafe specifications', () => {
  const errs = (o) => V.validateContract(contract(o)).errors.join(' | ');
  assert.match(errs({ task_id: 'bad id' }), /task_id/);
  assert.match(errs({ acceptance_criteria: [] }), /acceptance_criteria/);
  assert.match(errs({ verification: [] }), /verification/);
  assert.match(errs({ file_scope: [] }), /file_scope/);
  assert.match(errs({ file_scope: ['../other'] }), /must not contain/);
  assert.match(errs({ file_scope: ['C:/abs/path'] }), /relative/);
  assert.match(errs({ complexity_score: 11 }), /complexity_score/);
  assert.match(errs({ complexity_score: undefined }), /complexity_score/);
  assert.match(errs({ risk_level: 'extreme' }), /risk_level/);
  assert.match(errs({ assigned_role: 'wizard' }), /assigned_role/);
  assert.match(errs({ verification_commands: ['git push origin main'] }), /refused/);
  assert.match(errs({ verification_commands: ['rm -rf build'] }), /refused/);
  assert.match(errs({ objective: '' }), /objective/);
});

test('contract: warnings for vague criteria and unknown fields; "Label: detail" items stay text', () => {
  const res = V.validateContract(contract({ acceptance_criteria: ['everything works correctly'], extra_field: 1, verification: [{ 'Check failure paths': 'invalid tokens rejected' }] }));
  assert.deepEqual(res.errors, []);
  assert.ok(res.warnings.some((w) => /vague/.test(w)));
  assert.ok(res.warnings.some((w) => /unknown field/.test(w)));
  assert.deepEqual(res.contract.verification, ['Check failure paths: invalid tokens rejected']);
});

test('contract: read-only roles need no file scope', () => {
  const res = V.validateContract(contract({ assigned_role: 'research-worker', file_scope: undefined, verification_commands: [] }));
  assert.deepEqual(res.errors, []);
});

// --------------------------------------------------------------- reports

const taskOf = (o, role) => {
  const c = valid(o);
  const route = R.route(c, cfg, 'balanced', null);
  if (role) route.role = role;
  return { id: c.task_id, contract: c, route };
};

test('report: accepts a truthful report and rejects inconsistent ones', () => {
  const t = taskOf({});
  const base = { task_id: 'T-001', status: 'implemented', summary: 'done', files_changed: ['src/a.js'], verification: { tests_run: true, tests_passed: true, build_passed: null }, known_issues: [], commit: 1234567 };
  const ok = V.validateReport(base, t, { git: true });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.report.commit, '1234567', 'an all-digit sha stays usable');
  const errs = (o, opts) => V.validateReport(Object.assign({}, base, o), t, opts || { git: true }).errors.join(' | ');
  assert.match(errs({ task_id: 'T-002' }), /does not match/);
  assert.match(errs({ status: 'done' }), /status/);
  assert.match(errs({ summary: '' }), /summary/);
  assert.match(errs({ verification: { tests_run: false, tests_passed: true } }), /tests_passed true requires tests_run true/);
  assert.match(errs({ verification: undefined }), /verification/);
  assert.match(errs({ commit: undefined }), /commit/);
  assert.match(errs({ commit: 'not-a-sha' }), /SHA/);
  assert.match(errs({ status: 'blocked' }), /reason/);
  assert.equal(errs({ commit: undefined }, { git: false }), '');
});

test('report: research roles must return findings', () => {
  const t = taskOf({ assigned_role: 'research-worker', file_scope: undefined, verification_commands: [] });
  const rep = { task_id: 'T-001', status: 'implemented', summary: 'looked', verification: { tests_run: false, tests_passed: null, build_passed: null } };
  assert.match(V.validateReport(rep, t, {}).errors.join(' '), /findings/);
  assert.deepEqual(V.validateReport(Object.assign({ findings: ['src/a.js:3 does X'] }, rep), t, {}).errors, []);
});

test('review: approval needs every criterion met with evidence', () => {
  const t = taskOf({ acceptance_criteria: ['first criterion holds', 'second criterion holds'] });
  const rv = (o) => V.validateReview(Object.assign({ task_id: 'T-001', reviewer: 'orchestrator', verdict: 'approve', criteria: [{ met: true, evidence: 'log 1' }, { met: true, evidence: 'log 2' }], findings: [] }, o), t);
  assert.deepEqual(rv({}).errors, []);
  assert.match(rv({ criteria: [{ met: true, evidence: 'x' }] }).errors.join(' '), /2 entries required/);
  assert.match(rv({ criteria: [{ met: true, evidence: 'x' }, { met: false, evidence: 'y' }] }).errors.join(' '), /unmet/);
  assert.match(rv({ criteria: [{ met: true, evidence: 'x' }, { met: true, evidence: '' }] }).errors.join(' '), /no evidence/);
  assert.match(rv({ checks: { no_regressions: false } }).errors.join(' '), /review check is false/);
  assert.match(rv({ reviewer: 'someone' }).errors.join(' '), /reviewer/);
  assert.match(rv({ verdict: 'reject' }).errors.join(' '), /reject requires/);
  assert.deepEqual(rv({ verdict: 'reject', findings: ['off-by-one in loop'] }).errors, []);
});

test('review: oversight-tier approval needs all ten checks answered', () => {
  const t = taskOf({ complexity_score: 9 });
  assert.equal(t.route.oversight, true);
  const base = { task_id: 'T-001', reviewer: 'orchestrator', verdict: 'approve', criteria: [{ met: true, evidence: 'log' }], findings: [] };
  assert.match(V.validateReview(base, t).errors.join(' '), /every review check/);
  const checks = Object.fromEntries(V.REVIEW_CHECKS.map((k) => [k, true]));
  assert.deepEqual(V.validateReview(Object.assign({ checks }, base), t).errors, []);
});

test('correction: must be specific, in scope, and change strategy from round 2', () => {
  const t = taskOf({ file_scope: ['src/auth/'] });
  const base = { task_id: 'T-001', failure: 'revoked token accepted', evidence: 'log line 12', expected_behavior: '401', required_change: 'check the revocation list', verification: ['npm test'] };
  assert.deepEqual(V.validateCorrection(base, t, 1).errors, []);
  assert.match(V.validateCorrection(Object.assign({}, base, { required_change: '' }), t, 1).errors.join(' '), /required_change/);
  assert.match(V.validateCorrection(Object.assign({}, base, { scope: ['src/other/x.js'] }), t, 1).errors.join(' '), /outside the task file_scope/);
  assert.deepEqual(V.validateCorrection(Object.assign({}, base, { scope: ['src/auth/token.js'] }), t, 1).errors, []);
  assert.match(V.validateCorrection(Object.assign({}, base, { scope_expansion: ['src/other/'] }), t, 1).errors.join(' '), /scope_expansion_reason/);
  assert.match(V.validateCorrection(base, t, 2).errors.join(' '), /must change something/);
  assert.deepEqual(V.validateCorrection(Object.assign({}, base, { strategy_change: { kind: 'model', detail: 'two misses on sonnet' } }), t, 2).errors, []);
});

// ------------------------------------------------------------- scheduler

test('scheduler: detects unknown dependencies, self dependencies and cycles', () => {
  assert.match(S.validateGraph([{ id: 'A-1', deps: ['Z-9'] }]).errors.join(' '), /unknown dependency Z-9/);
  assert.match(S.validateGraph([{ id: 'A-1', deps: ['A-1'] }]).errors.join(' '), /depends on itself/);
  const cyc = S.validateGraph([{ id: 'A-1', deps: ['C-1'] }, { id: 'B-1', deps: ['A-1'] }, { id: 'C-1', deps: ['B-1'] }]);
  assert.match(cyc.errors.join(' '), /dependency cycle/);
  assert.equal(cyc.cycle[0], cyc.cycle[cyc.cycle.length - 1]);
  assert.deepEqual(S.validateGraph([{ id: 'A-1', deps: [] }, { id: 'B-1', deps: ['A-1'] }]).errors, []);
});

test('scheduler: topological levels', () => {
  const lv = S.levels([{ id: 'D-1', deps: ['B-1', 'C-1'] }, { id: 'A-1', deps: [] }, { id: 'B-1', deps: ['A-1'] }, { id: 'C-1', deps: [] }]);
  assert.deepEqual(lv, [['A-1', 'C-1'], ['B-1'], ['D-1']]);
});

test('scheduler: file scope matching and conflict detection', () => {
  assert.ok(S.matchPath('src/auth/', 'src/auth/token.ts'));
  assert.ok(S.matchPath('src/auth', 'src\\auth\\token.ts'));
  assert.ok(!S.matchPath('src/auth/', 'src/authz/x.ts'));
  assert.ok(S.matchPath('README.md', 'README.md'));
  assert.ok(S.matchPath('docs/*.md', 'docs/a.md'));
  assert.ok(!S.matchPath('docs/*.md', 'docs/api/a.md'));
  assert.ok(S.matchPath('src/**/*.test.js', 'src/a/b/x.test.js'));
  assert.ok(S.matchPath('.', 'anything/at/all'));
  const conflict = (a, b) => S.patternsConflict(a, b);
  assert.ok(conflict('src/auth/', 'src/auth/token.ts'));
  assert.ok(conflict('src/', 'src/auth/'));
  assert.ok(!conflict('src/auth/', 'src/dashboard/'));
  assert.ok(!conflict('src/a.js', 'src/a.js.map'));
  assert.ok(!conflict('*.md', 'src/'));
  assert.ok(conflict('*.md', 'README.md'));
  assert.ok(conflict('docs/*.md', 'docs/'));
  assert.ok(!conflict('docs/*.md', 'docs/api/'));
  assert.ok(conflict('src/**/*.js', 'src/auth/'));
  assert.ok(conflict('.', 'src/x.js'));
  assert.ok(S.scopesConflict(['a/', 'b/'], ['c/', 'b/x.js']));
  assert.ok(!S.scopesConflict(['a/'], []));
});

const view = (id, o) => Object.assign({ id, state: 'READY', deps: [], scope: [`pkg/${id}/`], priority: 'medium', exclusive: false, holdsScope: false, usesSlot: false }, o);

test('scheduler: concurrency follows readiness, not the worker limit', () => {
  assert.deepEqual(S.selectBatch([view('A-1')], { maxWorkers: 5 }).selected, ['A-1']);
  assert.equal(S.selectBatch(['A-1', 'B-1', 'C-1'].map((i) => view(i)), { maxWorkers: 5 }).selected.length, 3);
  const ten = Array.from({ length: 10 }, (_, i) => view(`T-${i}`));
  const res = S.selectBatch(ten, { maxWorkers: 5 });
  assert.equal(res.selected.length, 5);
  assert.equal(res.deferred.filter((d) => /no free worker slot/.test(d.reason)).length, 5);
});

test('scheduler: conflicting scopes are serialized and dependencies respected', () => {
  const tasks = [view('A-1', { scope: ['src/'] }), view('B-1', { scope: ['src/auth/'] }), view('C-1', { scope: ['docs/'] }), view('D-1', { deps: ['A-1'], scope: ['x/'] })];
  const res = S.selectBatch(tasks, { maxWorkers: 5 });
  assert.deepEqual(res.selected, ['A-1', 'C-1']);
  assert.match(res.deferred.find((d) => d.id === 'B-1').reason, /overlaps A-1/);
  assert.match(res.deferred.find((d) => d.id === 'D-1').reason, /dependencies not completed/);
});

test('scheduler: in-flight work holds slots and file scopes; exclusive tasks run alone; priority first', () => {
  const running = view('R-1', { state: 'RUNNING', usesSlot: true, holdsScope: true, scope: ['src/'] });
  const res = S.selectBatch([running, view('A-1', { scope: ['src/x.js'] }), view('B-1')], { maxWorkers: 2 });
  assert.deepEqual(res.selected, ['B-1']);
  const res2 = S.selectBatch([running, view('A-1'), view('B-1')], { maxWorkers: 2 });
  assert.equal(res2.selected.length, 1, 'one slot is taken by the running task');
  const res3 = S.selectBatch([view('A-1', { exclusive: true }), view('B-1')], { maxWorkers: 5 });
  assert.deepEqual(res3.selected, ['A-1']);
  const res4 = S.selectBatch([view('A-1'), view('B-1', { priority: 'critical' })], { maxWorkers: 1 });
  assert.deepEqual(res4.selected, ['B-1']);
  assert.deepEqual(S.selectBatch([view('A-1'), view('B-1')], { maxWorkers: 5, maxNew: 1 }).selected.length, 1);
});

// --------------------------------------------------------------- routing

test('routing: complexity bands map to tiers, roles and models', () => {
  const r = (o) => R.route(valid(o), cfg, 'balanced', null);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => r({ complexity_score: s }).tier),
    ['light', 'light', 'standard', 'standard', 'capable', 'capable', 'lead', 'lead', 'lead_oversight', 'lead_oversight']);
  assert.equal(r({ complexity_score: 2 }).model, 'haiku');
  assert.equal(r({ complexity_score: 4 }).model, 'sonnet');
  assert.equal(r({ complexity_score: 4 }).role, 'implementation-worker');
  assert.equal(r({ complexity_score: 7 }).role, 'opus-executor');
  assert.equal(r({ complexity_score: 7 }).model, 'opus');
  assert.equal(r({ complexity_score: 9 }).oversight, true);
  assert.equal(r({ complexity_score: 2 }).basis, 'heuristic');
});

test('routing: risk, security and role floors override the band; preferred_model is a floor', () => {
  const r = (o) => R.route(valid(o), cfg, 'balanced', null);
  assert.equal(r({ complexity_score: 2, risk_level: 'high' }).tier, 'standard');
  assert.equal(r({ complexity_score: 2, security_sensitive: true }).tier, 'capable');
  assert.equal(r({ complexity_score: 5, security_sensitive: true }).tier, 'lead');
  assert.equal(r({ complexity_score: 1, assigned_role: 'debug-worker' }).tier, 'standard');
  assert.equal(r({ complexity_score: 1, assigned_role: 'documentation-worker' }).model, 'haiku');
  assert.equal(r({ complexity_score: 2, preferred_model: 'opus' }).model, 'opus');
  const low = r({ complexity_score: 7, preferred_model: 'haiku' });
  assert.equal(low.model, 'opus');
  assert.ok(low.notes.some((n) => /below the required/.test(n)));
  assert.equal(r({ complexity_score: 3, assigned_role: 'orchestrator' }).model, 'inherit');
});

test('routing: review policy scales with mode and risk', () => {
  const ind = (o, mode) => R.route(valid(o), cfg, mode, null).review.independent;
  assert.equal(ind({ complexity_score: 3 }, 'fast'), 0);
  assert.equal(ind({ complexity_score: 3, risk_level: 'high' }, 'fast'), 1);
  assert.equal(ind({ complexity_score: 3 }, 'balanced'), 0);
  assert.equal(ind({ complexity_score: 7 }, 'balanced'), 1);
  assert.equal(ind({ complexity_score: 5 }, 'thorough'), 1);
  assert.equal(ind({ complexity_score: 2 }, 'maximum'), 1);
  assert.equal(ind({ complexity_score: 2, security_sensitive: true }, 'maximum'), 2);
  assert.equal(ind({ complexity_score: 2, assigned_role: 'orchestrator' }, 'fast'), 1, 'no self-approval');
  assert.equal(ind({ assigned_role: 'research-worker', file_scope: undefined, verification_commands: [] }, 'maximum'), 0);
});

test('routing: observed outcomes adjust routing only with enough samples', () => {
  const c = valid({ complexity_score: 3 });
  const few = { 'standard|standard': { tasks: 3, completed: 0, first_pass: 0, dispatches: 9, corrections: 6, escalations: 0, failed: 3 } };
  assert.equal(R.route(c, cfg, 'balanced', few).tier, 'standard');
  assert.equal(R.route(c, cfg, 'balanced', few).basis, 'heuristic');
  const many = { 'standard|standard': { tasks: 6, completed: 5, first_pass: 1, dispatches: 14, corrections: 8, escalations: 0, failed: 1 } };
  const bumped = R.route(c, cfg, 'balanced', many);
  assert.equal(bumped.tier, 'capable');
  assert.equal(bumped.basis, 'observed');
  const good = { 'standard|standard': { tasks: 6, completed: 6, first_pass: 6, dispatches: 6, corrections: 0, escalations: 0, failed: 0 } };
  assert.equal(R.route(c, cfg, 'balanced', good).tier, 'standard');
  assert.equal(R.route(c, cfg, 'balanced', good).basis, 'heuristic+observed');
});

test('routing: scoring, outcome recording and proposals', () => {
  assert.equal(R.scoreFromFactors({}), 1);
  assert.equal(R.scoreFromFactors(Object.fromEntries(R.FACTORS.map((f) => [f, 3]))), 10);
  assert.equal(R.nextTier('light'), 'standard');
  assert.equal(R.nextTier('lead_oversight'), null);
  let stats = {};
  for (let i = 0; i < 5; i++) stats = R.recordOutcome(stats, { tier: 'light', band: 'light', dispatches: 3, corrections: 2, escalations: 0, completed: true });
  assert.equal(stats['light|light'].tasks, 5);
  assert.equal(stats['light|light'].first_pass, 0);
  const props = R.proposals(stats, cfg);
  assert.equal(props.length, 1);
  assert.match(props[0].proposal, /standard tier/);
  assert.deepEqual(R.proposals({ 'light|light': { tasks: 2, first_pass: 0 } }, cfg), []);
});

// ------------------------------------------------------------- arguments

test('arguments: options are parsed from anywhere in the invocation text', () => {
  const p = fo.parseInvocation('--mode thorough --max-workers 3 --review-rounds 2 Fix the authentication system, add tests');
  assert.deepEqual([p.mode, p.max_workers, p.review_rounds, p.plan_only, p.errors], ['thorough', 3, 2, false, []]);
  assert.equal(p.request, 'Fix the authentication system, add tests');
  const q = fo.parseInvocation('Fix login\nand the dashboard --plan-only --mode=fast');
  assert.deepEqual([q.mode, q.plan_only], ['fast', true]);
  assert.equal(q.request, 'Fix login\nand the dashboard');
  const d = fo.parseInvocation('Fix the login system, improve the dashboard, and make sure everything works.');
  assert.deepEqual([d.mode, d.max_workers, d.review_rounds, d.resume, d.status], [null, null, null, false, false]);
  assert.equal(fo.parseInvocation('--resume').resume, true);
  assert.equal(fo.parseInvocation(' --status ').status, true);
  assert.equal(fo.parseInvocation('--status').request, '');
});

test('arguments: invalid values are errors, unknown options are warnings', () => {
  assert.match(fo.parseInvocation('--mode turbo do things').errors.join(' '), /--mode turbo/);
  assert.match(fo.parseInvocation('--max-workers 99 do things').errors.join(' '), /--max-workers 99/);
  assert.match(fo.parseInvocation('do things --max-workers').errors.join(' '), /needs a value/);
  const w = fo.parseInvocation('--turbo do things');
  assert.deepEqual(w.errors, []);
  assert.match(w.warnings.join(' '), /--turbo/);
  assert.equal(w.request, '--turbo do things');
  const prose = fo.parseInvocation('Run it with node --test and the --watch flag');
  assert.deepEqual([prose.errors, prose.warnings], [[], []], 'option-looking words inside a sentence are prose');
});

test('configuration: defaults match the specification', () => {
  assert.deepEqual(cfg.execution, { mode: 'balanced', max_workers: 5, max_review_rounds: 3, max_task_retries: 2 });
  assert.equal(cfg.budget.enabled, true);
  assert.equal(cfg.budget.token_limit, null);
  assert.equal(cfg.budget.cost_limit_usd, null);
  assert.equal(cfg.budget.warn_at_percent, 80);
  assert.deepEqual([cfg.routing.adaptive, cfg.routing.prefer_lower_cost_models, cfg.routing.allow_escalation], [true, true, true]);
  assert.deepEqual(fo.deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });
});
