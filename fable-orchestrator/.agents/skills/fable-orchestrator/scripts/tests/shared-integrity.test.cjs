'use strict';
// Real CLI/filesystem tests. Worker reports are deterministic fixtures, not model calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const yaml = require('../miniyaml.cjs');

const FO = path.resolve(__dirname, '..', 'fo.cjs');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
function cli(root, args, input) {
  const r = spawnSync(process.execPath, [FO, ...args], { cwd: root, encoding: 'utf8', input: input || '' });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
function ok(root, args, input) {
  const r = cli(root, args, input);
  assert.equal(r.code, 0, `${args.join(' ')}: ${r.out}`);
  return r.out;
}
function fixture(commands = ['node -e "process.exit(0)"'], setup = null) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fo-shared-integrity-')));
  write(path.join(root, 'src/a.js'), 'module.exports = 1;\n');
  write(path.join(root, 'notes.txt'), 'existing unrelated user content\n');
  if (setup) write(path.join(root, '.claude/fable-orchestrator/config.yaml'), yaml.dump({ integration: { setup_command: setup } }));
  const init = ok(root, ['init', '--stdin'], 'Update a helper safely');
  const runDir = /run_dir: (.+)/.exec(init)[1].trim();
  const contract = {
    task_id: 'S-001', title: 'Update helper', objective: 'Update the helper', priority: 'medium',
    dependencies: [], complexity_score: 2, risk_level: 'low', file_scope: ['src/'],
    acceptance_criteria: ['helper satisfies checks'], verification: ['execute checks'], verification_commands: commands,
  };
  ok(root, ['plan', '--stdin'], yaml.dump(contract));
  const spec = JSON.parse(ok(root, ['next', '--json'])).specs[0];
  const state = () => JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  const report = () => ok(root, ['report', 'S-001', '--stdin'], yaml.dump({
    task_id: 'S-001', attempt_id: spec.attempt_id, status: 'implemented', summary: 'Updated helper',
    files_changed: ['src/a.js'], verification: { tests_run: false, tests_passed: null, build_passed: null }, known_issues: [],
  }));
  const approve = () => ok(root, ['review', 'S-001', '--stdin'], yaml.dump({
    task_id: 'S-001', reviewer: 'orchestrator', verdict: 'approve',
    candidate_snapshot: state().tasks['S-001'].verified_snapshot_id,
    criteria: [{ met: true, evidence: 'read the helper and independent test output' }], findings: [],
  }));
  write(path.join(root, 'src/a.js'), 'module.exports = 2;\n');
  return { root, runDir, state, report, approve, spec };
}

test('shared verification rejects source changes made by a passing check', () => {
  const f = fixture(['node -e "require(\'fs\').writeFileSync(\'src/a.js\',\'changed by test\')"']);
  f.report();
  const result = ok(f.root, ['verify', 'S-001']);
  assert.match(result, /CORRECTION_REQUIRED/);
  assert.match(result, /shared workspace changed/);
  assert.equal(f.state().tasks['S-001'].verified_snapshot, undefined);
  assert.match(ok(f.root, ['verify', 'S-001', '--reverify', '--reason', 'Inspect and verify the now stable corrected source']), /-> REVIEWING/);
  assert.equal(f.state().tasks['S-001'].verify_cycle, 2);
});

test('shared required setup failure stops verification commands', () => {
  const f = fixture(['node -e "require(\'fs\').writeFileSync(\'src/should-not-run\',\'bad\')"'], 'node -e "process.exit(17)"');
  f.report();
  const result = ok(f.root, ['verify', 'S-001']);
  assert.match(result, /CORRECTION_REQUIRED/);
  assert.match(result, /exit 17/);
  assert.equal(fs.existsSync(path.join(f.root, 'src/should-not-run')), false);
});

