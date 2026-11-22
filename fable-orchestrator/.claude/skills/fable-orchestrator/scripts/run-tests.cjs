#!/usr/bin/env node
'use strict';
/**
 * Portable test entry point: node scripts/run-tests.cjs [extra node --test options]
 *
 * Node releases differ in how `node --test <directory>` treats a directory argument, so this
 * script lists the test files itself, refuses to report success when it finds none, and passes
 * the explicit file list to the built-in test runner.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, 'tests');
let files = [];
try {
  files = fs.readdirSync(dir).filter((name) => name.endsWith('.test.cjs')).sort().map((name) => path.join(dir, name));
} catch (error) {
  console.error(`cannot read test directory ${dir}: ${error.message}`);
  process.exit(1);
}
if (!files.length) {
  console.error(`no test files matching *.test.cjs were found in ${dir}`);
  process.exit(1);
}
console.log(`running ${files.length} test file(s) from ${dir}`);
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
if (result.error) {
  console.error(`could not start the test runner: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
