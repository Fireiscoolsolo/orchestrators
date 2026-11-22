'use strict';
// cliargs.cjs (pure): argument parsing for oo.cjs. No I/O.
//
// parseArgv(argv) splits command-line tokens into positionals and --options.
// parseInitText(text) extracts the init options (--mode, --max-workers, --review-rounds,
// --plan-only, --resume, --status) from free argument text; the rest is the objective.

class ArgError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgError';
    this.code = 'USAGE';
  }
}

// Options that never take a value.
const BOOLEAN_OPTIONS = new Set([
  'stdin', 'json', 'inline', 'verify', 'integrate', 'plan-only', 'resume', 'status',
  'user-authorized', 'side-effects', 'all', 'requeue-running', 'help',
  'break', 'confirm-owner-stopped', 'agent-gone', 'accept', 'pid-reused',
]);

/**
 * parseArgv(argv, {boolean}) -> {pos: string[], opts: {name: value}}
 * `--name value`, `--name=value`; boolean options are true when present. A token after `--`
 * is always positional. A repeated option keeps its last value.
 */
function parseArgv(argv, { boolean = BOOLEAN_OPTIONS } = {}) {
  const pos = [];
  const opts = {};
  const list = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--') {
      pos.push(...list.slice(i + 1));
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        const name = a.slice(2, eq);
        if (boolean.has(name)) throw new ArgError(`--${name} does not take a value`);
        opts[name] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      if (boolean.has(name)) {
        opts[name] = true;
        continue;
      }
      if (i + 1 >= list.length) throw new ArgError(`--${name} needs a value`);
      opts[name] = list[++i];
      continue;
    }
    pos.push(a);
  }
  return { pos, opts };
}

/** Throws ArgError when an option outside `allowed` was given. */
function checkAllowed(opts, allowed, command) {
  const bad = Object.keys(opts).filter((k) => !allowed.includes(k));
  if (bad.length) {
    const list = allowed.length ? allowed.map((x) => `--${x}`).join(', ') : 'none';
    throw new ArgError(`${command} does not accept ${bad.map((b) => `--${b}`).join(', ')} (accepted: ${list})`);
  }
}

const MODES = ['fast', 'balanced', 'thorough', 'maximum'];
const INIT_VALUE_FLAGS = ['mode', 'max-workers', 'review-rounds'];
const INIT_BOOL_FLAGS = ['plan-only', 'resume', 'status'];

function intIn(text, lo, hi) {
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= lo && n <= hi ? n : null;
}

/**
 * initOptionOf(token) -> {name, inline, takesValue} | null
 * The init option a single token names (`--mode`, `--mode=fast`, `--plan-only`, ...), or null
 * for anything else (including `--` and unknown `--words`).
 */
function initOptionOf(token) {
  const tok = String(token);
  if (!tok.startsWith('--') || tok === '--') return null;
  const eq = tok.indexOf('=');
  const name = eq > 2 ? tok.slice(2, eq) : tok.slice(2);
  const inline = eq > 2 ? tok.slice(eq + 1) : undefined;
  if (INIT_BOOL_FLAGS.includes(name)) return { name, inline, takesValue: false };
  if (INIT_VALUE_FLAGS.includes(name)) return { name, inline, takesValue: true };
  return null;
}

/**
 * parseInitText(text) -> {objective, mode, max_workers, review_rounds, plan_only, resume, status, errors}
 * Options are read only at the start of the text (`--mode thorough` or `--mode=thorough`, in any
 * order). The objective begins at the first word that is not an option or an option's value and
 * is kept verbatim to the end (only surrounding whitespace is trimmed), so later words that start
 * with two dashes belong to it. A bare `--` ends the options explicitly. --status and --resume
 * therefore count only before the objective. Invalid and missing values are reported in `errors`
 * (the caller exits 2).
 */
function parseInitText(text) {
  const src = String(text == null ? '' : text);
  const res = {
    objective: '', mode: null, max_workers: null, review_rounds: null,
    plan_only: false, resume: false, status: false, errors: [],
  };
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(src)) !== null) tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  let objectiveStart = src.length;
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i].text;
    if (tok === '--') {
      objectiveStart = tokens[i].end;
      break;
    }
    const opt = initOptionOf(tok);
    if (!opt) {
      objectiveStart = tokens[i].start;
      break;
    }
    i += 1;
    const name = opt.name;
    if (!opt.takesValue) {
      if (opt.inline !== undefined) res.errors.push(`--${name} does not take a value`);
      else res[name.replace('-', '_')] = true;
      continue;
    }
    let value = opt.inline;
    if (value === undefined) {
      if (i < tokens.length && !tokens[i].text.startsWith('--')) {
        value = tokens[i].text;
        i += 1;
      } else {
        res.errors.push(`--${name} needs a value`);
        continue;
      }
    }
    if (name === 'mode') {
      if (MODES.includes(value)) res.mode = value;
      else res.errors.push(`--mode must be one of ${MODES.join(', ')} (got ${JSON.stringify(value)})`);
    } else if (name === 'max-workers') {
      const n = intIn(value, 1, 20);
      if (n === null) res.errors.push(`--max-workers must be an integer from 1 to 20 (got ${JSON.stringify(value)})`);
      else res.max_workers = n;
    } else if (name === 'review-rounds') {
      const n = intIn(value, 0, 10);
      if (n === null) res.errors.push(`--review-rounds must be an integer from 0 to 10 (got ${JSON.stringify(value)})`);
      else res.review_rounds = n;
    }
  }
  res.objective = src.slice(objectiveStart).trim();
  return res;
}

module.exports = { ArgError, BOOLEAN_OPTIONS, parseArgv, checkAllowed, parseInitText, initOptionOf, MODES };