test('shared scoped worker changes pass through review, integration and final content verification while preserving unrelated files', () => {
  const f = fixture();
  f.report();
  assert.match(ok(f.root, ['verify', 'S-001']), /-> REVIEWING/);
  const verified = f.state().tasks['S-001'];
  assert.equal(verified.verified_snapshot.truncated, false);
  assert.match(verified.verified_snapshot_id, /^[0-9a-f]{64}$/);
  f.approve();
  assert.match(ok(f.root, ['integrate', 'S-001']), /-> COMPLETED/);
  assert.match(ok(f.root, ['deliver']), /DELIVERY: in_place/);
  const delivered = f.state();
  assert.equal(delivered.delivery.verified, true);
  assert.equal(delivered.delivery.snapshot_id, verified.verified_snapshot_id);
  assert.equal(delivered.phase, 'DELIVERED');
  assert.equal(fs.readFileSync(path.join(f.root, 'notes.txt'), 'utf8'), 'existing unrelated user content\n');
  ok(f.root, ['reopen', 'S-001', '--reason', 'Additional work remains']);
  ok(f.root, ['deliver']);
  assert.equal(f.state().delivery.verified, false);
  assert.notEqual(f.state().phase, 'DELIVERED');
});

for (const mutation of ['add', 'delete', 'edit']) {
  test(`shared worker ${mutation} outside its scope is detected from authoritative content`, () => {
    const f = fixture();
    if (mutation === 'add') write(path.join(f.root, 'generated/output.json'), '{}');
    else if (mutation === 'delete') fs.unlinkSync(path.join(f.root, 'notes.txt'));
    else write(path.join(f.root, 'notes.txt'), 'unapproved worker edit\n');
    f.report();
    const output = ok(f.root, ['verify', 'S-001']);
    assert.match(output, /modified outside the authorized scope/);
    assert.equal(f.state().tasks['S-001'].state, 'CORRECTION_REQUIRED');
    assert.equal(f.state().tasks['S-001'].checks.some((check) => check.kind === 'command'), false, 'unsafe baseline prevents commands');
    if (mutation === 'add') assert.equal(fs.readFileSync(path.join(f.root, 'generated/output.json'), 'utf8'), '{}');
  });
}

for (const phase of ['verify', 'integrate']) {
  for (const mutation of ['create artifact', 'delete unrelated file']) {
    test(`shared ${phase} rejects ${mutation} even when the command exits successfully`, () => {
      const command = mutation === 'create artifact'
        ? 'node -e "require(\'fs\').writeFileSync(\'coverage.json\',\'{}\')"'
        : 'node -e "require(\'fs\').unlinkSync(\'notes.txt\')"';
      const f = fixture(phase === 'verify' ? [command] : undefined);
      f.report();
      if (phase === 'integrate') {
        ok(f.root, ['verify', 'S-001']);
        f.approve();
      }
      const output = ok(f.root, [phase, 'S-001', ...(phase === 'integrate' ? ['--cmd', command] : [])]);
      assert.match(output, /modified outside the authorized scope/);
      assert.equal(f.state().tasks['S-001'].state, 'CORRECTION_REQUIRED');
      if (mutation === 'create artifact') assert.equal(fs.readFileSync(path.join(f.root, 'coverage.json'), 'utf8'), '{}', 'evidence is preserved, never auto-deleted');
      assert.equal(f.state().project.shared_integration, undefined);
    });
  }
}

test('shared integration source changes invalidate approval and stop following commands', () => {
  const f = fixture();
  f.report();
  ok(f.root, ['verify', 'S-001']);
  f.approve();
  const output = ok(f.root, ['integrate', 'S-001', '--cmd', 'node -e "require(\'fs\').writeFileSync(\'src/a.js\',\'integration change\')"',
    '--cmd', 'node -e "require(\'fs\').writeFileSync(\'src/should-not-run\',\'bad\')"']);
  assert.match(output, /shared workspace changed/);
  assert.equal(f.state().tasks['S-001'].state, 'CORRECTION_REQUIRED');
  assert.equal(fs.existsSync(path.join(f.root, 'src/should-not-run')), false);
});

