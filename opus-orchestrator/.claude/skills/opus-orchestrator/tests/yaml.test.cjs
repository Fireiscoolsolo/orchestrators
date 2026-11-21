'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parse, parseAll, stringify, extractYamlBlock, YamlError } = require(path.join(__dirname, '..', 'scripts', 'lib', 'yaml.cjs'));

function throwsYaml(fn, lineCheck) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof YamlError, `expected YamlError, got ${e && e.name}: ${e && e.message}`);
    assert.equal(e.code, 'YAML');
    assert.equal(typeof e.line, 'number');
    if (lineCheck !== undefined) assert.equal(e.line, lineCheck);
    return true;
  });
}

// ---- basic constructs ----

test('scalars: strings, numbers, booleans, null forms', () => {
  assert.deepEqual(parse('a: hello world\nb: 42\nc: -7\nd: 3.14\ne: -0.5\nf: true\ng: false\nh: null\ni: ~\nj:\n'),
    { a: 'hello world', b: 42, c: -7, d: 3.14, e: -0.5, f: true, g: false, h: null, i: null, j: null });
});

test('only decimal integers and floats convert; others stay strings', () => {
  const v = parse('a: 1.2.3\nb: 0x10\nc: 2026-11-14\nd: 007\ne: +5\nf: .5\ng: 1e5\nh: True\ni: 12345678901234567890\n');
  assert.deepEqual(v, { a: '1.2.3', b: '0x10', c: '2026-11-14', d: '007', e: '+5', f: '.5', g: '1e5', h: 'True', i: '12345678901234567890' });
});

test('nested mappings', () => {
  assert.deepEqual(parse('a:\n  b:\n    c: 1\n  d: 2\ne: 3\n'), { a: { b: { c: 1 }, d: 2 }, e: 3 });
});

test('block sequences of scalars', () => {
  assert.deepEqual(parse('- a\n- 1\n- true\n- null\n'), ['a', 1, true, null]);
  assert.deepEqual(parse('k:\n  - a\n  - b\n'), { k: ['a', 'b'] });
});

test('sequence at same indent as its parent key', () => {
  assert.deepEqual(parse('k:\n- a\n- b\nz: 1\n'), { k: ['a', 'b'], z: 1 });
});

test('sequences of mappings', () => {
  const v = parse('items:\n  - name: a\n    n: 1\n  - name: b\n    sub:\n      x: y\n  -   name: c\n      n: 3\n');
  assert.deepEqual(v, { items: [{ name: 'a', n: 1 }, { name: 'b', sub: { x: 'y' } }, { name: 'c', n: 3 }] });
});

test('nested sequences and "-" with value on following lines', () => {
  assert.deepEqual(parse('- - a\n  - b\n- - c\n'), [['a', 'b'], ['c']]);
  assert.deepEqual(parse('-\n  a: 1\n-\n- x\n'), [{ a: 1 }, null, 'x']);
});

test('quoted keys such as "1-2", keys with dots and dashes', () => {
  const v = parse('"1-2": 1.0\n\'3-4\': 1.2\nrouting.heuristic-x: a\nhaiku.5-6: 2\n"with: colon": z\n');
  assert.deepEqual(v, { '1-2': 1, '3-4': 1.2, 'routing.heuristic-x': 'a', 'haiku.5-6': 2, 'with: colon': 'z' });
});

test('comments: full-line, trailing, and hash inside plain scalars', () => {
  const v = parse('# top\na: 1   # trailing\n  # indented comment\nb: x#y\nc: "q # not comment"  # real\nd: \'s # no\'\ne: [1, 2] # c\nf: # only comment\n  g: 1\n');
  assert.deepEqual(v, { a: 1, b: 'x#y', c: 'q # not comment', d: 's # no', e: [1, 2], f: { g: 1 } });
});

test('plain scalar containing colon without space and URLs', () => {
  assert.deepEqual(parse('u: http://example.com:80/x\nf: file:line\nt: 2026-11-14T10:00:00.000Z\n'),
    { u: 'http://example.com:80/x', f: 'file:line', t: '2026-11-14T10:00:00.000Z' });
});

