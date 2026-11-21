'use strict';
// manage_state.cjs: show, transitions, integrity and events, run as a child process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const H = require('./oo-harness.cjs');

test.after(H.cleanup);

const MS = path.join(H.SKILL, 'scripts', 'manage_state.cjs');

function ms(p, args) {
  const r = spawnSync(process.execPath, [MS, ...args], { cwd: p.dir, env: p.env, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('manage_state show, transitions, integrity and events', () => {
  const p = H.project();
  let r = ms(p, ['show']);
  assert.equal(r.code, 1);
  assert.match(r.out, /REFUSED: no run to inspect/);
  assert.match(ms(p, ['transitions']).out, /PENDING +READY BLOCKED FAILED CANCELLED/);
  assert.equal(ms(p, ['bogus']).code, 2);

  p.ok(['init', 'Inspect me']);
  p.plan([H.spec('A-001'), H.spec('B-001')]);
  p.ok(['next']);
  r = ms(p, ['show']);
  assert.equal(r.code, 0);
  assert.match(r.out, /objective: Inspect me/);
  assert.match(r.out, / {2}A-001 DISPATCHED round 0 attempts 1 retries 0/);
  r = ms(p, ['show', 'A-001']);
  assert.equal(JSON.parse(r.out).status, 'DISPATCHED');
  assert.equal(ms(p, ['show', 'Z-999']).code, 1);
  assert.equal(ms(p, ['show', '../x']).code, 1);

  r = ms(p, ['events', '--tail', '2']);
  const lines = r.out.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => JSON.parse(l).ts));
  assert.equal(ms(p, ['events', '--tail', 'x']).code, 2);

  assert.match(ms(p, ['integrity']).out, /integrity of run .*: ok/);
  const f = path.join(p.runDir(), 'tasks', 'A-001.json');
  fs.writeFileSync(f, 'garbage');
  r = ms(p, ['integrity']);
  assert.equal(r.code, 0);
  assert.match(r.out, /restored from backup: tasks\/A-001\.json/);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).task_id, 'A-001');
  fs.writeFileSync(f, 'garbage');
  fs.writeFileSync(`${f}.bak`, 'garbage');
  r = ms(p, ['integrity']);
  assert.equal(r.code, 1);
  assert.match(r.out, /problem: tasks\/A-001\.json: CORRUPT/);
  const resume = p.refused(['resume']);
  assert.match(resume, /PROBLEM: tasks\/A-001\.json: CORRUPT/);
  assert.match(resume, /NEXT: repair or remove the unreadable task files/);
});
