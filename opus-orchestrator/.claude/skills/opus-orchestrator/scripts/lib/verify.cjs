'use strict';

// verify.cjs (child_process): runs verification commands through a shell,
// checks changed files against a task's scope and computes the verification
// verdict (DESIGN.md 4.9).
//
// Every command is checked with security.checkCommandSafety before it runs;
// an unsafe command is never executed. That check is a pattern guard, not a
// sandbox: a command that is allowed runs with the full rights of this process.
//
// Each command runs as `<shell> -c "<command>"` (no extra quoting layer). The
// shell is started by a small Node runner process (itself started with
// spawnSync) so that, on timeout, the whole process tree is terminated:
// spawnSync's own timeout only kills the shell, and on Windows a program the
// shell started would keep running.

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const security = require('./security.cjs');

const TAIL_LINES = 40;
const DEFAULT_TIMEOUT_MS = 600 * 1000;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024; // output kept per command (oldest output is dropped first)
const RUNNER_GRACE_MS = 30 * 1000; // extra time the runner gets beyond the command timeout

const GIT_BASH_LOCATIONS = [
  'C:/Program Files/Git/bin/bash.exe',
  'C:/Program Files/Git/usr/bin/bash.exe',
];

// ---------------------------------------------------------------------------
// Shell detection
// ---------------------------------------------------------------------------

function shellKind(shell) {
  const base = path.basename(String(shell)).toLowerCase().replace(/\.exe$/, '');
  if (base === 'cmd') return 'cmd';
  if (base === 'powershell' || base === 'pwsh') return 'powershell';
  return 'posix';
}

function argsFor(shell) {
  switch (shellKind(shell)) {
    case 'cmd': return ['/d', '/s', '/c'];
    case 'powershell': return ['-NoProfile', '-NonInteractive', '-Command'];
    default: return ['-c'];
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

// On Windows, System32\bash.exe and the WindowsApps alias start WSL, which runs
// commands in a Linux environment with different paths. They are skipped.
function isWslLauncher(file) {
  const f = file.replace(/\\/g, '/').toLowerCase();
  const sysRoot = String(process.env.SystemRoot || process.env.windir || 'C:/Windows').replace(/\\/g, '/').toLowerCase();
  return f.startsWith(sysRoot + '/') || f.includes('/windowsapps/');
}

function bashOnPath() {
  const names = process.platform === 'win32' ? ['bash.exe'] : ['bash'];
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir.replace(/^"|"$/g, ''), name);
      if (!isFile(file)) continue;
      if (process.platform === 'win32' && isWslLauncher(file)) continue;
      return file;
    }
  }
  return null;
}

