'use strict';
/**
 * Dependency-free parser and serializer for the YAML subset described in
 * DESIGN.md section 4.1. Pure: no I/O, no clock, no dependencies.
 *
 * Supported: block mappings and sequences (nested, sequences of mappings),
 * plain / single-quoted / double-quoted scalars, integers, floats, true/false,
 * null/~/empty, comments, literal (|) and folded (>) block scalars, and
 * single-line flow collections ([a, b], {a: 1}, [], {}).
 * Anything else (anchors, aliases, tags, tab indentation, inconsistent
 * indentation, multi-line flow or plain scalars, duplicate keys) throws
 * YamlError rather than being guessed at.
 */

class YamlError extends Error {
  constructor(message, line) {
    const n = Number.isInteger(line) && line >= 0 ? line : 0;
    super(n > 0 ? `${message} (line ${n})` : message);
    this.name = 'YamlError';
    this.code = 'YAML';
    this.line = n;
  }
}

const INT_RE = /^-?(?:0|[1-9]\d*)$/;
const FLOAT_RE = /^-?(?:0|[1-9]\d*)\.\d+(?:[eE][+-]?\d+)?$/;
const CTL_RE = /[\u0000-\u001f\u007f]/;

function trimWs(s) {
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

function setKey(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function resolvePlain(s) {
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (INT_RE.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : s;
  }
  if (FLOAT_RE.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  return s;
}

function checkPlainStart(s, no) {
  const c = s[0];
  if (c === '&' || c === '*') throw new YamlError('anchors and aliases are not supported (quote the value if it is literal text)', no);
  if (c === '!') throw new YamlError('tags are not supported (quote the value if it is literal text)', no);
  if (c === '%' || c === '@' || c === '`') throw new YamlError(`reserved indicator "${c}" at start of plain scalar (quote the value)`, no);
  if (c === ',' || c === ']' || c === '}') throw new YamlError(`unexpected "${c}"`, no);
  if ((c === '-' || c === '?' || c === ':') && (s.length === 1 || s[1] === ' ' || s[1] === '\t')) {
    throw new YamlError(`unsupported or misplaced "${c}" indicator (quote the value)`, no);
  }
}

function parseDoubleQuoted(s, i, no) {
  let out = '';
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '"') return { value: out, end: j + 1 };
    if (c === '\\') {
      const e = s[j + 1];
      j += 2;
      switch (e) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case '0': out += '\0'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'x':
        case 'u': {
          const len = e === 'x' ? 2 : 4;
          const hex = s.slice(j, j + len);
          if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) {
            // Not a real escape (the "\users" in a Windows path): keep the backslash literally.
            out += '\\';
            j -= 1;
            break;
          }
          out += String.fromCharCode(parseInt(hex, 16));
          j += len;
          break;
        }
        default:
          // An unknown escape such as "\S" or "\d" is kept as a literal backslash followed by the
          // character, so Windows paths and regular expressions in double quotes parse. A valid
          // document never contains one, so this cannot change the meaning of a valid document.
          out += '\\';
          j -= 1;
      }
    } else {
      out += c;
      j++;
    }
  }
  throw new YamlError('unterminated double-quoted string (multi-line quoted scalars are not supported)', no);
}

function parseSingleQuoted(s, i, no) {
  let out = '';
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "'") {
      if (s[j + 1] === "'") { out += "'"; j += 2; continue; }
      return { value: out, end: j + 1 };
    }
    out += c;
    j++;
  }
  throw new YamlError('unterminated single-quoted string (multi-line quoted scalars are not supported)', no);
}

function parseQuoted(s, i, no) {
  return s[i] === '"' ? parseDoubleQuoted(s, i, no) : parseSingleQuoted(s, i, no);
}

// ---- flow collections (single line) ----