test('shared integration required setup failure stops following commands', () => {
  const setup = 'node -e "const fs=require(\'fs\'),p=\'.claude/fable-orchestrator/setup-ran\';if(fs.existsSync(p))process.exit(17);fs.writeFileSync(p,\'1\')"';
  const f = fixture(undefined, setup);
  f.report();
  ok(f.root, ['verify', 'S-001']);
  f.approve();
  const output = ok(f.root, ['integrate', 'S-001', '--cmd', 'node -e "require(\'fs\').writeFileSync(\'src/should-not-run\',\'bad\')"']);
  assert.match(output, /exit 17/);
  assert.equal(f.state().tasks['S-001'].state, 'CORRECTION_REQUIRED');
  assert.equal(fs.existsSync(path.join(f.root, 'src/should-not-run')), false);
});

test('shared content drift after report is rejected before verification executes', () => {
  const f = fixture();
  f.report();
  write(path.join(f.root, 'src/a.js'), 'module.exports = 3;\n');
  assert.match(ok(f.root, ['verify', 'S-001']), /shared workspace changed before checks/);
  assert.equal(f.state().tasks['S-001'].state, 'CORRECTION_REQUIRED');
  assert.equal(f.state().tasks['S-001'].checks.some((check) => check.kind === 'command'), false);
});

test('shared review refuses a stale verification snapshot', () => {
  const f = fixture();
  f.report();
  ok(f.root, ['verify', 'S-001']);
  write(path.join(f.root, 'src/a.js'), 'module.exports = 3;\n');
  const output = cli(f.root, ['review', 'S-001', '--stdin'], yaml.dump({ task_id: 'S-001', reviewer: 'orchestrator', verdict: 'approve', criteria: [{ met: true, evidence: 'stale output' }], findings: [] }));
  assert.notEqual(output.code, 0);
  assert.match(output.out, /STALE_EVIDENCE/);
  assert.equal(f.state().tasks['S-001'].reviews.length, 0);
  assert.match(ok(f.root, ['verify', 'S-001', '--reverify', '--reason', 'Recheck changed shared source']), /-> REVIEWING/);
  assert.equal(f.state().tasks['S-001'].verify_cycle, 2);
  assert.match(f.approve(), /APPROVED/);
});

test('shared integration rejects same-size content drift after review even when mtime is restored', () => {
  const f = fixture();
  f.report();
  ok(f.root, ['verify', 'S-001']);
  f.approve();
  const file = path.join(f.root, 'src/a.js');
  const before = fs.statSync(file);
  write(file, 'module.exports = 3;\n');
  fs.utimesSync(file, before.atime, before.mtime);
  const output = ok(f.root, ['integrate', 'S-001', '--cmd', 'node -e "require(\'fs\').writeFileSync(\'src/should-not-run\',\'bad\')"']);
  assert.match(output, /shared workspace changed before checks/);
  assert.equal(f.state().tasks['S-001'].state, 'CORRECTION_REQUIRED');
  assert.equal(fs.existsSync(path.join(f.root, 'src/should-not-run')), false);
});

test('shared final delivery refuses changes after integration and preserves those changes', () => {
  const f = fixture();
  f.report();
  ok(f.root, ['verify', 'S-001']);
  f.approve();
  ok(f.root, ['integrate', 'S-001']);
  ok(f.root, ['deliver']);
  assert.equal(f.state().phase, 'DELIVERED');
  write(path.join(f.root, 'notes.txt'), 'new user content\n');
  assert.match(ok(f.root, ['deliver']), /DELIVERY: not_delivered/);
  assert.notEqual(f.state().phase, 'DELIVERED');
  assert.equal(fs.readFileSync(path.join(f.root, 'notes.txt'), 'utf8'), 'new user content\n');
  const checkpoint = yaml.parse(fs.readFileSync(path.join(f.runDir, 'checkpoint.yaml'), 'utf8'));
  assert.equal(checkpoint.integration.delivery, 'not_delivered');
  assert.equal(checkpoint.integration.verified, false);
});