function gitBashLocations() {
  const list = GIT_BASH_LOCATIONS.slice();
  for (const v of ['ProgramFiles', 'ProgramW6432', 'LOCALAPPDATA']) {
    const base = process.env[v];
    if (!base) continue;
    const root = v === 'LOCALAPPDATA' ? path.join(base, 'Programs', 'Git') : path.join(base, 'Git');
    list.push(path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe'));
  }
  return list;
}

/**
 * The shell used for verification commands: OPUS_ORCH_SHELL when set, else
 * bash from PATH, else Git for Windows bash at a standard location, else the
 * platform default shell (ComSpec / cmd.exe on Windows, /bin/sh elsewhere).
 * @returns {{shell: string, args: string[], source: 'env'|'path'|'git-for-windows'|'platform-default'}}
 */
function findShell() {
  const env = process.env.OPUS_ORCH_SHELL;
  if (env && env.trim()) return { shell: env.trim(), args: argsFor(env.trim()), source: 'env' };
  const onPath = bashOnPath();
  if (onPath) return { shell: onPath, args: ['-c'], source: 'path' };
  if (process.platform === 'win32') {
    for (const p of gitBashLocations()) {
      if (isFile(p)) return { shell: p, args: ['-c'], source: 'git-for-windows' };
    }
    const comspec = process.env.ComSpec || 'cmd.exe';
    return { shell: comspec, args: argsFor(comspec), source: 'platform-default' };
  }
  return { shell: '/bin/sh', args: ['-c'], source: 'platform-default' };
}

// ---------------------------------------------------------------------------
// Running commands
// ---------------------------------------------------------------------------

// Runner executed with `node -e`. Reads {shell, args, cwd, timeout_ms,
// max_bytes, verbatim} as JSON on stdin, runs the shell, collects stdout and
// stderr in arrival order, kills the process tree on timeout and prints one
// JSON object on stdout.
const RUNNER = String.raw`
'use strict';
const cp = require('child_process');
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try { cp.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
  }
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const o = JSON.parse(input);
  const chunks = [];
  let size = 0;
  let truncated = false;
  const add = (b) => {
    chunks.push(b);
    size += b.length;
    while (size > o.max_bytes && chunks.length > 1) { size -= chunks.shift().length; truncated = true; }
  };
  const t0 = Date.now();
  let timedOut = false;
  let done = false;
  let exitInfo = null;
  const finish = (code, signal, error) => {
    if (done) return;
    done = true;
    const out = JSON.stringify({ exit_code: code, signal: signal || null, timed_out: timedOut, error: error || null,
      duration_ms: Date.now() - t0, output: Buffer.concat(chunks).toString('utf8'), truncated });
    process.stdout.write(out, () => process.exit(0));
  };
  let child;
  try {
    child = cp.spawn(o.shell, o.args, { cwd: o.cwd, windowsHide: true, windowsVerbatimArguments: !!o.verbatim,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    finish(null, null, e.message);
    return;
  }
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  child.on('error', (e) => finish(null, null, e.message));
  child.on('exit', (code, signal) => {
    exitInfo = [code, signal];
    // A background process may keep the pipes open; do not wait for it forever.
    setTimeout(() => finish(code, signal), 2000);
  });
  child.on('close', (code, signal) => finish(code, signal));
  setTimeout(() => {
    timedOut = true;
    killTree(child.pid);
    setTimeout(() => finish(exitInfo ? exitInfo[0] : null, exitInfo ? exitInfo[1] : 'SIGKILL'), 3000);
  }, o.timeout_ms);
});
`;

function tailLines(text, n) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n');
}

function runOne(command, sh, cwd, timeoutMs) {
  const verbatim = shellKind(sh.shell) === 'cmd';
  const args = sh.args.concat(verbatim ? [`"${command}"`] : [command]);
  const input = JSON.stringify({ shell: sh.shell, args, cwd, timeout_ms: timeoutMs, max_bytes: MAX_CAPTURE_BYTES, verbatim });
  const t0 = Date.now();
  const r = cp.spawnSync(process.execPath, ['-e', RUNNER], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: MAX_CAPTURE_BYTES * 8,
    timeout: timeoutMs + RUNNER_GRACE_MS,
  });
  const entry = { command, exit_code: null, duration_ms: Date.now() - t0, timed_out: false, refused: false, reason: null, output_tail: '' };
  let data = null;
  try {
    data = JSON.parse(r.stdout);
  } catch (_) {
    data = null;
  }
  if (!data) {
    entry.timed_out = !!(r.error && r.error.code === 'ETIMEDOUT');
    entry.reason = entry.timed_out
      ? `timed out after ${timeoutMs} ms (runner did not finish)`
      : `command runner failed: ${r.error ? r.error.message : `exit ${r.status}`}`;
    entry.output_tail = tailLines(security.redactSecrets(String(r.stderr || '')), TAIL_LINES);
    return entry;
  }
  entry.exit_code = Number.isInteger(data.exit_code) ? data.exit_code : null;
  entry.duration_ms = Number.isFinite(data.duration_ms) ? data.duration_ms : entry.duration_ms;
  entry.timed_out = data.timed_out === true;
  if (entry.timed_out) entry.reason = `timed out after ${timeoutMs} ms; process tree terminated`;
  else if (data.error) entry.reason = `could not start the shell ${sh.shell}: ${data.error}`;
  else if (entry.exit_code === null && data.signal) entry.reason = `terminated by signal ${data.signal}`;
  // Redact the whole output before cutting it, so a secret spanning the cut is still caught.
  entry.output_tail = tailLines(security.redactSecrets(data.output || ''), TAIL_LINES);
  if (entry.reason) entry.reason = security.redactSecrets(entry.reason);
  return entry;
}

function commandPassed(c) {
  return c.refused !== true && c.timed_out !== true && c.exit_code === 0;
}

