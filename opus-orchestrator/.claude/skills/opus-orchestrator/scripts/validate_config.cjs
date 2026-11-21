#!/usr/bin/env node
'use strict';
// Usage: node validate_config.cjs [--state-config <file>]
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, validateConfig } = require('./lib/config.cjs');

function main(argv) {
  let stateConfigFile;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state-config') stateConfigFile = argv[++i];
  }
  if (stateConfigFile && !fs.existsSync(stateConfigFile)) {
    console.error(`state config file not found: ${stateConfigFile}`);
    return 1;
  }
  let cfg;
  try {
    cfg = loadConfig({ skillDir: path.resolve(__dirname, '..'), stateConfigFile });
  } catch (e) {
    console.error(`ERROR: could not load configuration: ${e.message}`);
    return 1;
  }
  const r = validateConfig(cfg);
  for (const w of r.warnings) console.log(`WARNING: ${w}`);
  for (const e of r.errors) console.log(`ERROR: ${e}`);
  if (r.ok) {
    console.log('CONFIG OK');
    return 0;
  }
  return 1;
}

process.exitCode = main(process.argv.slice(2));