test('double-quoted escapes and single-quoted doubling', () => {
  const v = parse('a: "x\\ny\\tz \\"q\\" \\\\"\nb: \'it\'\'s\'\nc: "\\u0041\\x42"\n');
  assert.deepEqual(v, { a: 'x\ny\tz "q" \\', b: "it's", c: 'AB' });
});

test('literal block scalars with chomping', () => {
  const t = 'a: |\n  line1\n    indented\n\n  line3\n\nb: |-\n  x\n  y\nc: |+\n  z\n\nd: end\n';
  assert.deepEqual(parse(t), { a: 'line1\n  indented\n\nline3\n', b: 'x\ny', c: 'z\n\n', d: 'end' });
});

test('folded block scalars', () => {
  const t = 'a: >\n  one\n  two\n\n  three\nb: >-\n  x\n  y\n';
  assert.deepEqual(parse(t), { a: 'one two\nthree\n', b: 'x y' });
});

test('block scalars inside sequences and containing hash and colon lines', () => {
  assert.deepEqual(parse('- |\n  # not a comment\n  a: b\n- next\n'), ['# not a comment\na: b\n', 'next']);
  assert.deepEqual(parse('- k: |\n    text\n    more\n  j: 1\n'), [{ k: 'text\nmore\n', j: 1 }]);
});

test('flow collections: simple, empty, nested', () => {
  assert.deepEqual(parse('a: [a, b, 1]\nb: {x: 1, y: z}\nc: []\nd: {}\ne: [[1, 2], {k: v}]\nf: {"q r": [1], s: \'t\'}\n'),
    { a: ['a', 'b', 1], b: { x: 1, y: 'z' }, c: [], d: {}, e: [[1, 2], { k: 'v' }], f: { 'q r': [1], s: 't' } });
});

test('flow mapping inside a block sequence', () => {
  assert.deepEqual(parse('commands_run:\n  - {command: "npm test", exit_code: 0}\n  - {command: ls, exit_code: 1}\n'),
    { commands_run: [{ command: 'npm test', exit_code: 0 }, { command: 'ls', exit_code: 1 }] });
});

test('flow items with spaces, dashes and dots stay intact', () => {
  assert.deepEqual(parse('v: [npm test -- tests/auth, src/auth/, a.b-c]\n'), { v: ['npm test -- tests/auth', 'src/auth/', 'a.b-c'] });
});

test('empty and comment-only input parse to null; CRLF and BOM are accepted', () => {
  assert.equal(parse(''), null);
  assert.equal(parse('# nothing\n\n'), null);
  assert.deepEqual(parse('\uFEFFa: 1\r\nb:\r\n  - x\r\n'), { a: 1, b: ['x'] });
});

test('top-level scalar documents', () => {
  assert.equal(parse('hello\n'), 'hello');
  assert.equal(parse('42'), 42);
  assert.equal(parse('"a: b"'), 'a: b');
});

// ---- errors ----

test('anchors, aliases and tags throw YamlError with numeric line', () => {
  throwsYaml(() => parse('a: &x 1\nb: *x\n'), 1);
  throwsYaml(() => parse('a: 1\nb: *x\n'), 2);
  throwsYaml(() => parse('a: !!str 1\n'), 1);
  throwsYaml(() => parse('- &a x\n'), 1);
  throwsYaml(() => parse('&a k: 1\n'), 1);
});

test('tab indentation throws YamlError', () => {
  throwsYaml(() => parse('a:\n\tb: 1\n'), 2);
  throwsYaml(() => parse('a: 1\n \tb: 2\n'), 2);
});

test('inconsistent indentation throws YamlError', () => {
  throwsYaml(() => parse('a:\n    b: 1\n  c: 2\n'), 3);
  throwsYaml(() => parse('a: 1\n  b: 2\n'), 2);
  throwsYaml(() => parse('- a: 1\n b: 2\n'), 2);
  throwsYaml(() => parse('a: 1\n- x\n'), 2);
});

test('duplicate keys, multi-line flow, unterminated quotes, stray content throw', () => {
  throwsYaml(() => parse('a: 1\na: 2\n'), 2);
  throwsYaml(() => parse('a: [1,\n  2]\n'), 1);
  throwsYaml(() => parse('a: {x: 1\n'), 1);
  throwsYaml(() => parse('a: "open\n'), 1);
  throwsYaml(() => parse('a: "x" y\n'), 1);
  throwsYaml(() => parse('a: b: c\n'), 1);
  throwsYaml(() => parse('a: x\njust text\n'), 2);
  throwsYaml(() => parse('a: [1, 2]]\n'), 1);
  throwsYaml(() => parse('a: [1,,2]\n'), 1);
  throwsYaml(() => parse('a: "bad \\\n'), 1);
});

