'use strict';

// security.cjs (pure): command safety guard, path scope matching, protected
// paths and secret redaction. No I/O, no clock, no process access.
//
// IMPORTANT: checkCommandSafety is a guard against obviously destructive or
// publishing commands. It is NOT a sandbox. It pattern-matches the command
// text, so an obfuscated command (variables, encodings, scripts that do the
// damage themselves) can get past it. It deliberately errs on the side of
// rejecting borderline commands.

// ---------------------------------------------------------------------------
// Command safety
// ---------------------------------------------------------------------------

// Start-of-word boundary: start of text, whitespace, a shell separator,
// a quote, a bracket or a path separator (so /usr/bin/git push is caught).
const B = '(?:^|[\\s;&|()`\'"/\\\\])';
// End-of-word boundary: not followed by a word character, dot or dash.
const E = '(?![\\w.-])';
// Anything that stays within one shell segment.
const S = '[^;&|\\n]*';
// git followed by optional global options, then the subcommand.
const GIT = B + 'git(?:\\.exe)?(?:\\s+(?:-C\\s+\\S+|-c\\s+\\S+|--[\\w-]+(?:=\\S+)?|-[\\w]+))*\\s+';

const UNSAFE_PATTERNS = [
  { name: 'git reset --hard', re: new RegExp(GIT + 'reset\\b' + S + '\\s--hard' + E) },
  { name: 'git clean', re: new RegExp(GIT + 'clean' + E) },
  { name: 'git push', re: new RegExp(GIT + 'push' + E) },
  { name: 'git checkout --', re: new RegExp(GIT + 'checkout\\b' + S + '\\s--(?=\\s|$)') },
  { name: 'git branch -D', re: new RegExp(GIT + 'branch\\b' + S + '\\s-[a-zA-Z]*D[a-zA-Z]*' + E) },
  { name: '--force', re: /(?:^|\s)--force(?:-with-lease|-if-includes)?(?![\w-])/ },
  { name: 'sudo', re: new RegExp(B + '(?:sudo|doas)' + E) },
  { name: 'download piped to a shell', re: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:env\s+)?(?:ba|z|da|k|c|tc|fi)?sh(?![\w.-])/i },
  { name: 'download executed by a shell', re: /\b(?:ba|z|da|k)?sh\b[^\n]*(?:\$\(|<\(|`)\s*(?:curl|wget)\b/i },
  { name: 'download piped to Invoke-Expression', re: /\b(?:iwr|irm|curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(?:iex|Invoke-Expression)\b/i },
  { name: 'shutdown/reboot', re: new RegExp(B + '(?:shutdown|reboot|poweroff|halt|Stop-Computer|Restart-Computer)' + E, 'i') },
  { name: 'mkfs', re: new RegExp(B + 'mkfs(?:\\.\\w+)?' + '(?![\\w-])') },
  // For the next three the command word is followed by a lookahead (?=\s) instead of
  // consuming the space, so that S can start empty and "\s<arg>" still finds the
  // argument when it is the first one (e.g. "del /s x", "chmod -R 777 /").
  { name: 'dd of=/dev', re: new RegExp(B + 'dd(?=\\s)' + S + '\\sof=/dev/') },
  { name: 'format <drive>:', re: new RegExp(B + 'format(?:\\.com)?\\s+[a-z]:', 'i') },
  { name: 'del /s', re: new RegExp(B + '(?:del|erase|rd|rmdir)(?=\\s)' + S + '\\s/s' + E, 'i') },
  { name: 'chmod -R 777', re: new RegExp(B + 'chmod(?=\\s)(?=' + S + '\\s(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)' + E + ')(?=' + S + '\\s(?:0?777|a\\+rwx|ugo\\+rwx)' + E + ')') },
  { name: 'fork bomb', re: /([\w:]+)\s*\(\s*\)\s*\{[^}]*?\1\s*\|\s*&?\s*\1\s*&/ },
  { name: 'fork bomb', re: /%0\s*\|\s*%0/ },
  { name: 'npm publish', re: new RegExp(B + '(?:npm|pnpm|yarn|bun)\\s' + S + '\\b(?:un)?publish' + E) },
  { name: 'cargo publish', re: new RegExp(B + 'cargo\\s' + S + '\\bpublish' + E) },
  { name: 'twine upload', re: new RegExp(B + 'twine\\s' + S + '\\bupload' + E) },
  { name: 'docker push', re: new RegExp(B + '(?:docker|podman)\\s' + S + '\\bpush' + E) },
  { name: 'terraform apply/destroy', re: new RegExp(B + 'terraform\\s' + S + '\\b(?:apply|destroy)' + E) },
  { name: 'kubectl apply/delete', re: new RegExp(B + 'kubectl\\s' + S + '\\b(?:apply|delete)' + E) },
];

const REMOVE_COMMANDS = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']);

function splitSegments(cmd) {
  return cmd.split(/&&|\|\||[;&|\n()`]|\$\(/).map((s) => s.trim()).filter(Boolean);
}

function tokens(segment) {
  return segment.split(/\s+/).filter(Boolean).map((t) => t.replace(/^['"]+|['"]+$/g, ''));
}

function isRecursiveFlag(tok) {
  if (/^--recursive$/i.test(tok)) return true;
  if (/^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(tok)) return true; // PowerShell -Recurse and abbreviations
  if (/^-[a-zA-Z]{1,4}$/.test(tok) && /[rR]/.test(tok)) return true; // -rf, -fr, -Rf, -rfv (not -Force: 5 letters)
  if (/^\/s$/i.test(tok)) return true; // rd /s
  return false;
}

// A removal target that is a filesystem root, a home directory, the current
// or parent directory, or a bare wildcard over one of these.
function isDangerousTarget(tok) {
  let t = String(tok).replace(/\\/g, '/');
  t = t.replace(/^-(?:path|literalpath):?/i, '');
  // strip trailing wildcards and slashes: "/*" -> "", "./*" -> ".", "~/" -> "~"
  t = t.replace(/(?:\/|\*)+$/, '');
  if (t === '' || t === '~' || t === '.' || t === '..') return true;
  if (/^[A-Za-z]:$/.test(t)) return true;
  if (/^(?:\$HOME|\$\{HOME\}|\$env:(?:USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|SystemDrive|SystemRoot)|%(?:USERPROFILE|HOMEDRIVE|HOMEPATH|SystemDrive|SystemRoot)%)$/i.test(t)) return true;
  if (/^~[\w.-]*$/.test(t)) return true; // ~user
  if (/^(?:[A-Za-z]:)?\/(?:home|Users)(?:\/[^/]+)?$/i.test(t)) return true;
  if (/^\/(?:root|etc|usr|var|bin|boot|lib|opt|System)$/i.test(t)) return true;
  if (/^[A-Za-z]:\/(?:Windows|Program Files(?: \(x86\))?)$/i.test(t)) return true;
  return false;
}

function checkRecursiveRemoval(cmd) {
  for (const seg of splitSegments(cmd)) {
    const toks = tokens(seg);
    for (let i = 0; i < toks.length; i++) {
      const base = toks[i].replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');
      if (!REMOVE_COMMANDS.has(base)) continue;
      const args = toks.slice(i + 1);
      if (args.some((a) => /^--no-preserve-root$/i.test(a))) return 'rm --no-preserve-root';
      const recursive = args.some(isRecursiveFlag);
      if (!recursive) continue;
      const targets = args.filter((a) => !/^-/.test(a) && !/^\/s$/i.test(a) && !/^\/q$/i.test(a));
      // PowerShell -Path <x>: the value is already in targets because it does not start with "-".
      if (targets.some(isDangerousTarget)) return 'recursive removal of a root, home, current directory or wildcard';
    }
  }
  return null;
}

function toRegExp(p) {
  if (p instanceof RegExp) return p;
  if (typeof p !== 'string' || p === '') return null;
  try {
    return new RegExp(p, 'i');
  } catch (_) {
    return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

/**
 * Checks a shell command against the unsafe patterns.
 * extraPatterns: regular-expression sources (strings, matched case-insensitively;
 * an invalid source is matched as a literal substring) or RegExp objects.
 * @returns {{safe: boolean, reason: string|null}}
 */
function checkCommandSafety(cmd, extraPatterns = []) {
  if (typeof cmd !== 'string' || cmd.trim() === '') {
    return { safe: false, reason: 'empty or non-string command' };
  }
  const text = cmd.replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+/g, ' ').trim();
  for (const p of UNSAFE_PATTERNS) {
    if (p.re.test(text)) return { safe: false, reason: `matches unsafe pattern: ${p.name}` };
  }
  const removal = checkRecursiveRemoval(text);
  if (removal) return { safe: false, reason: `matches unsafe pattern: ${removal}` };
  for (const extra of Array.isArray(extraPatterns) ? extraPatterns : []) {
    const re = toRegExp(extra);
    if (re && re.test(text)) return { safe: false, reason: `matches configured unsafe pattern: ${String(extra)}` };
  }
  return { safe: true, reason: null };
}

// ---------------------------------------------------------------------------
// Paths and scopes
// ---------------------------------------------------------------------------

/** Forward slashes, no duplicate slashes, no leading "./", no "." segments. ".." is kept. */
function normalizePath(p) {
  let s = String(p == null ? '' : p).trim().replace(/\\/g, '/');
  s = s.replace(/\/{2,}/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  if (s === '.') return '';
  s = s.replace(/\/\.(?=\/)/g, '').replace(/\/\.$/, '/');
  return s;
}

function hasTraversal(p) {
  return p.split('/').includes('..');
}

function isAbsolute(p) {
  return p.startsWith('/') || /^[A-Za-z]:/.test(p);
}

function isGlob(p) {
  return /[*?]/.test(p);
}

function globToRegExp(glob) {
  let g = glob;
  if (g.endsWith('/')) g += '**'; // a directory glob matches everything below it
  let re = '^';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(re + '$');
}

function toList(scopes) {
  if (scopes == null) return [];
  return (Array.isArray(scopes) ? scopes : [scopes]).filter((s) => typeof s === 'string').map(normalizePath).filter(Boolean);
}

function entryMatches(file, entry) {
  if (isGlob(entry)) return globToRegExp(entry).test(file);
  if (entry.endsWith('/')) return file.startsWith(entry) || file + '/' === entry;
  return file === entry;
}

/**
 * True when the file lies inside the scope list. Paths with ".." segments or
 * absolute paths are never in scope.
 */
function fileInScope(file, scopes) {
  if (typeof file !== 'string') return false;
  const f = normalizePath(file);
  if (!f || hasTraversal(f) || isAbsolute(f)) return false;
  return toList(scopes).some((s) => !hasTraversal(s) && entryMatches(f, s));
}

/** Files of the list that are not inside the scopes (normalized). */
function outOfScope(files, scopes) {
  const list = Array.isArray(files) ? files : files == null ? [] : [files];
  return list.filter((f) => !fileInScope(f, scopes)).map((f) => (typeof f === 'string' ? normalizePath(f) : String(f)));
}

function literalPrefix(entry) {
  const i = entry.search(/[*?]/);
  return i === -1 ? entry : entry.slice(0, i);
}

function entriesOverlap(x, y) {
  if (x === y) return true;
  const gx = isGlob(x);
  const gy = isGlob(y);
  if (!gx && !gy) {
    const dx = x.endsWith('/');
    const dy = y.endsWith('/');
    if (dx && (y.startsWith(x) || y + '/' === x)) return true;
    if (dy && (x.startsWith(y) || x + '/' === y)) return true;
    return false;
  }
  if (gx && gy) {
    const px = literalPrefix(x);
    const py = literalPrefix(y);
    return px.startsWith(py) || py.startsWith(px);
  }
  const glob = gx ? x : y;
  const lit = gx ? y : x;
  if (globToRegExp(glob).test(lit)) return true;
  if (lit.endsWith('/')) {
    // Conservative: the glob could match something below the directory.
    const p = literalPrefix(glob);
    return p.startsWith(lit) || lit.startsWith(p);
  }
  return false;
}

/**
 * Conservative overlap test between two scope lists: true when any entry of
 * one could match a path that an entry of the other also covers. An empty
 * scope overlaps nothing.
 */
function scopesOverlap(a, b) {
  const la = toList(a);
  const lb = toList(b);
  if (la.length === 0 || lb.length === 0) return false;
  return la.some((x) => lb.some((y) => entriesOverlap(x, y)));
}

/**
 * True when the path matches a protected pattern. Patterns without "/" are
 * matched against every path segment (so "*secret*" protects
 * "config/secrets/a.txt"); patterns with "/" against the whole path.
 */
function isProtectedPath(file, patterns) {
  if (typeof file !== 'string') return false;
  const f = normalizePath(file).replace(/\/+$/, '');
  if (!f) return false;
  const segments = f.split('/');
  for (const raw of Array.isArray(patterns) ? patterns : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const p = normalizePath(raw);
    if (p.replace(/\/+$/, '').includes('/')) {
      if (entryMatches(f, p) || entryMatches(f + '/', p)) return true;
    } else {
      const re = globToRegExp(p.replace(/\/+$/, ''));
      if (segments.some((s) => re.test(s))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const REDACTED = '[REDACTED]';

const SECRET_RULES = [
  {
    kind: 'private_key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: () => REDACTED,
  },
  {
    kind: 'bearer_token',
    re: /\b(Bearer)(\s+)([A-Za-z0-9\-._~+/]{8,}=*)/gi,
    // Require a digit or a long token so that prose such as "Bearer authentication" stays.
    test: (m) => /\d/.test(m[3]) || m[3].length >= 24,
    replace: (m) => `${m[1]}${m[2]}${REDACTED}`,
  },
  {
    kind: 'api_key',
    re: new RegExp(
      [
        '\\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}',
        '\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}',
        '\\bgithub_pat_[A-Za-z0-9_]{20,}',
        '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b',
        '\\bAIza[0-9A-Za-z_-]{35}',
        '\\bxox[abprs]-[A-Za-z0-9-]{10,}',
        '\\bglpat-[A-Za-z0-9_-]{20,}',
        '\\bnpm_[A-Za-z0-9]{36}\\b',
        '\\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}',
        // generic: a long token mixing upper case, lower case and digits (not a lowercase hex hash)
        '\\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\\d)[A-Za-z0-9_-]{32,}\\b',
      ].join('|'),
      'g'
    ),
    replace: () => REDACTED,
  },
  {
    kind: 'assignment',
    // NAME=value, or NAME: value where NAME is identifier-like (has "_" or is upper case).
    // The prefix may end in one or two dashes so command-line flags are covered:
    // --password=x, --api-key=x and -DDB_PASSWORD=x (the dashes stay in the output).
    re: /((?:^|[^\w.-])-{0,2})([A-Za-z_][\w.-]*)(\s*=\s*|:[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"'&;,]+)/g,
    test: (m) => {
      const name = m[2];
      const sep = m[3];
      const value = m[4].replace(/^["']|["']$/g, '');
      if (!/KEY|TOKEN|SECRET|PASSWORD|PASSWD/i.test(name)) return false;
      if (sep.trim() === ':' && !(name.includes('_') || name === name.toUpperCase())) return false;
      if (value === '' || value === REDACTED || value.includes(REDACTED)) return false;
      if (/^\d{1,7}$/.test(value)) return false; // max_tokens=4096 is a setting, not a secret
      if (/^(?:null|none|true|false|~|undefined)$/i.test(value)) return false;
      if (/^\$/.test(value) || /^%[\w]+%$/.test(value)) return false; // a variable reference
      return true;
    },
    replace: (m) => `${m[1]}${m[2]}${m[3]}${REDACTED}`,
  },
];

function scanSecrets(text) {
  let out = String(text == null ? '' : text);
  const found = [];
  for (const rule of SECRET_RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (...args) => {
      // args = [match, group1..groupN, offset, input] (no named groups are used)
      const m = args.slice(0, args.length - 2);
      if (rule.test && !rule.test(m)) return m[0];
      found.push({ kind: rule.kind });
      return rule.replace(m);
    });
  }
  return { text: out, found };
}

/** Replaces secret-looking content with [REDACTED]. Non-strings are converted with String(). */
function redactSecrets(text) {
  return scanSecrets(text).text;
}

/** One {kind} entry per secret found; the secret itself is never returned. */
function findSecrets(text) {
  return scanSecrets(text).found;
}

module.exports = {
  checkCommandSafety,
  normalizePath,
  fileInScope,
  outOfScope,
  scopesOverlap,
  isProtectedPath,
  redactSecrets,
  findSecrets,
  UNSAFE_PATTERNS,
};
