#!/usr/bin/env node
'use strict';
// Validates a worker result, review report or correction request against its
// task specification (DESIGN.md 4.8 / 4.9).
//
// Usage:
//   node verify_results.cjs result <result.yaml> --spec <spec.yaml>
//   node verify_results.cjs review <review.yaml> --spec <spec.yaml>
//   node verify_results.cjs correction <correction.yaml> --spec <spec.yaml> [--round N]
//
// The report file may be plain YAML or a free-text message ending in a fenced
// yaml block. The spec file may hold several specifications (documents
// separated by "---", or a list); the one whose task_id matches the report is used.
// Exit codes: 0 valid, 1 invalid (errors printed), 2 usage error.

const fs = require('node:fs');
const yaml = require('./lib/yaml.cjs');
const { validateSpec } = require('./lib/spec.cjs');
const reports = require('./lib/reports.cjs');
const { redactSecrets } = require('./lib/security.cjs');

const USAGE = 'usage: node verify_results.cjs result|review|correction <file> --spec <spec.yaml> [--round N]';

function readText(file, what) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${what} file ${file}: ${e.code || e.message}`);
  }
}

function parseReport(text) {
  const block = yaml.extractYamlBlock(text);
  return yaml.parse(block !== null ? block : text);
}

function loadSpecs(text) {
  const out = [];
  for (const doc of yaml.parseAll(text)) {
    if (Array.isArray(doc)) out.push(...doc);
    else if (doc !== null && doc !== undefined) out.push(doc);
  }
  return out;
}

function main(argv) {
  const [kind, file, ...rest] = argv;
  let specFile = null;
  let round = 1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--spec') specFile = rest[++i];
    else if (rest[i] === '--round') round = Number(rest[++i]);
    else {
      console.error(`unknown argument: ${rest[i]}\n${USAGE}`);
      return 2;
    }
  }
  if (!['result', 'review', 'correction'].includes(kind) || !file || !specFile || !Number.isInteger(round) || round < 1) {
    console.error(USAGE);
    return 2;
  }

  let report;
  let specs;
  try {
    report = parseReport(readText(file, kind));
    specs = loadSpecs(readText(specFile, 'spec'));
  } catch (e) {
    console.log(`ERROR: ${redactSecrets(e.message)}`);
    return 1;
  }

  const wanted = report && typeof report === 'object' && !Array.isArray(report) ? report.task_id : undefined;
  let raw = specs.find((s) => s && s.task_id === wanted);
  if (!raw && specs.length === 1) raw = specs[0];
  if (!raw) {
    console.log(`ERROR: no specification for task ${JSON.stringify(wanted)} in ${specFile}`);
    return 1;
  }
  const sv = validateSpec(raw);
  if (!sv.ok) {
    for (const e of sv.errors) console.log(`ERROR: spec: ${redactSecrets(e)}`);
    return 1;
  }

  let r;
  if (kind === 'result') r = reports.validateAgentResult(report, sv.spec);
  else if (kind === 'review') r = reports.validateReview(report, sv.spec);
  else r = reports.validateCorrection(report, sv.spec, { round });

  if (!r.ok) {
    for (const e of r.errors) console.log(`ERROR: ${e}`);
    console.log(`${kind.toUpperCase()} INVALID (${r.errors.length} error${r.errors.length === 1 ? '' : 's'})`);
    return 1;
  }
  console.log(`${kind.toUpperCase()} OK for ${sv.spec.task_id}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