function parseFlow(s, start, no) {
  let i = start;
  const skipWs = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++; };

  function plain(stopKey) {
    const from = i;
    while (i < s.length) {
      const c = s[i];
      if (c === ',' || c === ']' || c === '}') break;
      if (stopKey && c === ':' && (i + 1 >= s.length || /[ \t,\]}]/.test(s[i + 1]))) break;
      i++;
    }
    return trimWs(s.slice(from, i));
  }

  function value() {
    skipWs();
    const c = s[i];
    if (c === undefined) throw new YamlError('unterminated flow collection (multi-line flow collections are not supported)', no);
    if (c === '[') return seq();
    if (c === '{') return map();
    if (c === '"' || c === "'") {
      const q = parseQuoted(s, i, no);
      i = q.end;
      return q.value;
    }
    const t = plain(false);
    if (t === '') throw new YamlError('empty item in flow collection', no);
    checkPlainStart(t, no);
    if (/:(?:[ \t]|$)/.test(t)) throw new YamlError('unexpected ": " in flow scalar (quote it)', no);
    return resolvePlain(t);
  }

  function seq() {
    i++; // [
    const arr = [];
    skipWs();
    if (s[i] === ']') { i++; return arr; }
    for (;;) {
      arr.push(value());
      skipWs();
      if (s[i] === ',') {
        i++;
        skipWs();
        if (s[i] === ']') { i++; return arr; }
        continue;
      }
      if (s[i] === ']') { i++; return arr; }
      throw new YamlError(s[i] === undefined ? 'unterminated flow sequence (multi-line flow collections are not supported)' : `unexpected "${s[i]}" in flow sequence`, no);
    }
  }

  function map() {
    i++; // {
    const obj = {};
    skipWs();
    if (s[i] === '}') { i++; return obj; }
    for (;;) {
      skipWs();
      let key;
      if (s[i] === '"' || s[i] === "'") {
        const q = parseQuoted(s, i, no);
        i = q.end;
        key = q.value;
      } else {
        key = plain(true);
        if (key === '') throw new YamlError('empty key in flow mapping', no);
        checkPlainStart(key, no);
      }
      skipWs();
      if (s[i] !== ':') throw new YamlError(`flow mapping entry "${key}" has no ":" value`, no);
      i++;
      if (Object.prototype.hasOwnProperty.call(obj, key)) throw new YamlError(`duplicate key "${key}"`, no);
      skipWs();
      if (s[i] === ',' || s[i] === '}') throw new YamlError(`empty value for key "${key}" in flow mapping`, no);
      setKey(obj, key, value());
      skipWs();
      if (s[i] === ',') {
        i++;
        skipWs();
        if (s[i] === '}') { i++; return obj; }
        continue;
      }
      if (s[i] === '}') { i++; return obj; }
      throw new YamlError(s[i] === undefined ? 'unterminated flow mapping (multi-line flow collections are not supported)' : `unexpected "${s[i]}" in flow mapping`, no);
    }
  }

  const v = value();
  return { value: v, end: i };
}

// ---- block structure ----

function makeLines(text, startNo) {
  const parts = text.split('\n');
  return parts.map((raw, idx) => {
    const m = /^ */.exec(raw)[0].length;
    const t = raw.slice(m);
    const blank = /^[ \t]*$/.test(raw);
    return { no: startNo + idx, raw, indent: m, text: t, blank, skip: blank || t[0] === '#' };
  });
}

function isSeqItem(t) {
  return t === '-' || t.startsWith('- ');
}