test('unknown escapes in double-quoted strings keep a literal backslash', () => {
  assert.deepEqual(parse('a: "C:\\Users\\ExampleUser\\src\\x.js"\n'), { a: 'C:\\Users\\ExampleUser\\src\\x.js' });
  assert.deepEqual(parse('a: "^\\S+\\d{3}$ \\q"\n'), { a: '^\\S+\\d{3}$ \\q' });
  // an invalid \u or \x (Windows "\users", "\xampp") is also literal
  assert.deepEqual(parse('a: "C:\\users\\xampp"\n'), { a: 'C:\\users\\xampp' });
  // inside flow collections too
  assert.deepEqual(parse('a: ["D:\\Proj\\a.js", "E:\\Q"]\n'), { a: ['D:\\Proj\\a.js', 'E:\\Q'] });
  // known escapes still decode
  assert.deepEqual(parse('a: "x\\ny\\tz\\r\\0\\"\\\\\\/ \\u0041\\x42"\n'), { a: 'x\ny\tz\r\0"\\/ AB' });
  // a literal backslash then a decoded escape: \S then \n
  assert.deepEqual(parse('a: "\\S\\n"\n'), { a: '\\S\n' });
});

test('YamlError reports line numbers relative to the whole parseAll text', () => {
  throwsYaml(() => parseAll('a: 1\n---\nb: 2\nc: &x 3\n'), 4);
});

test('parse refuses multiple documents', () => {
  throwsYaml(() => parse('a: 1\n---\nb: 2\n'));
});

// ---- parseAll ----

test('parseAll splits on exact --- lines and ignores empty documents', () => {
  assert.deepEqual(parseAll('---\na: 1\n---\n# only comment\n---\n\n---\n- x\n- y\n---\n'), [{ a: 1 }, ['x', 'y']]);
  assert.deepEqual(parseAll(''), []);
  assert.deepEqual(parseAll('a: 1\n'), [{ a: 1 }]);
});

test('parseAll does not split on --- inside values or indented lines', () => {
  assert.deepEqual(parseAll('a: "---"\nb: |\n  ---\n  x\n'), [{ a: '---', b: '---\nx\n' }]);
});

// ---- design examples ----

test('DESIGN 3.1 task specification parses', () => {
  const text = `task_id: AUTH-001                # ^[A-Z][A-Z0-9]*-\\d{3}$
title: Implement refresh-token handling
objective: One or two sentences on the result wanted.
kind: implementation             # implementation|research|test|verification|review|debug|documentation|integration|security|repository (default implementation)
priority: high                   # low|medium|high|critical (default medium)
complexity: 7                    # 1-10, OR give complexity_factors and it is computed
complexity_factors: {technical_difficulty: 2, components: 2, architectural_impact: 1, ambiguity: 1, security_sensitivity: 2, dependency_complexity: 1, regression_risk: 2, debugging_difficulty: 1}   # each 0-3
risk: medium                     # low|medium|high (default: high if complexity>=8 or security_sensitive, medium if >=5, else low)
dependencies: [AUTH-000]
assigned_model: auto             # auto|haiku|sonnet|opus ; an explicit model is a floor, routing never goes below it
assigned_role: auto              # auto or a logical role from section 2
authorized_files: [src/auth/, tests/auth/]      # files, directories (trailing slash) or globs; may be empty only for non-writing roles
acceptance_criteria: [..]        # non-empty list of observable statements
deliverables: [..]               # optional
verification: [..]               # what the worker does before reporting (free text)
verification_commands: [..]      # shell commands oo runs itself; exit 0 = pass
context: free text               # what the worker cannot find quickly
constraints: [..]                # optional
tool_permissions: [..]           # optional note of tools the task needs beyond the agent default
security_sensitive: false
side_effects: none               # none|local|external
exclusive: false
`;
  assert.deepEqual(parse(text), {
    task_id: 'AUTH-001',
    title: 'Implement refresh-token handling',
    objective: 'One or two sentences on the result wanted.',
    kind: 'implementation',
    priority: 'high',
    complexity: 7,
    complexity_factors: { technical_difficulty: 2, components: 2, architectural_impact: 1, ambiguity: 1, security_sensitivity: 2, dependency_complexity: 1, regression_risk: 2, debugging_difficulty: 1 },
    risk: 'medium',
    dependencies: ['AUTH-000'],
    assigned_model: 'auto',
    assigned_role: 'auto',
    authorized_files: ['src/auth/', 'tests/auth/'],
    acceptance_criteria: ['..'],
    deliverables: ['..'],
    verification: ['..'],
    verification_commands: ['..'],
    context: 'free text',
    constraints: ['..'],
    tool_permissions: ['..'],
    security_sensitive: false,
    side_effects: 'none',
    exclusive: false,
  });
});

