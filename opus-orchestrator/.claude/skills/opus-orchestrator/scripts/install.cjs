#!/usr/bin/env node
'use strict';
// Installer and structure validator for the opus-orchestrator skill.
// Usage:
//   node install.cjs --project <dir> | --user  [--agents-only] [--dry-run] [--overwrite]
//   node install.cjs --validate [skillDir]
// Never edits settings files, never deletes anything.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SKILL_NAME = 'opus-orchestrator';
const SOURCE_SKILL_DIR = path.resolve(__dirname, '..');

function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function listFilesRec(dir, rel, skipTop) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (rel === '' && skipTop.includes(ent.name)) continue;
    const r = rel ? rel + '/' + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...listFilesRec(path.join(dir, ent.name), r, skipTop));
    else if (ent.isFile()) out.push(r);
  }
  return out;
}

function samePath(a, b) {
  const norm = (p) => {
    let r = path.resolve(p);
    try { r = fs.realpathSync(r); } catch (_) { /* may not exist yet */ }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function validate(skillDir) {
  const problems = [];
  const dir = path.resolve(skillDir);
  const skillMd = path.join(dir, 'SKILL.md');
  let skillText = null;
  if (!fs.existsSync(skillMd)) {
    problems.push('SKILL.md is missing');
  } else {
    skillText = fs.readFileSync(skillMd, 'utf8');
    const fm = parseFrontmatter(skillText);
    if (!fm) problems.push('SKILL.md has no frontmatter');
    else {
      if (fm.name !== SKILL_NAME) problems.push(`SKILL.md frontmatter name must be ${SKILL_NAME} (found ${JSON.stringify(fm.name || '')})`);
      if (!fm.description) problems.push('SKILL.md frontmatter description is missing or empty');
    }
  }
  const agentsDir = path.join(dir, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const f of fs.readdirSync(agentsDir).filter((n) => n.endsWith('.md')).sort()) {
      const fm = parseFrontmatter(fs.readFileSync(path.join(agentsDir, f), 'utf8'));
      if (!fm) { problems.push(`agents/${f} has no frontmatter`); continue; }
      for (const k of ['name', 'description', 'tools', 'model']) {
        if (!fm[k]) problems.push(`agents/${f} frontmatter is missing ${k}`);
      }
    }
  }
  const verFile = path.join(dir, 'VERSION');
  if (!fs.existsSync(verFile)) problems.push('VERSION is missing');
  else {
    const v = fs.readFileSync(verFile, 'utf8').trim();
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v)) problems.push(`VERSION is not a semantic version (found ${JSON.stringify(v)})`);
  }
  const refRe = /(?<![A-Za-z0-9_-])(?:references|templates|config|scripts|agents)\/[A-Za-z0-9_.\/-]*/g;
  for (const doc of ['SKILL.md', 'README.md']) {
    const p = path.join(dir, doc);
    if (!fs.existsSync(p)) continue;
    const text = doc === 'SKILL.md' && skillText !== null ? skillText : fs.readFileSync(p, 'utf8');
    const seen = new Set();
    for (const m of text.match(refRe) || []) {
      const rel = m.replace(/[.\/]+$/, '');
      if (!rel.includes('/') || seen.has(rel)) continue;
      seen.add(rel);
      if (!fs.existsSync(path.join(dir, rel))) problems.push(`${doc} mentions ${rel} which does not exist`);
    }
  }
  return problems;
}

// Never copied: proposal backups, and anything a run or a developer may have left in the source
// folder (run state, the inbox, worktrees, git data, dependencies).
const SKIP_TOP = ['history', '.claude', '.opus-inbox', '.git', 'node_modules', 'worktrees'];

function readVersion(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim();
  } catch (_) {
    return 'unknown';
  }
}

