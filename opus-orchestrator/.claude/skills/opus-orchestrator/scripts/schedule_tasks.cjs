#!/usr/bin/env node
'use strict';
// Usage: node schedule_tasks.cjs <specs.yaml> [--max-workers N]
const fs = require('node:fs');
const { parseAll } = require('./lib/yaml.cjs');
const { validateSpec, validatePlan } = require('./lib/spec.cjs');
const S = require('./lib/scheduler.cjs');

function main(argv) {
  let file = null;
  let maxWorkers = 5;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max-workers') {
      maxWorkers = Number(argv[++i]);
      if (!Number.isInteger(maxWorkers) || maxWorkers < 1) {
        console.error('--max-workers needs a positive integer');
        return 2;
      }
    } else if (!file) file = argv[i];
    else { console.error(`unexpected argument: ${argv[i]}`); return 2; }
  }
  if (!file) { console.error('usage: schedule_tasks.cjs <specs.yaml> [--max-workers N]'); return 2; }
  if (!fs.existsSync(file)) { console.error(`file not found: ${file}`); return 1; }

  let docs;
  try { docs = parseAll(fs.readFileSync(file, 'utf8')).filter((d) => d !== null && d !== undefined); }
  catch (e) { console.error(`cannot parse ${file}: ${e.message}`); return 1; }

  const errors = [];
  const specs = [];
  for (const raw of docs) {
    const r = validateSpec(raw, {});
    if (!r.ok) {
      const id = raw && raw.task_id ? raw.task_id : '(no task_id)';
      for (const e of r.errors) errors.push(`${id}: ${e}`);
    } else specs.push(r.spec);
  }
  // Use raw documents for graph checks so cycles are named even when other fields are invalid.
  const tasks = docs
    .filter((d) => d && typeof d === 'object' && typeof d.task_id === 'string')
    .map((s) => ({
      ...s,
      status: 'PENDING',
      dependencies: Array.isArray(s.dependencies) ? s.dependencies : [],
      authorized_files: Array.isArray(s.authorized_files) ? s.authorized_files : [],
    }));

  for (const c of S.findCycles(tasks)) errors.push(`dependency cycle: ${c.concat(c[0]).join(' -> ')}`);
  for (const m of S.missingDependencies(tasks)) {
    errors.push(`${m.task_id} depends on unknown task ${m.missing.join(', ')}`);
  }
  if (!errors.length) {
    const plan = validatePlan(specs);
    if (!plan.ok) errors.push(...plan.errors);
  }
  if (errors.length) {
    for (const e of errors) console.error(`ERROR: ${e}`);
    return 1;
  }

  const waves = S.planWaves(tasks, maxWorkers);
  console.log(`Waves (max_workers ${maxWorkers}):`);
  waves.forEach((w, i) => console.log(`  ${i + 1}. ${w.join(', ')}`));
  const cp = S.criticalPath(tasks);
  const order = [...tasks].sort((a, b) =>
    (cp[b.task_id].chain - cp[a.task_id].chain) ||
    (cp[b.task_id].downstream - cp[a.task_id].downstream) ||
    (a.task_id < b.task_id ? -1 : 1));
  console.log('Critical-path order (longest chain first):');
  for (const t of order) {
    console.log(`  ${t.task_id}  chain=${cp[t.task_id].chain} downstream=${cp[t.task_id].downstream}`);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