test('incomplete shared dispatch evidence cannot authorize a report or verification', () => {
  const f = fixture();
  const snapshotPath = f.state().tasks['S-001'].attempts[0].snapshot;
  const complete = fs.readFileSync(snapshotPath, 'utf8');
  const partial = JSON.parse(complete);
  partial.truncated = true;
  write(snapshotPath, JSON.stringify(partial));
  assert.throws(f.report, /INCOMPLETE_SCOPE/);
  assert.equal(f.state().tasks['S-001'].state, 'DISPATCHED');
  write(snapshotPath, complete);
  f.report();
  write(snapshotPath, JSON.stringify(partial));
  const output = cli(f.root, ['verify', 'S-001']);
  assert.notEqual(output.code, 0);
  assert.match(output.out, /INCOMPLETE_SCOPE/);
  assert.equal(f.state().tasks['S-001'].verification_operation, undefined);
});

test('an actually truncated current workspace scan prevents shared verification', () => {
  const f = fixture();
  f.report();
  const manyFiles = path.join(f.root, 'generated');
  fs.mkdirSync(manyFiles);
  for (let i = 0; i < 20001; i++) fs.writeFileSync(path.join(manyFiles, `${i}.txt`), '');
  const output = ok(f.root, ['verify', 'S-001']);
  assert.match(output, /snapshot was incomplete/);
  const task = f.state().tasks['S-001'];
  assert.equal(task.state, 'CORRECTION_REQUIRED');
  assert.equal(task.checks.some((check) => check.kind === 'command'), false);
  assert.equal(task.verified_snapshot, undefined);
});

test('shared final command mutations invalidate delivery even after earlier checks passed', () => {
  const command = 'node -e "const fs=require(\'fs\'),p=\'.claude/fable-orchestrator/check-count\',n=fs.existsSync(p)?Number(fs.readFileSync(p)):0;fs.writeFileSync(p,String(n+1));if(n===2)fs.writeFileSync(\'src/a.js\',\'changed during delivery\')"';
  const f = fixture([command]);
  f.report();
  ok(f.root, ['verify', 'S-001']);
  f.approve();
  ok(f.root, ['integrate', 'S-001']);
  assert.match(ok(f.root, ['deliver']), /DELIVERY: not_delivered/);
  assert.notEqual(f.state().phase, 'DELIVERED');
  assert.equal(fs.readFileSync(path.join(f.root, 'src/a.js'), 'utf8'), 'changed during delivery');
});

test('shared correction cannot launder an earlier unauthorized edit into a fresh baseline', () => {
  const f = fixture();
  write(path.join(f.root, 'notes.txt'), 'unauthorized first attempt edit\n');
  f.report();
  assert.match(ok(f.root, ['verify', 'S-001']), /CORRECTION_REQUIRED/);
  const originalBaseline = f.state().tasks['S-001'].attempts[0].snapshot;
  ok(f.root, ['correct', 'S-001', '--stdin'], yaml.dump({
    task_id: 'S-001', failure: 'Out-of-scope notes edit', evidence: 'scope check',
    expected_behavior: 'Keep unrelated notes intact', required_change: 'Restore notes and correct helper', verification: ['run checks'],
  }));
  const retry = JSON.parse(ok(f.root, ['next', '--json'])).specs[0];
  assert.notEqual(retry.attempt_id, f.spec.attempt_id);
  assert.equal(f.state().tasks['S-001'].attempts[1].snapshot, originalBaseline);
  write(path.join(f.root, 'src/a.js'), 'module.exports = 3;\n');
  ok(f.root, ['report', 'S-001', '--stdin'], yaml.dump({
    task_id: 'S-001', attempt_id: retry.attempt_id, status: 'implemented', summary: 'Corrected helper only',
    files_changed: ['src/a.js'], verification: { tests_run: false, tests_passed: null, build_passed: null }, known_issues: [],
  }));
  assert.match(ok(f.root, ['verify', 'S-001']), /modified outside the authorized scope: notes.txt/);
  assert.equal(f.state().tasks['S-001'].state, 'CORRECTION_REQUIRED');
  assert.equal(fs.readFileSync(path.join(f.root, 'notes.txt'), 'utf8'), 'unauthorized first attempt edit\n');
  write(path.join(f.root, 'notes.txt'), 'existing unrelated user content\n');
  assert.match(ok(f.root, ['verify', 'S-001', '--reverify', '--reason', 'Restored original unrelated content']), /REVIEWING/);
});