test('DESIGN 3.4 agent result parses', () => {
  const text = `task_id: AUTH-001
status: completed            # completed|failed|blocked|needs_decomposition
summary: one or two sentences
files_changed: [src/auth/token.js]
self_check:                  # one entry per acceptance criterion, in order (required when status is completed)
  - met: true
    evidence: test "rejects invalid refresh token" passes
commands_run:
  - {command: "npm test", exit_code: 0}
commit: null                 # commit sha when working in a git worktree
branch: null
issues: []                   # anything the orchestrator must know, including denied tools
proposed_subtasks: []        # only with needs_decomposition
`;
  assert.deepEqual(parse(text), {
    task_id: 'AUTH-001',
    status: 'completed',
    summary: 'one or two sentences',
    files_changed: ['src/auth/token.js'],
    self_check: [{ met: true, evidence: 'test "rejects invalid refresh token" passes' }],
    commands_run: [{ command: 'npm test', exit_code: 0 }],
    commit: null,
    branch: null,
    issues: [],
    proposed_subtasks: [],
  });
});

test('DESIGN 3.5 review report parses', () => {
  const text = `task_id: AUTH-001
reviewer: opus-reviewer      # or "orchestrator"
verdict: approve             # approve|request_changes|reject
criteria:                    # exactly one entry per acceptance criterion, in order
  - {met: true, evidence: "tests/auth/refresh.test.js:14 covers the expired-token path; ran it, exit 0"}
findings:                    # required (non-empty) unless verdict is approve
  - {severity: major, file: src/auth/token.js, description: "..."}     # severity: blocker|major|minor|note
checks: {}                   # optional extra answers
`;
  assert.deepEqual(parse(text), {
    task_id: 'AUTH-001',
    reviewer: 'opus-reviewer',
    verdict: 'approve',
    criteria: [{ met: true, evidence: 'tests/auth/refresh.test.js:14 covers the expired-token path; ran it, exit 0' }],
    findings: [{ severity: 'major', file: 'src/auth/token.js', description: '...' }],
    checks: {},
  });
});

test('DESIGN 3.6 correction request parses', () => {
  const text = `task_id: AUTH-001
failure: exact failure
evidence: command output, file:line
expected_behavior: ...
required_change: the one change needed
scope: [src/auth/token.js]   # subset of authorized_files
verification: [npm test -- tests/auth]
strategy_change: ...         # required from the second correction round on
`;
  assert.deepEqual(parse(text), {
    task_id: 'AUTH-001',
    failure: 'exact failure',
    evidence: 'command output, file:line',
    expected_behavior: '...',
    required_change: 'the one change needed',
    scope: ['src/auth/token.js'],
    verification: ['npm test -- tests/auth'],
    strategy_change: '...',
  });
});

