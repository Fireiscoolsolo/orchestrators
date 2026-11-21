'use strict';
// Tests for improve.cjs. Every test works on a temporary copy of a minimal skill directory
// (config/, VERSION, CHANGELOG.md) and a temporary state directory; the real skill is only read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('../scripts/lib/store.cjs');
const yaml = require('../scripts/lib/yaml.cjs');
const config = require('../scripts/lib/config.cjs');
const imp = require('../scripts/lib/improve.cjs');

const REAL_SKILL = path.resolve(__dirname, '..');
const NOW = '2026-11-15T10:00:00.000Z';
const RUN = '20261115-100000-abcd';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function hashTree(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out[path.relative(dir, f)] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

// Guard: record every fs call in this process that would create, modify or remove something
// inside the real skill directory. (Comparing file hashes instead would be racy, because other
// workers may edit the shared skill directory while these tests run.)
const REAL_WRITES = [];
const HISTORY_EXISTED = fs.existsSync(path.join(REAL_SKILL, 'history'));
function insideRealSkill(p) {
  if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return false;
  const rel = path.relative(REAL_SKILL, path.resolve(String(p instanceof URL ? p.pathname : p)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function guard(name, argIndexes, isWrite) {
  const orig = fs[name];
  fs[name] = function guarded(...args) {
    if (!isWrite || isWrite(args)) {
      for (const i of argIndexes) if (insideRealSkill(args[i])) REAL_WRITES.push(`${name} ${args[i]}`);
    }
    return orig.apply(this, args);
  };
}
guard('writeFileSync', [0]);
guard('appendFileSync', [0]);
guard('copyFileSync', [1]);
guard('renameSync', [0, 1]);
guard('mkdirSync', [0]);
guard('unlinkSync', [0]);
guard('rmSync', [0]);
guard('openSync', [0], (args) => typeof args[1] === 'string' && /[wa+]/.test(args[1]));

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oo-improve-'));
  const skillDir = path.join(root, 'skill');
  fs.mkdirSync(path.join(skillDir, 'config'), { recursive: true });
  for (const f of fs.readdirSync(path.join(REAL_SKILL, 'config'))) {
    if (f.endsWith('.yaml')) fs.copyFileSync(path.join(REAL_SKILL, 'config', f), path.join(skillDir, 'config', f));
  }
  fs.writeFileSync(path.join(skillDir, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(skillDir, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.0 - 2026-11-14\n\n- Initial release.\n');
  const paths = store.resolvePaths({ projectDir: path.join(root, 'project'), stateDir: path.join(root, 'state') });
  store.ensureState(paths);
  return { root, skillDir, paths, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function outcome(i, { model = 'haiku', complexity = 5, first_pass = false, attempts = 2, run_id = RUN } = {}) {
  return {
    ts: NOW, run_id, task_id: `T-${String(i).padStart(3, '0')}`, category: 'worker_outcome', text: 'x',
    data: { model, role: 'implementation-worker', complexity, attempts, review_round: first_pass ? 0 : 1, first_pass },
  };
}

// six haiku tasks at complexity 5-6, one first pass, 13 attempts in total (mean 2.17)
function lowFirstPass() {
  const obs = [outcome(1, { first_pass: true, attempts: 1 })];
  for (let i = 2; i <= 6; i++) obs.push(outcome(i, { attempts: i <= 3 ? 3 : 2, complexity: i % 2 ? 5 : 6 }));
  return obs;
}

function validProposal(extra) {
  return Object.assign({
    id: 'IMP-20261115-001',
    created: NOW,
    category: 'routing_heuristics',
    title: 'Raise expected attempts for haiku at 5-6',
    rationale: 'haiku passed first time in 1 of 6 tasks at complexity 5-6.',
    evidence: ['run 20261115-100000-abcd: haiku first-pass 1 of 6 at complexity 5-6'],
    target_file: 'config/routing.yaml',
    change: { kind: 'config_set', key: 'routing.heuristic_expected_attempts.haiku.5-6', value: 2.2 },
    risk: 'low',
    status: 'proposed',
    approved_by: null,
    weakens_safety: false,
  }, extra || {});
}

function configSet(key, value, target) {
  return validProposal({ target_file: target || 'config/routing.yaml', change: { kind: 'config_set', key, value } });
}

function task(id, extra) {
  return Object.assign({
    task_id: id, title: id, status: 'PENDING', complexity: 5, risk: 'medium', dependencies: [],
    review_round: 0, attempts: 0, retries: 0, spec_revision: 1,
    routing: { role: 'implementation-worker', agent: 'opus-implementer', model: 'haiku' },
    history: [], evidence: { self_check: null, verification: null, reviews: [], integration: null },
    result: null, correction: null, corrections: [], failure: null, block: null,
  }, extra || {});
}

// ---------------------------------------------------------------------------
// 1. recordObservation / readObservations
// ---------------------------------------------------------------------------

test('recordObservation appends one JSON line with ts per call', () => {
  const s = setup();
  try {
    const rec = imp.recordObservation(s.paths, { run_id: RUN, task_id: 'A-001', category: 'routing', text: 'routed to haiku', data: { model: 'haiku' } }, NOW);
    assert.equal(rec.ts, NOW);
    let lines = fs.readFileSync(s.paths.observationsFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.deepEqual(parsed, { ts: NOW, run_id: RUN, task_id: 'A-001', category: 'routing', text: 'routed to haiku', data: { model: 'haiku' } });

    imp.recordObservation(s.paths, { category: 'user_correction', text: 'user fixed the spec' });
    lines = fs.readFileSync(s.paths.observationsFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.match(JSON.parse(lines[1]).ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

    // unparseable lines are skipped on read
    fs.appendFileSync(s.paths.observationsFile, '{not json\n');
    assert.equal(imp.readObservations(s.paths).length, 2);
  } finally {
    s.done();
  }
});

test('recordObservation rejects an unknown category and writes nothing', () => {
  const s = setup();
  try {
    assert.throws(
      () => imp.recordObservation(s.paths, { category: 'gossip', text: 'x' }, NOW),
      (e) => e instanceof imp.ImproveError && e.code === 'UNKNOWN_CATEGORY' && /gossip/.test(e.message)
    );
    assert.equal(fs.existsSync(s.paths.observationsFile), false);
    assert.equal(imp.readObservations(s.paths).length, 0);
    assert.equal(imp.CATEGORIES.length, 9);
  } finally {
    s.done();
  }
});

test('recordObservation redacts secrets in the text and data', () => {
  const s = setup();
  try {
    const key = 'sk-ant-' + 'a1B2c3D4e5F6g7H8i9J0kLmN';
    imp.recordObservation(s.paths, {
      category: 'debugging_pattern',
      text: `worker printed API_TOKEN=hunter2secret and ${key}`,
      data: { output: 'Authorization: Bearer abcdef1234567890' },
    }, NOW);
    const raw = fs.readFileSync(s.paths.observationsFile, 'utf8');
    assert.ok(!raw.includes('hunter2secret'));
    assert.ok(!raw.includes(key));
    assert.ok(!raw.includes('abcdef1234567890'));
    const [o] = imp.readObservations(s.paths);
    assert.match(o.text, /API_TOKEN=\[REDACTED\]/);
    assert.match(o.data.output, /\[REDACTED\]/);
  } finally {
    s.done();
  }
});

// ---------------------------------------------------------------------------
// 2. collectRunObservations
// ---------------------------------------------------------------------------

test('collectRunObservations derives worker outcomes, verification failures and retries', () => {
  const run = { run_id: RUN, updated_at: NOW };
  const tasks = [
    // dispatched once, approved without corrections: first pass
    task('A-001', { status: 'COMPLETED', attempts: 1, complexity: 3 }),
    // failed verification twice, corrected twice, completed
    task('B-001', {
      status: 'COMPLETED', attempts: 3, review_round: 2, complexity: 6,
      routing: { role: 'test-worker', agent: 'opus-tester', model: 'sonnet' },
      history: [
        { ts: NOW, from: 'VERIFYING', to: 'CORRECTION_REQUIRED', reason: 'npm test failed', actor: 'oo' },
        { ts: NOW, from: 'CORRECTION_REQUIRED', to: 'READY', reason: 'correction', actor: 'oo' },
        { ts: NOW, from: 'VERIFYING', to: 'CORRECTION_REQUIRED', reason: 'lint failed', actor: 'oo' },
        { ts: NOW, from: 'VERIFYING', to: 'REVIEWING', reason: 'passed', actor: 'oo' },
      ],
      evidence: { self_check: null, verification: { passed: true, commands: [] }, reviews: [], integration: null },
    }),
    // retried once after a crash, then failed verification (only recorded in evidence)
    task('C-001', {
      status: 'CORRECTION_REQUIRED', attempts: 2, retries: 1, complexity: 8,
      evidence: { self_check: null, reviews: [], integration: null,
        verification: { passed: false, run_at: NOW, commands: [{ command: 'npm test', exit_code: 1, duration_ms: 5, timed_out: false, refused: false, output_tail: 'x' }] } },
    }),
    // never dispatched: no observations
    task('D-001', { status: 'PENDING', attempts: 0 }),
  ];
  const obs = imp.collectRunObservations(run, tasks);
  const by = (cat) => obs.filter((o) => o.category === cat);

  const outcomes = by('worker_outcome');
  assert.deepEqual(outcomes.map((o) => o.task_id), ['A-001', 'B-001', 'C-001']);
  for (const o of outcomes) {
    for (const k of ['model', 'role', 'complexity', 'attempts', 'review_round', 'first_pass']) {
      assert.ok(Object.prototype.hasOwnProperty.call(o.data, k), `${o.task_id} data.${k}`);
    }
    assert.equal(o.run_id, RUN);
    assert.ok(imp.CATEGORIES.includes(o.category));
  }
  const pick = (d) => ({ model: d.model, role: d.role, complexity: d.complexity, attempts: d.attempts, review_round: d.review_round, first_pass: d.first_pass });
  assert.deepEqual(pick(outcomes[0].data), { model: 'haiku', role: 'implementation-worker', complexity: 3, attempts: 1, review_round: 0, first_pass: true });
  assert.deepEqual(pick(outcomes[2].data), { model: 'haiku', role: 'implementation-worker', complexity: 8, attempts: 2, review_round: 0, first_pass: false });
  assert.equal(outcomes[1].data.model, 'sonnet');
  assert.equal(outcomes[1].data.role, 'test-worker');
  assert.equal(outcomes[1].data.review_round, 2);
  assert.equal(outcomes[1].data.first_pass, false);
  assert.equal(outcomes[2].data.first_pass, false);

  const vf = by('verification_failure');
  assert.deepEqual(vf.map((o) => o.task_id), ['B-001', 'B-001', 'C-001']);
  assert.match(vf[2].text, /npm test \(exit 1\)/);
  assert.deepEqual(vf[2].data.failed_commands, [{ command: 'npm test', exit_code: 1, timed_out: false, refused: false }]);

  const re = by('retry_effectiveness');
  assert.equal(re.length, 1);
  assert.equal(re[0].task_id, 'C-001');
  assert.equal(re[0].data.retries, 1);
  assert.equal(re[0].data.recovered, false);
});

// ---------------------------------------------------------------------------
// 3. generateProposals
// ---------------------------------------------------------------------------

test('generateProposals returns [] without enough evidence', () => {
  const cfg = config.loadConfig({ skillDir: REAL_SKILL });
  assert.deepEqual(imp.generateProposals([], cfg, NOW), []);
  // four failing haiku tasks: below min_samples (5)
  const four = [1, 2, 3, 4].map((i) => outcome(i, { attempts: 3 }));
  assert.deepEqual(imp.generateProposals(four, cfg, NOW), []);
  // the same task collected twice counts once
  assert.deepEqual(imp.generateProposals([...four, outcome(4, { attempts: 3 })], cfg, NOW), []);
  // enough samples, but the first-pass rate is one half or more
  const good = [1, 2, 3, 4, 5, 6].map((i) => outcome(i, { first_pass: i <= 3, attempts: i <= 3 ? 1 : 3 }));
  assert.deepEqual(imp.generateProposals(good, cfg, NOW), []);
  // observations spread over different bands do not add up
  const spread = [1, 2, 3, 4, 5].map((i) => outcome(i, { complexity: 2 * i - 1, attempts: 3 }));
  assert.deepEqual(imp.generateProposals(spread, cfg, NOW), []);
});

test('generateProposals proposes a routing heuristic quoting the observed counts', () => {
  const cfg = config.loadConfig({ skillDir: REAL_SKILL });
  const props = imp.generateProposals(lowFirstPass(), cfg, NOW);
  assert.equal(props.length, 1);
  const p = props[0];
  assert.equal(p.category, 'routing_heuristics');
  assert.equal(p.id, 'IMP-20261115-001');
  assert.equal(p.status, 'proposed');
  assert.equal(p.approved_by, null);
  assert.equal(p.weakens_safety, false);
  assert.equal(p.target_file, 'config/routing.yaml');
  assert.deepEqual(p.change, { kind: 'config_set', key: 'routing.heuristic_expected_attempts.haiku.5-6', value: 2.2 });
  assert.ok(p.evidence.length >= 1);
  assert.ok(p.evidence.some((e) => /first-pass 1 of 6 at complexity 5-6/.test(e)), p.evidence.join(' | '));
  assert.ok(p.evidence.some((e) => /mean attempts 2\.17 over 6 tasks/.test(e)));
  assert.ok(p.evidence.every((e) => e.includes(RUN) || /over 6 tasks/.test(e)));
  assert.deepEqual(imp.validateProposal(p), { ok: true, errors: [] });

  // min_samples comes from the configuration
  const cfg3 = config.loadConfig({ skillDir: REAL_SKILL, overrides: { improvement: { min_samples: 3 } } });
  const three = [1, 2, 3].map((i) => outcome(i, { model: 'sonnet', complexity: 8, attempts: 3 }));
  const p3 = imp.generateProposals(three, cfg3, NOW);
  assert.equal(p3.length, 1);
  assert.match(p3[0].evidence[0], /sonnet first-pass 0 of 3 at complexity 7-8/);
  assert.deepEqual(imp.generateProposals(three, cfg, NOW), []);
});

test('generateProposals: other rules, id numbering and duplicates all yield valid proposals', () => {
  const cfg = config.loadConfig({ skillDir: REAL_SKILL });
  // low first-pass rate but mean attempts not above the heuristic -> manual proposal
  const lowAttempts = [1, 2, 3, 4, 5].map((i) => outcome(i, { model: 'opus', complexity: 9, attempts: 1, run_id: '20261115-120000-beef' }));
  // retries that rarely recover -> recovery_behavior proposal
  const retries = [1, 2, 3, 4, 5].map((i) => ({
    ts: NOW, run_id: RUN, task_id: `R-00${i}`, category: 'retry_effectiveness', text: 'x',
    data: { model: 'haiku', retries: 1, attempts: 2, recovered: i === 1 },
  }));
  const all = imp.generateProposals([...lowFirstPass(), ...lowAttempts, ...retries], cfg, NOW);
  assert.deepEqual(all.map((p) => p.category).sort(), ['recovery_behavior', 'routing_heuristics', 'routing_heuristics']);
  const manual = all.find((p) => p.change.kind === 'manual' && p.category === 'routing_heuristics');
  assert.match(manual.evidence[0], /opus first-pass 0 of 5 at complexity 9-10/);
  const recovery = all.find((p) => p.category === 'recovery_behavior');
  assert.match(recovery.evidence[0], /1 of 5 retried tasks recovered/);
  assert.equal(new Set(all.map((p) => p.id)).size, all.length);
  for (const p of all) assert.deepEqual(imp.validateProposal(p, { config: cfg }), { ok: true, errors: [] }, p.id);

  // existing proposals: ids continue after the highest, open duplicates are not repeated
  const again = imp.generateProposals([...lowFirstPass(), ...retries], cfg, NOW, { existing: all });
  assert.deepEqual(again, []);
  const afterReject = imp.generateProposals(lowFirstPass(), cfg, NOW, { existing: all.map((p) => Object.assign({}, p, { status: 'rejected' })) });
  assert.equal(afterReject.length, 1);
  assert.equal(afterReject[0].id, 'IMP-20261115-004');
});

// ---------------------------------------------------------------------------
// 4. validateProposal
// ---------------------------------------------------------------------------

function expectError(p, re) {
  const r = imp.validateProposal(p);
  assert.equal(r.ok, false, `expected rejection matching ${re}`);
  assert.ok(r.errors.some((e) => re.test(e)), `errors ${JSON.stringify(r.errors)} do not match ${re}`);
}

test('validateProposal accepts a well-formed proposal and a harmless lowering of min_complexity', () => {
  assert.deepEqual(imp.validateProposal(validProposal()), { ok: true, errors: [] });
  // the default balanced min_complexity is 5, so 4 is a lowering (more independent reviews)
  assert.deepEqual(imp.validateProposal(configSet('verification.modes.balanced.independent_review.min_complexity', 4, 'config/verification.yaml')), { ok: true, errors: [] });
  assert.deepEqual(imp.validateProposal(configSet('execution.max_retries', 3, 'config/execution.yaml')), { ok: true, errors: [] });
  assert.deepEqual(imp.validateProposal(validProposal({ target_file: 'SKILL.md', change: { kind: 'manual', description: 'Clarify step 3.' } })), { ok: true, errors: [] });
});

test('validateProposal rejects each unsafe or malformed proposal with a specific error', () => {
  expectError(validProposal({ evidence: undefined }), /evidence must be a non-empty list/);
  expectError(validProposal({ evidence: [] }), /evidence must be a non-empty list/);
  expectError(validProposal({ category: 'vibes' }), /unknown category: vibes/);
  expectError(validProposal({ status: 'merged' }), /unknown status: merged/);
  expectError(validProposal({ target_file: '/etc/routing.yaml' }), /target_file must be relative/);
  expectError(validProposal({ target_file: 'C:/skill/config/routing.yaml' }), /target_file must be relative/);
  expectError(validProposal({ target_file: 'config/../SKILL.md' }), /target_file must not contain "\.\."/);
  expectError(validProposal({ target_file: '../other-skill/config/routing.yaml' }), /target_file must not contain "\.\."/);
  expectError(validProposal({ weakens_safety: true }), /weakens_safety must be false/);
  expectError(validProposal({ weakens_safety: undefined }), /weakens_safety must be false/);
  expectError(configSet('security.protected_paths', [], 'config/security.yaml'), /security\.protected_paths \(security settings\) must be changed by a person/);
  expectError(configSet('security.extra_unsafe_patterns', ['x'], 'config/execution.yaml'), /security settings\) must be changed by a person/);
  expectError(configSet('improvement.auto_modify_core_skill', true, 'config/execution.yaml'), /improvement\.auto_modify_core_skill must be changed by a person/);
  expectError(configSet('improvement.auto_modify_core_skill', false, 'config/execution.yaml'), /improvement\.auto_modify_core_skill must be changed by a person/);
  expectError(configSet('verification.modes.balanced.independent_review.min_complexity', 9, 'config/verification.yaml'), /raises verification\.modes\.balanced\.independent_review\.min_complexity from 5 to 9 .*must be changed by a person/);
  expectError(configSet('verification.modes.balanced.independent_review.min_complexity', 6, 'config/verification.yaml'), /raises .* from 5 to 6/);
  expectError(configSet('verification.modes.thorough.independent_review.min_complexity', 4, 'config/verification.yaml'), /raises .* from 3 to 4/);
  expectError(configSet('verification.modes.maximum.independent_review.min_complexity', 2, 'config/verification.yaml'), /raises .* from 1 to 2/);
  expectError(configSet('routing.heuristic_expected_attempts.haiku.5-6', 2.0, 'SKILL.md'), /config_set targets SKILL\.md, outside config\/: must be changed by a person/);
  expectError(configSet('routing.heuristic_expected_attempts.haiku.5-6', 2.0, 'agents/opus-implementer.md'), /outside config\/: must be changed by a person/);
  expectError(configSet('execution.max_review_rounds', 11, 'config/execution.yaml'), /above 10 must be changed by a person/);
  expectError(configSet('execution.max_retries', 50, 'config/execution.yaml'), /above 10 must be changed by a person/);
  expectError(configSet('verification.modes.balanced.independent_review.risks', [], 'config/verification.yaml'), /verification requirement\) must be changed by a person/);
  expectError(configSet('execution.independent_verification', false, 'config/execution.yaml'), /must be changed by a person/);
  expectError(configSet('routing.__proto__.x', 1), /forbidden name/);
  expectError(validProposal({ status: 'approved', approved_by: 'orchestrator' }), /requires approved_by: user/);
  expectError(validProposal({ change: { kind: 'rewrite' } }), /unknown change kind/);
  expectError(validProposal({ id: 'IMP-1' }), /id must look like/);

  // a raise is judged against the configuration in force when one is given
  const cfg = { verification: { modes: { balanced: { independent_review: { min_complexity: 9 } } } } };
  const p = configSet('verification.modes.balanced.independent_review.min_complexity', 8, 'config/verification.yaml');
  assert.equal(imp.validateProposal(p, { config: cfg }).ok, true);
  assert.equal(imp.validateProposal(p).ok, false);
});

// ---------------------------------------------------------------------------
// 5-7. status, apply, rollback
// ---------------------------------------------------------------------------

test('saveProposal, loadProposal and listProposals round-trip; invalid proposals are not saved', () => {
  const s = setup();
  try {
    const p = validProposal();
    imp.saveProposal(s.paths, p);
    assert.deepEqual(imp.loadProposal(s.paths, p.id), p);
    assert.deepEqual(imp.listProposals(s.paths).map((x) => x.id), [p.id]);
    assert.throws(() => imp.saveProposal(s.paths, validProposal({ id: 'IMP-20261115-002', weakens_safety: true })), (e) => e.code === 'INVALID_PROPOSAL');
    assert.equal(fs.existsSync(path.join(s.paths.proposalsDir, 'IMP-20261115-002.yaml')), false);
    assert.throws(() => imp.loadProposal(s.paths, 'IMP-20261115-009'), (e) => e.code === 'NO_PROPOSAL');
    assert.throws(() => imp.loadProposal(s.paths, '../x'), (e) => e.code === 'BAD_ID');
  } finally {
    s.done();
  }
});

test('setProposalStatus requires the user for approval; applyProposal refuses unapproved and manual proposals', () => {
  const s = setup();
  try {
    const original = fs.readFileSync(path.join(s.skillDir, 'config', 'routing.yaml'));
    const p = validProposal();
    imp.saveProposal(s.paths, p);

    for (const by of [undefined, 'orchestrator', 'opus-reviewer', 'User']) {
      assert.throws(() => imp.setProposalStatus(s.paths, p.id, 'approved', { by }), (e) => e.code === 'NOT_USER');
    }
    assert.equal(imp.loadProposal(s.paths, p.id).status, 'proposed');
    assert.throws(() => imp.setProposalStatus(s.paths, p.id, 'applied', { by: 'user' }), (e) => e.code === 'BAD_STATUS');

    // not approved
    assert.throws(() => imp.applyProposal(s.paths, s.skillDir, p.id, NOW), (e) => e.code === 'NOT_APPROVED');
    imp.setProposalStatus(s.paths, p.id, 'rejected', { by: 'user' });
    assert.throws(() => imp.applyProposal(s.paths, s.skillDir, p.id, NOW), (e) => e.code === 'NOT_APPROVED');
    assert.throws(() => imp.setProposalStatus(s.paths, p.id, 'approved', { by: 'user' }), (e) => e.code === 'BAD_STATUS');

    // manual, even when approved by the user
    const m = validProposal({ id: 'IMP-20261115-002', target_file: 'SKILL.md', change: { kind: 'manual', description: 'Reword the intro.' } });
    imp.saveProposal(s.paths, m);
    const approved = imp.setProposalStatus(s.paths, m.id, 'approved', { by: 'user', now: NOW });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approved_by, 'user');
    assert.throws(() => imp.applyProposal(s.paths, s.skillDir, m.id, NOW), (e) => e.code === 'MANUAL_ONLY');

    // nothing in the skill copy changed
    assert.ok(fs.readFileSync(path.join(s.skillDir, 'config', 'routing.yaml')).equals(original));
    assert.equal(fs.readFileSync(path.join(s.skillDir, 'VERSION'), 'utf8'), '1.0.0\n');
    assert.equal(fs.existsSync(path.join(s.skillDir, 'history')), false);
  } finally {
    s.done();
  }
});

test('applyProposal backs up, changes exactly one key, bumps VERSION and logs; rollbackProposal restores byte for byte', () => {
  const s = setup();
  try {
    const target = path.join(s.skillDir, 'config', 'routing.yaml');
    const original = fs.readFileSync(target);
    const changelogBefore = fs.readFileSync(path.join(s.skillDir, 'CHANGELOG.md'), 'utf8');
    const otherConfig = hashTree(path.join(s.skillDir, 'config'));
    delete otherConfig['routing.yaml'];

    const p = validProposal({ rationale: 'haiku passed first time in 1 of 6 tasks at complexity 5-6 (below one half).' });
    imp.saveProposal(s.paths, p);
    imp.setProposalStatus(s.paths, p.id, 'approved', { by: 'user', now: NOW });
    const r = imp.applyProposal(s.paths, s.skillDir, p.id, NOW);
    assert.deepEqual(r, { changed_file: 'config/routing.yaml', backup: 'history/1.0.0/config/routing.yaml', version: '2.0.1', previous_version: '1.0.0' });

    // backup under history/<old version>/ is the original, byte for byte
    const backup = path.join(s.skillDir, 'history', '1.0.0', 'config', 'routing.yaml');
    assert.ok(fs.readFileSync(backup).equals(original));

    // exactly the named key changed
    const before = yaml.parse(original.toString('utf8'));
    const afterText = fs.readFileSync(target, 'utf8');
    const after = yaml.parse(afterText);
    assert.equal(after.routing.heuristic_expected_attempts.haiku['5-6'], 2.2);
    before.routing.heuristic_expected_attempts.haiku['5-6'] = 2.2;
    assert.deepEqual(after, before);
    assert.match(afterText, /^# Edited by improvement proposal IMP-20261115-001 on 2026-11-15/);
    const rest = hashTree(path.join(s.skillDir, 'config'));
    delete rest['routing.yaml'];
    assert.deepEqual(rest, otherConfig);
    assert.deepEqual(fs.readdirSync(path.join(s.skillDir, 'config')).sort(), Object.keys(otherConfig).concat('routing.yaml').sort());
    // the edited configuration still validates
    assert.equal(config.validateConfig(config.loadConfig({ skillDir: s.skillDir })).ok, true);

    // VERSION patch bump and dated CHANGELOG entry with id and rationale
    assert.equal(fs.readFileSync(path.join(s.skillDir, 'VERSION'), 'utf8'), '2.0.1\n');
    const changelog = fs.readFileSync(path.join(s.skillDir, 'CHANGELOG.md'), 'utf8');
    assert.ok(changelog.startsWith(changelogBefore));
    const entry = changelog.slice(changelogBefore.length);
    assert.match(entry, /## 2\.0\.1 - 2026-11-15/);
    assert.match(entry, /IMP-20261115-001/);
    assert.ok(entry.includes(p.rationale));
    assert.match(entry, /comments in the previous version are preserved only in this backup/);
    assert.match(entry, /history\/2\.0\.0\/config\/routing\.yaml/);

    const applied = imp.loadProposal(s.paths, p.id);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.applied.previous_value, 1.5);
    assert.equal(applied.applied.backup, 'history/1.0.0/config/routing.yaml');
    assert.throws(() => imp.applyProposal(s.paths, s.skillDir, p.id, NOW), (e) => e.code === 'NOT_APPROVED');

    // rollback
    const rb = imp.rollbackProposal(s.paths, s.skillDir, p.id, '2026-11-16T09:00:00.000Z');
    assert.equal(rb.restored_file, 'config/routing.yaml');
    assert.ok(fs.readFileSync(target).equals(original), 'restored byte for byte');
    const changelog2 = fs.readFileSync(path.join(s.skillDir, 'CHANGELOG.md'), 'utf8');
    assert.ok(changelog2.startsWith(changelog));
    const rbEntry = changelog2.slice(changelog.length);
    assert.match(rbEntry, /2026-11-16/);
    assert.match(rbEntry, /Rolled back improvement proposal IMP-20261115-001/);
    assert.equal(imp.loadProposal(s.paths, p.id).status, 'rolled_back');
    assert.throws(() => imp.rollbackProposal(s.paths, s.skillDir, p.id, NOW), (e) => e.code === 'NOT_APPLIED');
  } finally {
    s.done();
  }
});

test('rollbackProposal refuses when the file changed after the proposal was applied', () => {
  const s = setup();
  try {
    const target = path.join(s.skillDir, 'config', 'routing.yaml');
    const p = validProposal();
    imp.saveProposal(s.paths, p);
    imp.setProposalStatus(s.paths, p.id, 'approved', { by: 'user' });
    imp.applyProposal(s.paths, s.skillDir, p.id, NOW);
    fs.appendFileSync(target, '# hand edit\n');
    const edited = fs.readFileSync(target);
    assert.throws(() => imp.rollbackProposal(s.paths, s.skillDir, p.id, NOW), (e) => e.code === 'CHANGED_SINCE');
    assert.ok(fs.readFileSync(target).equals(edited));
    assert.equal(imp.loadProposal(s.paths, p.id).status, 'applied');
  } finally {
    s.done();
  }
});

test('applyProposal re-checks the proposal and refuses a target outside config/', () => {
  const s = setup();
  try {
    // a hand-edited proposal file that claims approval but targets a core skill file
    const p = validProposal({ status: 'approved', approved_by: 'user', target_file: 'SKILL.md' });
    fs.writeFileSync(path.join(s.skillDir, 'SKILL.md'), 'routing:\n  x: 1\n');
    fs.writeFileSync(path.join(s.paths.proposalsDir, `${p.id}.yaml`), yaml.stringify(p));
    assert.throws(() => imp.applyProposal(s.paths, s.skillDir, p.id, NOW), (e) => e.code === 'BAD_TARGET' || e.code === 'INVALID_PROPOSAL');
    assert.equal(fs.readFileSync(path.join(s.skillDir, 'SKILL.md'), 'utf8'), 'routing:\n  x: 1\n');
    assert.equal(fs.readFileSync(path.join(s.skillDir, 'VERSION'), 'utf8'), '1.0.0\n');
  } finally {
    s.done();
  }
});

// ---------------------------------------------------------------------------
// 8. the real skill directory is untouched
// ---------------------------------------------------------------------------

test('nothing in the real skill directory was written by these tests', () => {
  assert.deepEqual(REAL_WRITES, []);
  assert.equal(fs.existsSync(path.join(REAL_SKILL, 'history')), HISTORY_EXISTED);
  // the guard is live: a harmless recursive mkdir of the existing directory is recorded
  fs.mkdirSync(path.join(REAL_SKILL, 'config'), { recursive: true });
  assert.equal(REAL_WRITES.length, 1);
  REAL_WRITES.length = 0;
});