/**
 * Runs each command (after a safety check) in `cwd` through findShell().
 * @param {string[]} commands
 * @param {{cwd?: string, timeout_ms?: number, extraUnsafe?: Array<string|RegExp>}} opts
 * @returns {{passed: boolean|null, shell: string|null, commands: Array<{command, exit_code, duration_ms, timed_out, refused, reason, output_tail}>}}
 */
function runCommands(commands, { cwd = process.cwd(), timeout_ms = DEFAULT_TIMEOUT_MS, extraUnsafe = [] } = {}) {
  const list = Array.isArray(commands) ? commands : commands == null ? [] : [commands];
  if (list.length === 0) return { passed: null, shell: null, commands: [] };
  const timeoutMs = Number.isFinite(timeout_ms) && timeout_ms > 0 ? Math.floor(timeout_ms) : DEFAULT_TIMEOUT_MS;
  const sh = findShell();
  const cwdOk = (() => {
    try {
      return fs.statSync(cwd).isDirectory();
    } catch (_) {
      return false;
    }
  })();
  const results = [];
  for (const command of list) {
    const safety = security.checkCommandSafety(command, extraUnsafe);
    if (!safety.safe) {
      results.push({
        command: typeof command === 'string' ? security.redactSecrets(command) : String(command),
        exit_code: null,
        duration_ms: 0,
        timed_out: false,
        refused: true,
        reason: `refused: ${safety.reason}`,
        output_tail: '',
      });
      continue;
    }
    if (!cwdOk) {
      results.push({ command: security.redactSecrets(command), exit_code: null, duration_ms: 0, timed_out: false, refused: false,
        reason: `working directory does not exist: ${cwd}`, output_tail: '' });
      continue;
    }
    const entry = runOne(command, sh, cwd, timeoutMs);
    entry.command = security.redactSecrets(command);
    results.push(entry);
  }
  return { passed: results.every(commandPassed), shell: sh.shell, commands: results };
}

// ---------------------------------------------------------------------------
// Scope and verdict
// ---------------------------------------------------------------------------

/** Changed files that lie outside the authorized files. */
function checkScope(changedFiles, authorizedFiles) {
  const violations = security.outOfScope(Array.isArray(changedFiles) ? changedFiles : [], authorizedFiles || []);
  return { ok: violations.length === 0, violations };
}

/**
 * passed only when no command failed or was refused, no manual check has
 * result "fail", the scope is ok and at least one command or manual check
 * exists. reasons explains the outcome.
 */
function verdict({ commandsResult = null, checks = [], scope = null } = {}) {
  const reasons = [];
  const cmds = commandsResult && Array.isArray(commandsResult.commands) ? commandsResult.commands : [];
  const manual = Array.isArray(checks) ? checks : [];

  for (const c of cmds) {
    if (c.refused) reasons.push(`command refused: ${c.command} (${c.reason || 'unsafe'})`);
    else if (c.timed_out) reasons.push(`command timed out: ${c.command}`);
    else if (c.exit_code !== 0) reasons.push(`command failed (exit ${c.exit_code === null ? 'none' : c.exit_code}): ${c.command}`);
  }
  for (const ch of manual) {
    if (ch && ch.result === 'fail') reasons.push(`manual check failed: ${ch.name}${ch.note ? ` (${ch.note})` : ''}`);
  }
  if (!scope || typeof scope !== 'object') {
    reasons.push('scope was not checked');
  } else if (scope.ok !== true) {
    const v = Array.isArray(scope.violations) ? scope.violations : [];
    reasons.push(`files changed outside the authorized scope: ${v.length ? v.join(', ') : '(unspecified)'}`);
  }
  if (cmds.length === 0 && manual.length === 0) {
    reasons.push('no verification command and no manual check was recorded');
  }

  if (reasons.length > 0) return { passed: false, reasons };
  const ok = [];
  if (cmds.length) ok.push(`${cmds.length} command(s) passed`);
  if (manual.length) ok.push(`${manual.length} manual check(s) recorded, none failed`);
  ok.push('all changed files are inside the authorized scope');
  return { passed: true, reasons: ok };
}

module.exports = {
  findShell,
  runCommands,
  checkScope,
  verdict,
  TAIL_LINES,
};
