#!/usr/bin/env node
'use strict';
/**
 * install - copy the fable-orchestrator skill and register its agent definitions.
 *
 *   node install.cjs --project <dir>     install into <dir>/.claude (project level)
 *   node install.cjs --user              install into ~/.claude (all projects)
 *   options: --agents-only  --force  --dry-run  --uninstall
 *
 * Agent files in a skill folder are not registered by Claude Code on their own;
 * this script copies them to .claude/agents/, the supported location.
 * It never overwrites an agent file it does not manage unless --force is given.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const SRC = path.resolve(__dirname, '..');
const MARKER = 'managed-by: fable-orchestrator';
const SKIP = new Set(['node_modules', '.git']);

function parse(argv) {
  const o = { project: null, user: false, agentsOnly: false, force: false, dryRun: false, uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') o.project = argv[++i];
    else if (a === '--user') o.user = true;
    else if (a === '--agents-only') o.agentsOnly = true;
    else if (a === '--force') o.force = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--uninstall') o.uninstall = true;
    else { console.error(`unknown option ${a}`); process.exit(1); }
  }
  if ((o.project ? 1 : 0) + (o.user ? 1 : 0) !== 1) {
    console.error('usage: node install.cjs (--project <dir> | --user) [--agents-only] [--force] [--dry-run] [--uninstall]');
    process.exit(1);
  }
  return o;
}

function copyDir(from, to, dry, log) {
  if (!dry) fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d, dry, log);
    else if (e.isFile()) {
      if (!dry) fs.copyFileSync(s, d);
      log.files++;
    }
  }
}

function main() {
  const o = parse(process.argv.slice(2));
  const base = o.user ? path.join(os.homedir(), '.claude') : path.join(path.resolve(o.project), '.claude');
  if (o.project && !fs.existsSync(path.resolve(o.project))) { console.error(`project directory not found: ${o.project}`); process.exit(1); }
  const skillDest = path.join(base, 'skills', 'fable-orchestrator');
  const agentsDest = path.join(base, 'agents');
  const agentsSrc = path.join(SRC, 'agents');
  const names = fs.readdirSync(agentsSrc).filter((f) => f.endsWith('.md'));
  const tag = o.dryRun ? '[dry-run] ' : '';

  if (o.uninstall) {
    for (const n of names) {
      const f = path.join(agentsDest, n);
      if (!fs.existsSync(f)) continue;
      if (!fs.readFileSync(f, 'utf8').includes(MARKER)) { console.log(`kept ${f} (not managed by fable-orchestrator)`); continue; }
      if (!o.dryRun) fs.unlinkSync(f);
      console.log(`${tag}removed ${f}`);
    }
    if (path.resolve(skillDest) !== SRC && fs.existsSync(path.join(skillDest, 'SKILL.md'))) {
      if (!o.dryRun) fs.rmSync(skillDest, { recursive: true });
      console.log(`${tag}removed ${skillDest}`);
    } else {
      console.log(`kept ${skillDest} (this is the copy the uninstaller runs from; delete it by hand if you want it gone)`);
    }
    return;
  }

  const newSkillsDir = !fs.existsSync(path.join(base, 'skills'));
  const newAgentsDir = !fs.existsSync(agentsDest);

  if (!o.agentsOnly) {
    if (path.resolve(skillDest) === SRC) {
      console.log(`skill already in place at ${skillDest}`);
    } else {
      const log = { files: 0 };
      copyDir(SRC, skillDest, o.dryRun, log);
      console.log(`${tag}skill copied to ${skillDest} (${log.files} files)`);
    }
  }

  if (!o.dryRun) fs.mkdirSync(agentsDest, { recursive: true });
  let conflicts = 0;
  for (const n of names) {
    const src = fs.readFileSync(path.join(agentsSrc, n), 'utf8');
    const dest = path.join(agentsDest, n);
    if (fs.existsSync(dest)) {
      const cur = fs.readFileSync(dest, 'utf8');
      if (cur === src) { console.log(`agent ${n}: up to date`); continue; }
      if (!cur.includes(MARKER) && !o.force) {
        console.log(`agent ${n}: SKIPPED - ${dest} exists and is not managed by fable-orchestrator (use --force to replace it)`);
        conflicts++;
        continue;
      }
    }
    if (!o.dryRun) fs.writeFileSync(dest, src);
    console.log(`${tag}agent ${n}: installed to ${dest}`);
  }

  console.log('');
  console.log(conflicts ? `${conflicts} agent file(s) were not installed; those roles fall back to general-purpose plus the role file.` : 'All agent definitions are in place.');
  if (newSkillsDir || newAgentsDir) {
    console.log('A skills or agents directory was created for the first time: restart Claude Code (or run /reload-skills for skills) so it is picked up.');
  } else {
    console.log('Claude Code picks up changed skill and agent files within a few seconds.');
  }
  console.log('Invoke with: /fable-orchestrator <request>');
}

main();