test('DESIGN 3.7 improvement proposal parses', () => {
  const text = `id: IMP-20261114-001
created: 2026-11-14T10:00:00.000Z
category: routing_heuristics   # task_decomposition|agent_instructions|specification_precision|verification_rules|routing_heuristics|context_overhead|recovery_behavior|troubleshooting_procedure
title: ...
rationale: ...
evidence: ["run 2026...: haiku first-pass 1 of 6 at complexity 5-6"]   # non-empty
target_file: config/routing.yaml       # relative to the skill directory
change: {kind: config_set, key: routing.heuristic_expected_attempts.haiku.5-6, value: 2.0}   # kind: config_set|manual
risk: low                               # low|medium|high
status: proposed                        # proposed|approved|rejected|applied|rolled_back
approved_by: null
weakens_safety: false
`;
  assert.deepEqual(parse(text), {
    id: 'IMP-20261114-001',
    created: '2026-11-14T10:00:00.000Z',
    category: 'routing_heuristics',
    title: '...',
    rationale: '...',
    evidence: ['run 2026...: haiku first-pass 1 of 6 at complexity 5-6'],
    target_file: 'config/routing.yaml',
    change: { kind: 'config_set', key: 'routing.heuristic_expected_attempts.haiku.5-6', value: 2 },
    risk: 'low',
    status: 'proposed',
    approved_by: null,
    weakens_safety: false,
  });
});

test('DESIGN section 2 style config with quoted band keys parses', () => {
  const text = 'routing:\n  heuristic_expected_attempts:\n    haiku: {"1-2": 1.0, "3-4": 1.2, "5-6": 1.5}\n    opus:\n      "7-8": 1.3\n';
  assert.deepEqual(parse(text), { routing: { heuristic_expected_attempts: { haiku: { '1-2': 1, '3-4': 1.2, '5-6': 1.5 }, opus: { '7-8': 1.3 } } } });
});

// ---- stringify / round trip ----

function roundTrip(x) {
  const text = stringify(x);
  assert.deepEqual(parse(text), x, `round trip failed for ${JSON.stringify(x)} via:\n${text}`);
  return text;
}

test('round trip: nested structures, empties, scalars', () => {
  roundTrip({ a: 1, b: [1, 2, { c: [], d: {} }], e: { f: { g: null, h: true, i: false } }, j: [] , k: {} });
  roundTrip([]);
  roundTrip({});
  roundTrip([[], {}, [[]], [{}], [[1, 2], [3]]]);
  roundTrip([{ a: 1, b: { c: [1, { d: 2 }] } }, { x: [] }]);
  roundTrip(null);
  roundTrip(true);
  roundTrip(0);
  roundTrip('plain');
});

test('round trip: numbers including negative, decimal, exponent-sized and -0', () => {
  roundTrip({ n: [-1, 0, 1, -3.5, 0.1, 2.0, 123456789, -0.000001, 1e21, 1.5e-9, 1e-7, 12345678901234567890, Number.MAX_SAFE_INTEGER, -0] });
});

test('round trip: strings that look like other types', () => {
  roundTrip(['1', '-1', '1.5', '0x10', '007', 'true', 'false', 'null', '~', '', ' ', 'True', '1e5', '2026-11-14', '1.2.3', '12345678901234567890']);
  roundTrip({ a: '1', b: 'true', c: 'null', d: '', e: '3.14' });
});

test('round trip: strings with colons, hashes, indicators, quotes and spaces', () => {
  roundTrip([
    'a: b', 'a:', 'a :b', 'x #y', '#start', 'x#y', '- dash', '-dash', '-', '--- sep', '[x]', '{x}', '[', '{', '"q"', "'s'", 'it\'s', 'say "hi"',
    ' lead', 'trail ', '  both  ', '\ttab', '&a', '*b', '!t', '%p', '@at', '`bt', '|', '>', '?', '? q', ': x', ',x', 'a, b', 'x]', '<<',
    'file:line', 'http://x:80/y',
  ]);
  roundTrip({ 'k: v': 'a: b', 'k #': 'x #y', '1-2': 1, '': 'empty key', 'a.b-c': 2, 'true': 1, 'null': 2, '- x': 3, "it's": 4, 'sp ace': 5, '__proto__': 6 });
});

test('round trip: multi-line strings of every shape', () => {
  roundTrip({ a: 'line1\nline2', b: 'line1\nline2\n', c: 'a\n\nb', d: 'a\n\n\n', e: '\nlead', f: '  indented\nx', g: 'x\n  y\n', h: 'a  \nb', i: '\n', j: 'a\n \nb', k: 'tab\there\nz', l: 'cr\r\nlf', m: '# c\n- x\nk: v\n', n: '---\n...' });
  roundTrip(['a\nb', 'c\n', ['x\ny'], { k: 'm\nn' }]);
  roundTrip('top\nlevel\n');
  roundTrip([{ k: 'first\nsecond', j: 1 }]);
});

