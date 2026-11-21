#!/usr/bin/env node
'use strict';
// Runs every tests/*.test.cjs with node --test. Extra arguments are file-name filters.
// Optional --dir <testsDir>. Exit code 0 only when every test file passed.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
let dir = path.resolve(__dirname, '..', 'tests');
const filters = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir') dir = path.resolve(args[++i] || '');
  else filters.push(args[i]);
}

let files = [];
try {
  files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.cjs')).sort();
} catch (e) {
  console.error(`Cannot read tests directory ${dir}: ${e.message}`);
  process.exit(1);
}
if (filters.length) files = files.filter((f) => filters.some((x) => f.includes(x)));
if (!files.length) {
  console.error(`No test files matched in ${dir}`);
  process.exit(1);
}

const env = { ...process.env };
delete env.NODE_TEST_CONTEXT; // a nested runner must not behave as a subtest of an outer one
const r = spawnSync(process.execPath, ['--test', ...files.map((f) => path.join(dir, f))], { stdio: 'inherit', env });
if (r.error) { console.error(r.error.message); process.exit(1); }
process.exit(r.status === 0 ? 0 : 1);