function plan(opts) {
  const home = process.env.OPUS_ORCH_HOME || os.homedir();
  const base = opts.user ? home : path.resolve(opts.project);
  const srcSkill = opts.skillDir ? path.resolve(opts.skillDir) : SOURCE_SKILL_DIR;
  const targetSkill = path.join(base, '.claude', 'skills', SKILL_NAME);
  const targetAgents = path.join(base, '.claude', 'agents');
  const actions = [];
  const conflicts = [];
  const skipSkill = opts.agentsOnly || samePath(srcSkill, targetSkill);
  if (!skipSkill) {
    // An update must not silently replace files the user changed in the installed copy (an
    // edited config, an applied improvement proposal, a newer VERSION): a file that exists with
    // different content is a conflict, replaced only with --overwrite and after a .bak copy.
    for (const rel of listFilesRec(srcSkill, '', SKIP_TOP)) {
      const from = path.join(srcSkill, rel);
      const to = path.join(targetSkill, rel);
      if (fs.existsSync(to)) {
        if (fs.readFileSync(from).equals(fs.readFileSync(to))) continue; // already up to date
        if (!opts.overwrite) { conflicts.push(to); continue; }
        actions.push({ type: 'backup', from: to, to: to + '.bak' });
      }
      actions.push({ type: 'copy', from, to });
    }
  }
  const agentSrc = path.join(srcSkill, 'agents');
  if (fs.existsSync(agentSrc)) {
    for (const f of fs.readdirSync(agentSrc).filter((n) => n.endsWith('.md')).sort()) {
      const from = path.join(agentSrc, f);
      const to = path.join(targetAgents, f);
      if (fs.existsSync(to)) {
        if (fs.readFileSync(from).equals(fs.readFileSync(to))) { actions.push({ type: 'copy', from, to }); continue; }
        if (!opts.overwrite) { conflicts.push(to); continue; }
        actions.push({ type: 'backup', from: to, to: to + '.bak' });
      }
      actions.push({ type: 'copy', from, to });
    }
  }
  return { actions, conflicts, skipSkill, targetAgents, newAgentsDir: !fs.existsSync(targetAgents), srcSkill, version: readVersion(srcSkill) };
}

function install(opts, out) {
  const srcSkill = opts.skillDir ? path.resolve(opts.skillDir) : SOURCE_SKILL_DIR;
  const problems = validate(srcSkill);
  if (problems.length) {
    for (const pr of problems) out(`PROBLEM: ${pr}`);
    out('The source is not a valid skill directory. Nothing was written.');
    return 1;
  }
  const p = plan(opts);
  out(`Installing ${SKILL_NAME} ${p.version} from ${p.srcSkill}`);
  if (p.conflicts.length) {
    for (const c of p.conflicts) out(`ERROR: ${c} exists with different content; rerun with --overwrite to replace it (a .bak copy is kept)`);
    out('Nothing was written.');
    return 1;
  }
  if (p.skipSkill) out('Skill directory copy skipped (agents only or source and target are the same path).');
  for (const a of p.actions) {
    const verb = a.type === 'backup' ? 'backup' : 'write';
    if (opts.dryRun) { out(`[dry-run] would ${verb}: ${a.to}`); continue; }
    fs.mkdirSync(path.dirname(a.to), { recursive: true });
    fs.copyFileSync(a.from, a.to);
    out(`${verb}: ${a.to}`);
  }
  if (opts.dryRun) out('Dry run: nothing was written.');
  if (p.newAgentsDir) out(`Note: ${p.targetAgents} ${opts.dryRun ? 'would be a brand-new agents directory' : 'is a brand-new agents directory'}; Claude Code must be restarted to load it.`);
  return 0;
}

function main(argv, out) {
  const opts = {};
  let validateMode = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') opts.project = argv[++i];
    else if (a === '--user') opts.user = true;
    else if (a === '--agents-only') opts.agentsOnly = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--overwrite') opts.overwrite = true;
    else if (a === '--validate') {
      validateMode = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.validateDir = argv[++i];
    } else { out(`Unknown argument: ${a}`); return 2; }
  }
  if (validateMode) {
    const dir = opts.validateDir || SOURCE_SKILL_DIR;
    const problems = validate(dir);
    if (problems.length) { for (const pr of problems) out(`PROBLEM: ${pr}`); return 1; }
    out(`OK: ${path.resolve(dir)} is a valid ${SKILL_NAME} skill directory (version ${readVersion(dir)})`);
    return 0;
  }
  if (opts.project === undefined && !opts.user) { out('Usage: install.cjs --project <dir> | --user [--agents-only] [--dry-run] [--overwrite] | --validate [skillDir]'); return 2; }
  if (opts.project === undefined && !opts.user) return 2;
  if (opts.project !== undefined && (!opts.project || opts.project.startsWith('--'))) { out('--project needs a directory'); return 2; }
  return install(opts, out);
}

module.exports = { validate, plan, install, parseFrontmatter, main, SKIP_TOP };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), (s) => console.log(s));
}