test('round trip: control characters, unicode and emoji', () => {
  roundTrip({ a: '\u0000\u0001\u007f', b: 'caf\u00e9 \u4e2d\u6587 \u{1F600}', c: '\u00a0nbsp', d: '\u2028', e: 'back\\slash', f: 'q"uote\\"' });
});

test('round trip: a realistic task record', () => {
  roundTrip({
    task_id: 'AUTH-001', status: 'completed', complexity: 7, risk: 'medium', dependencies: ['AUTH-000'],
    acceptance_criteria: ['returns 401: invalid token', 'handles "quoted" input', '100% pass'],
    self_check: [{ met: true, evidence: 'test "x" passes' }],
    commands_run: [{ command: 'npm test -- --grep "a: b"', exit_code: 0 }],
    result: { summary: 'multi\nline', files_changed: [], commit: null },
    routing: { heuristic: { '1-2': 1, '5-6': 1.5 } },
  });
});

test('stringify output shape is readable block YAML', () => {
  assert.equal(stringify({ a: 1, b: ['x', { c: 2, d: [] }], e: 'multi\nline\n' }), 'a: 1\nb:\n  - x\n  - c: 2\n    d: []\ne: |\n  multi\n  line\n');
  assert.equal(stringify([]), '[]\n');
  assert.equal(stringify({}), '{}\n');
});

test('stringify skips undefined object members and rejects unserializable values', () => {
  assert.equal(stringify({ a: 1, b: undefined }), 'a: 1\n');
  throwsYaml(() => stringify(NaN));
  throwsYaml(() => stringify({ a: Infinity }));
  throwsYaml(() => stringify(undefined));
  throwsYaml(() => stringify({ f() {} }));
});

test('parsed objects do not pollute prototypes', () => {
  const v = parse('__proto__:\n  polluted: 1\n');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.keys(v).length, 1);
});

// ---- extractYamlBlock ----

test('extractYamlBlock returns the last fenced yaml block', () => {
  const msg = 'Done.\n```yaml\ntask_id: A-001\nstatus: failed\n```\nmore text\n```yaml\ntask_id: A-001\nstatus: completed\n```\nbye\n';
  assert.equal(extractYamlBlock(msg), 'task_id: A-001\nstatus: completed\n');
});

test('extractYamlBlock ignores non-yaml fences and accepts yml and CRLF', () => {
  assert.equal(extractYamlBlock('```js\nx\n```\n```yml\na: 1\n```'), 'a: 1\n');
  assert.equal(extractYamlBlock('```yaml\r\na: 1\r\n```\r\n'), 'a: 1\n');
  assert.equal(extractYamlBlock('```json\n{}\n```'), null);
});

test('extractYamlBlock returns bare text that starts with task_id', () => {
  const bare = 'task_id: A-001\nstatus: completed\n';
  assert.equal(extractYamlBlock(bare), bare);
  assert.deepEqual(parse(extractYamlBlock(bare)), { task_id: 'A-001', status: 'completed' });
});

test('extractYamlBlock returns null for text without YAML', () => {
  assert.equal(extractYamlBlock('just some prose, no yaml here'), null);
  assert.equal(extractYamlBlock(''), null);
  assert.equal(extractYamlBlock('Result: task_id: A-001 inline'), null);
  assert.equal(extractYamlBlock(null), null);
});

test('extracted block from a worker message parses to the report', () => {
  const msg = 'All finished.\n\n```yaml\ntask_id: X-001\nstatus: completed\nfiles_changed:\n  - a.js\n```\n';
  assert.deepEqual(parse(extractYamlBlock(msg)), { task_id: 'X-001', status: 'completed', files_changed: ['a.js'] });
});

// ---- module hygiene ----

test('module has no dependencies outside node built-ins and does no I/O', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'yaml.cjs'), 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  for (const r of requires) assert.ok(r.startsWith('node:'), `non built-in require: ${r}`);
  assert.doesNotMatch(src, /node:fs|node:child_process|process\.exit|console\.|Date\.now/);
});

test('YamlError shape', () => {
  const e = new YamlError('boom', 5);
  assert.ok(e instanceof Error);
  assert.equal(e.code, 'YAML');
  assert.equal(e.line, 5);
  assert.match(e.message, /line 5/);
});