test('shared orchestrator reviews must name the current snapshot and cannot replay stale approval', () => {
  const f = fixture();
  f.report();
  ok(f.root, ['verify', 'S-001']);
  const review = { task_id: 'S-001', reviewer: 'orchestrator', verdict: 'approve',
    criteria: [{ met: true, evidence: 'inspected prior snapshot' }], findings: [] };
  assert.match(cli(f.root, ['review', 'S-001', '--stdin'], yaml.dump(review)).out, /STALE_EVIDENCE/);
  review.candidate_snapshot = f.state().tasks['S-001'].verified_snapshot_id;
  write(path.join(f.root, 'src/a.js'), 'module.exports = 4;\n');
  ok(f.root, ['verify', 'S-001', '--reverify', '--reason', 'Verify updated helper']);
  assert.notEqual(f.state().tasks['S-001'].verified_snapshot_id, review.candidate_snapshot);
  assert.match(cli(f.root, ['review', 'S-001', '--stdin'], yaml.dump(review)).out, /STALE_EVIDENCE/);
  assert.equal(f.state().tasks['S-001'].reviews.length, 0);
  assert.match(f.approve(), /APPROVED/);
});

test('shared manual-only re-verification retains its snapshot while awaiting manual evidence', () => {
  const f = fixture([]);
  f.report();
  ok(f.root, ['check', 'S-001', '--name', 'Inspect helper', '--result', 'pass', '--note', 'Read helper value 2']);
  ok(f.root, ['verify', 'S-001']);
  write(path.join(f.root, 'src/a.js'), 'module.exports = 5;\n');
  assert.match(cli(f.root, ['verify', 'S-001', '--reverify', '--reason', 'Inspect changed helper']).out, /NO_VERIFICATION_EVIDENCE/);
  ok(f.root, ['check', 'S-001', '--name', 'Inspect changed helper', '--result', 'pass', '--note', 'Read helper value 5']);
  assert.match(ok(f.root, ['verify', 'S-001']), /REVIEWING/);
  assert.match(f.approve(), /APPROVED/);
});

test('shared verification detects a concurrent workspace writer and leaves its files intact', async () => {
  const ready = '.claude/fable-orchestrator/check-ready';
  const f = fixture([`node -e "require('fs').writeFileSync('${ready}','1');setTimeout(()=>{},1000)"`]);
  f.report();
  const child = spawn(process.execPath, [FO, 'verify', 'S-001'], { cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const completed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(f.root, ready)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(path.join(f.root, ready)), true, 'verification command reached its synchronization point');
  write(path.join(f.root, 'notes.txt'), 'concurrent user edit\n');
  assert.equal(await completed, 0);
  assert.match(output, /modified outside the authorized scope: notes.txt/);
  assert.equal(f.state().tasks['S-001'].state, 'CORRECTION_REQUIRED');
  assert.equal(fs.readFileSync(path.join(f.root, 'notes.txt'), 'utf8'), 'concurrent user edit\n');
});