function splitKey(t, no) {
  const c = t[0];
  if (c === '"' || c === "'") {
    const q = parseQuoted(t, 0, no);
    let j = q.end;
    while (t[j] === ' ') j++;
    if (t[j] === ':' && (j + 1 === t.length || t[j + 1] === ' ' || t[j + 1] === '\t')) {
      return { key: q.value, rest: trimWs(t.slice(j + 1)) };
    }
    return null;
  }
  if (c === '[' || c === '{') return null;
  let limit = t.search(/[ \t]#/);
  if (limit < 0) limit = t.length;
  for (let j = 0; j < limit; j++) {
    if (t[j] === ':' && (j + 1 === t.length || t[j + 1] === ' ' || t[j + 1] === '\t')) {
      const key = trimWs(t.slice(0, j));
      if (key === '') throw new YamlError('empty mapping key', no);
      checkPlainStart(key, no);
      return { key, rest: trimWs(t.slice(j + 1)) };
    }
  }
  return null;
}

function foldLines(lines, trailingBlanks, chomp, folded) {
  let out = '';
  if (!folded) {
    out = lines.join('\n');
  } else {
    let prev = null;
    let prevMore = false;
    let blanks = 0;
    for (const L of lines) {
      if (L === '') { blanks++; continue; }
      const more = /^[ \t]/.test(L);
      if (prev === null) out += '\n'.repeat(blanks);
      else if (!more && !prevMore) out += blanks ? '\n'.repeat(blanks) : ' ';
      else out += '\n'.repeat(blanks + 1);
      out += L;
      prev = L;
      prevMore = more;
      blanks = 0;
    }
  }
  if (lines.length === 0) return chomp === 'keep' ? '\n'.repeat(trailingBlanks) : '';
  if (chomp === 'strip') return out;
  if (chomp === 'clip') return out + '\n';
  return out + '\n' + '\n'.repeat(trailingBlanks);
}

function parseLines(allLines) {
  const lines = allLines;
  let pos = 0;

  function peek() {
    while (pos < lines.length && lines[pos].skip) pos++;
    if (pos >= lines.length) return null;
    const l = lines[pos];
    if (/^ *\t/.test(l.raw)) throw new YamlError('tab characters are not allowed for indentation', l.no);
    return l;
  }

  function blockScalar(style, mods, parentIndent, no) {
    if (!/^(?:[1-9][-+]?|[-+][1-9]?)?$/.test(mods)) throw new YamlError(`invalid block scalar header "${style}${mods}"`, no);
    let chomp = 'clip';
    let explicit = 0;
    for (const ch of mods) {
      if (ch === '-') chomp = 'strip';
      else if (ch === '+') chomp = 'keep';
      else explicit = Number(ch);
    }
    let contentIndent = explicit ? Math.max(parentIndent, 0) + explicit : -1;
    const entries = []; // strings; '' for blank
    let p = pos;
    while (p < lines.length) {
      const L = lines[p];
      if (L.blank) {
        entries.push(contentIndent >= 0 && L.raw.length > contentIndent ? L.raw.slice(contentIndent) : '');
        p++;
        continue;
      }
      if (contentIndent < 0) {
        if (L.indent <= parentIndent) break;
        contentIndent = L.indent;
      } else if (L.indent < contentIndent) {
        break;
      }
      entries.push(L.raw.slice(contentIndent));
      p++;
    }
    pos = p;
    let last = entries.length;
    while (last > 0 && entries[last - 1] === '') last--;
    const body = entries.slice(0, last);
    return foldLines(body, entries.length - last, chomp, style === '>');
  }

  // Parse the text of a value that sits on the same line as its key / dash.
  function inline(text, no, parentIndent) {
    const t = trimWs(text);
    const c = t[0];
    if (c === '|' || c === '>') {
      const m = /^([|>])([^ \t#]*)(?:[ \t]+#.*)?$/.exec(t);
      if (!m) throw new YamlError(`invalid block scalar header "${t}"`, no);
      return blockScalar(m[1], m[2], parentIndent, no);
    }
    if (c === '"' || c === "'" || c === '[' || c === '{') {
      let r;
      if (c === '"' || c === "'") r = parseQuoted(t, 0, no);
      else r = parseFlow(t, 0, no);
      const rest = t.slice(r.end);
      if (!/^[ \t]*$/.test(rest) && !/^[ \t]+#/.test(rest)) {
        throw new YamlError('unexpected content after quoted string or flow collection', no);
      }
      return r.value;
    }
    let p = t;
    const ci = p.search(/[ \t]#/);
    if (ci >= 0) p = trimWs(p.slice(0, ci));
    if (p === '') return null;
    checkPlainStart(p, no);
    if (/:(?:[ \t]|$)/.test(p)) throw new YamlError('mapping values are not allowed here (quote the value if it contains ": ")', no);
    return resolvePlain(p);
  }

  function parseNode() {
    const line = peek();
    if (isSeqItem(line.text)) return parseSeq(line.indent);
    if (splitKey(line.text, line.no)) return parseMap(line.indent);
    pos++;
    return inline(line.text, line.no, line.indent - 1);
  }

  function parseMap(indent) {
    const obj = {};
    for (;;) {
      const line = peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) throw new YamlError('inconsistent indentation', line.no);
      const kv = isSeqItem(line.text) ? null : splitKey(line.text, line.no);
      if (!kv) throw new YamlError('expected "key: value"', line.no);
      pos++;
      if (Object.prototype.hasOwnProperty.call(obj, kv.key)) throw new YamlError(`duplicate key "${kv.key}"`, line.no);
      let value;
      let rest = kv.rest;
      if (rest[0] === '#') rest = '';
      if (rest === '') {
        const nxt = peek();
        if (nxt && nxt.indent > indent) value = parseNode();
        else if (nxt && nxt.indent === indent && isSeqItem(nxt.text)) value = parseSeq(indent);
        else value = null;
      } else {
        value = inline(rest, line.no, indent);
      }
      setKey(obj, kv.key, value);
    }
    return obj;
  }

  function parseSeq(indent) {
    const arr = [];
    for (;;) {
      const line = peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) throw new YamlError('inconsistent indentation', line.no);
      if (!isSeqItem(line.text)) break;
      const after = line.text.slice(1);
      const trimmed = after.replace(/^[ ]+/, '');
      if (/^\t/.test(trimmed)) throw new YamlError('tab characters are not allowed for indentation', line.no);
      const off = 1 + (after.length - trimmed.length);
      if (trimmed === '' || trimmed[0] === '#') {
        pos++;
        const nxt = peek();
        arr.push(nxt && nxt.indent > indent ? parseNode() : null);
      } else if (isSeqItem(trimmed) || splitKey(trimmed, line.no)) {
        lines[pos] = Object.assign({}, line, { indent: indent + off, text: trimmed });
        arr.push(parseNode());
      } else {
        pos++;
        arr.push(inline(trimmed, line.no, indent));
      }
    }
    return arr;
  }

  const first = peek();
  if (!first) return { empty: true, value: null };
  const value = parseNode();
  const extra = peek();
  if (extra) throw new YamlError('unexpected content or inconsistent indentation', extra.no);
  return { empty: false, value };
}

function splitDocuments(text) {
  if (typeof text !== 'string') throw new YamlError('input must be a string', 0);
  let t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (t === '') return [];
  if (t.endsWith('\n')) t = t.slice(0, -1);
  const all = makeLines(t, 1);
  const docs = [];
  let cur = [];
  for (const l of all) {
    if (l.raw === '---') {
      docs.push(cur);
      cur = [];
    } else {
      cur.push(l);
    }
  }
  docs.push(cur);
  return docs;
}

function parseAll(text) {
  const out = [];
  for (const d of splitDocuments(text)) {
    const r = parseLines(d);
    if (!r.empty) out.push(r.value);
  }
  return out;
}

function parse(text) {
  const docs = [];
  for (const d of splitDocuments(text)) {
    const r = parseLines(d);
    if (!r.empty) docs.push({ r, d });
  }
  if (docs.length === 0) return null;
  if (docs.length > 1) {
    const firstLine = docs[1].d.find((l) => !l.skip);
    throw new YamlError('multiple documents found; use parseAll', firstLine ? firstLine.no : 0);
  }
  return docs[0].r.value;
}

// ---- stringify ----

function dq(s) {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x7f) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

function sq(s) {
  return "'" + s.replace(/'/g, "''") + "'";
}

function needsQuote(s) {
  if (s === '') return true;
  if (/^[ \t]|[ \t]$/.test(s)) return true;
  if (CTL_RE.test(s)) return true;
  if (resolvePlain(s) !== s) return true;
  if ('-?:,[]{}#&*!|>\'"%@`'.includes(s[0])) return true;
  if (/:(?:[ \t]|$)/.test(s) || /[ \t]#/.test(s)) return true;
  return false;
}

function literalOk(s) {
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(s)) return false; // control chars other than \n
  if (/^[ \t\n]/.test(s)) return false;
  const body = s.replace(/\n+$/, '');
  if (!/\S/.test(body)) return false;
  for (const l of body.split('\n')) {
    if (l !== '' && /^[ \t]+$/.test(l)) return false;
  }
  return true;
}

function numberRepr(v) {
  if (!Number.isFinite(v)) throw new YamlError(`cannot serialize non-finite number ${v}`, 0);
  if (Object.is(v, -0)) return '-0';
  let s = String(v);
  if (Number.isInteger(v) && !Number.isSafeInteger(v)) s = v.toExponential();
  return s.replace(/^(-?\d+)e/, '$1.0e');
}

function isContainer(v) {
  return v !== null && typeof v === 'object';
}

function normalize(v) {
  if (v !== null && typeof v === 'object' && typeof v.toJSON === 'function') return v.toJSON();
  return v;
}

function scalarRepr(v, contentIndent) {
  if (v === null) return { head: 'null', body: [] };
  switch (typeof v) {
    case 'boolean': return { head: v ? 'true' : 'false', body: [] };
    case 'number': return { head: numberRepr(v), body: [] };
    case 'string': {
      if (v.includes('\n') && contentIndent !== null && literalOk(v)) {
        const trailing = v.length - v.replace(/\n+$/, '').length;
        const body = v.replace(/\n+$/, '').split('\n');
        const pad = ' '.repeat(contentIndent);
        const head = trailing === 0 ? '|-' : trailing === 1 ? '|' : '|+';
        const out = body.map((l) => (l === '' ? '' : pad + l));
        for (let k = 1; k < trailing; k++) out.push('');
        return { head, body: out };
      }
      if (!needsQuote(v)) return { head: v, body: [] };
      return { head: CTL_RE.test(v) ? dq(v) : sq(v), body: [] };
    }
    case 'object':
      return { head: Array.isArray(v) ? '[]' : '{}', body: [] };
    default:
      throw new YamlError(`cannot serialize value of type ${typeof v}`, 0);
  }
}

function keyRepr(k) {
  if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k) && !['null', 'true', 'false'].includes(k)) return k;
  return CTL_RE.test(k) ? dq(k) : sq(k);
}

function entries(obj) {
  return Object.keys(obj).filter((k) => obj[k] !== undefined);
}

function nonEmptyContainer(v) {
  if (!isContainer(v)) return false;
  return Array.isArray(v) ? v.length > 0 : entries(v).length > 0;
}

function emitBlock(v, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  if (Array.isArray(v)) {
    for (let item of v) {
      item = normalize(item);
      if (item === undefined) item = null;
      if (nonEmptyContainer(item)) {
        const sub = emitBlock(item, indent + 2);
        sub[0] = pad + '- ' + sub[0].slice(indent + 2);
        out.push(...sub);
      } else {
        const r = scalarRepr(item, indent + 2);
        out.push(pad + '- ' + r.head, ...r.body);
      }
    }
  } else {
    for (const k of entries(v)) {
      const val = normalize(v[k]);
      if (val === undefined) continue;
      if (nonEmptyContainer(val)) {
        out.push(pad + keyRepr(k) + ':', ...emitBlock(val, indent + 2));
      } else {
        const r = scalarRepr(val, indent + 2);
        out.push(pad + keyRepr(k) + ': ' + r.head, ...r.body);
      }
    }
  }
  return out;
}

function stringify(value) {
  value = normalize(value);
  if (value === undefined) throw new YamlError('cannot serialize undefined', 0);
  if (nonEmptyContainer(value)) return emitBlock(value, 0).join('\n') + '\n';
  return scalarRepr(value, null).head + '\n';
}

// ---- extraction ----

function extractYamlBlock(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\r\n?/g, '\n');
  const re = /^([ \t]*)```[ \t]*(?:yaml|yml)[ \t]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gim;
  let last = null;
  let m;
  while ((m = re.exec(t)) !== null) {
    last = m;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last) {
    let body = last[2];
    const fence = last[1].length;
    if (fence > 0) {
      body = body.split('\n').map((l) => {
        let k = 0;
        while (k < fence && l[k] === ' ') k++;
        return l.slice(k);
      }).join('\n');
    }
    return body;
  }
  if (/^\s*task_id:/.test(text)) return text;
  return null;
}

module.exports = { parse, parseAll, stringify, extractYamlBlock, YamlError };
