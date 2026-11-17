'use strict';
/**
 * miniyaml - dependency-free parser/emitter for the YAML subset used by
 * fable-orchestrator contracts, reports and config. JSON input is accepted too.
 *
 * Supported: block mappings and sequences, sequences of mappings, single-line
 * flow collections ([a, b] / {k: v}) holding scalars, quoted and plain scalars,
 * | and > block scalars, comments.
 * Not supported: anchors, tags, multi-document streams, multi-line flow
 * collections, complex keys. Unsupported input raises YamlError with a line number.
 */

class YamlError extends Error {
  constructor(message, line) {
    super(line ? `YAML line ${line}: ${message}` : `YAML: ${message}`);
    this.name = 'YamlError';
    this.line = line || null;
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// key: value  |  key:   (plain keys may contain spaces; ":" must be followed by space or end of line)
const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#\[\]{}&*!|>'"%@`,-][^:]*?|-[^\s:][^:]*?)\s*:(?:[ \t]+(.*))?$/;

function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (quote === '"' && c === '\\') { i++; continue; }
      if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") { i++; continue; }
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      // a quote only opens a quoted scalar at the start of a value or after flow punctuation
      const before = s.slice(0, i).trimEnd();
      if (before === '' || /[\[,{:]$/.test(before)) quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s.trimEnd();
}

function splitFlow(inner, line) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (quote === '"' && c === '\\') { cur += inner[++i] || ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (quote || depth !== 0) throw new YamlError('unbalanced flow collection', line);
  if (cur.trim() !== '') parts.push(cur.trim());
  return parts;
}

function parseScalar(raw, line) {
  const s = stripComment(String(raw)).trim();
  if (s === '' || s === '~' || /^(null|Null|NULL)$/.test(s)) return null;
  if (s[0] === '"') {
    if (s.length < 2 || s[s.length - 1] !== '"') throw new YamlError('unterminated double-quoted string', line);
    try {
      return JSON.parse(s);
    } catch (e) {
      // tolerate raw backslashes (Windows paths) that are not valid JSON escapes
      return s.slice(1, -1).replace(/\\(["\\/nrt])/g, (m, c) => ({ n: '\n', r: '\r', t: '\t' }[c] || c));
    }
  }
  if (s[0] === "'") {
    if (s.length < 2 || s[s.length - 1] !== "'") throw new YamlError('unterminated single-quoted string', line);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s[0] === '[') {
    if (s[s.length - 1] !== ']') throw new YamlError('flow sequence must close on the same line', line);
    const inner = s.slice(1, -1).trim();
    return inner === '' ? [] : splitFlow(inner, line).map((x) => parseScalar(x, line));
  }
  if (s[0] === '{') {
    if (s[s.length - 1] !== '}') throw new YamlError('flow mapping must close on the same line', line);
    const inner = s.slice(1, -1).trim();
    const out = {};
    if (inner === '') return out;
    for (const part of splitFlow(inner, line)) {
      const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:]+?)\s*:\s*(.*)$/.exec(part);
      if (!m) throw new YamlError(`bad flow mapping entry "${part}"`, line);
      const key = String(parseScalar(m[1], line));
      if (FORBIDDEN_KEYS.has(key)) throw new YamlError(`key "${key}" is not allowed`, line);
      out[key] = parseScalar(m[2], line);
    }
    return out;
  }
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?(0|[1-9]\d*)$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  return s;
}

function parse(text) {
  const src = String(text).replace(/^﻿/, '');
  const trimmed = src.trim();
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try { return JSON.parse(trimmed); } catch (e) { /* fall through: may be a flow scalar */ }
  }
  const lines = src.split(/\r?\n/);
  let i = 0;

  const peek = () => {
    for (; i < lines.length; i++) {
      const raw = lines[i];
      const t = raw.trim();
      if (t === '' || t[0] === '#' || t === '---' || t === '...') continue;
      const lead = /^[ \t]*/.exec(raw)[0];
      if (lead.includes('\t')) throw new YamlError('tab character in indentation', i + 1);
      return { indent: lead.length, text: raw.slice(lead.length).trimEnd(), n: i + 1 };
    }
    return null;
  };
  const isSeq = (t) => t === '-' || t.startsWith('- ');

  function blockScalar(parentIndent, style) {
    const buf = [];
    let ind = null;
    for (; i < lines.length; i++) {
      const raw = lines[i];
      if (raw.trim() === '') { buf.push(''); continue; }
      const cur = raw.length - raw.trimStart().length;
      if (cur <= parentIndent) break;
      if (ind === null) ind = cur;
      if (cur < ind) break;
      buf.push(raw.slice(ind).trimEnd());
    }
    while (buf.length && buf[buf.length - 1] === '') buf.pop();
    if (style === '|') return buf.join('\n');
    return buf.join('\n').split(/\n{2,}/).map((p) => p.split('\n').join(' ')).join('\n');
  }

  function valueAfterKey(rest, indent, n) {
    const r = rest === undefined ? '' : stripComment(rest).trim();
    if (r === '') {
      const nx = peek();
      if (nx && nx.indent > indent) return parseBlock(nx.indent);
      if (nx && nx.indent === indent && isSeq(nx.text)) return parseSeq(indent);
      return null;
    }
    const bs = /^([|>])[-+]?\d*$/.exec(r);
    if (bs) return blockScalar(indent, bs[1]);
    return parseScalar(r, n);
  }

  function parseMap(indent) {
    const out = {};
    for (;;) {
      const l = peek();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) throw new YamlError('unexpected indentation', l.n);
      if (isSeq(l.text)) break;
      const m = KEY.exec(l.text);
      if (!m) throw new YamlError(`expected "key: value", got "${l.text}"`, l.n);
      const key = String(parseScalar(m[1], l.n));
      if (FORBIDDEN_KEYS.has(key)) throw new YamlError(`key "${key}" is not allowed`, l.n);
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`duplicate key "${key}"`, l.n);
      i++;
      out[key] = valueAfterKey(m[2], indent, l.n);
    }
    return out;
  }

  function parseSeq(indent) {
    const out = [];
    for (;;) {
      const l = peek();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) throw new YamlError('unexpected indentation', l.n);
      if (!isSeq(l.text)) break;
      const after = l.text === '-' ? '' : l.text.slice(1);
      const pad = after.length - after.trimStart().length;
      const rest = after.trimStart();
      if (rest === '' || stripComment(rest) === '') {
        i++;
        const nx = peek();
        out.push(nx && nx.indent > indent ? parseBlock(nx.indent) : null);
      } else if (KEY.test(rest) || isSeq(rest)) {
        const childIndent = indent + 1 + pad;
        lines[i] = ' '.repeat(childIndent) + rest; // re-read as the first line of a nested block
        out.push(parseBlock(childIndent));
      } else {
        i++;
        const bs = /^([|>])[-+]?\d*$/.exec(stripComment(rest).trim());
        out.push(bs ? blockScalar(indent, bs[1]) : parseScalar(rest, l.n));
      }
    }
    return out;
  }

  function parseBlock(indent) {
    const l = peek();
    if (!l || l.indent < indent) return null;
    if (isSeq(l.text)) return parseSeq(l.indent);
    if (KEY.test(l.text)) return parseMap(l.indent);
    i++;
    return parseScalar(l.text, l.n);
  }

  const first = peek();
  if (!first) return null;
  const value = parseBlock(first.indent);
  const extra = peek();
  if (extra) throw new YamlError(`unexpected content "${extra.text}"`, extra.n);
  return value;
}

function needsQuote(s) {
  return (
    s === '' ||
    /^\s|\s$/.test(s) ||
    /^[-?:,\[\]{}#&*!|>'"%@`]/.test(s) ||
    /:\s|\s#|:$/.test(s) ||
    /^(null|Null|NULL|~|true|True|TRUE|false|False|FALSE)$/.test(s) ||
    /^[-+]?(\d|\.\d)/.test(s) && !Number.isNaN(Number(s)) ||
    /[\n\r\t]/.test(s)
  );
}

function fmtScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  return needsQuote(s) ? JSON.stringify(s) : s;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFilled = (v) => (Array.isArray(v) && v.length > 0) || (isObj(v) && Object.keys(v).length > 0);
const inline = (v) => (Array.isArray(v) ? '[]' : isObj(v) ? '{}' : fmtScalar(v));

function emit(v, ind) {
  const pad = ' '.repeat(ind);
  const out = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      if (isFilled(item)) {
        const sub = emit(item, ind + 2);
        out.push(pad + '- ' + sub[0].trimStart(), ...sub.slice(1));
      } else {
        out.push(pad + '- ' + inline(item));
      }
    }
    return out;
  }
  if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      const key = needsQuote(k) ? JSON.stringify(k) : k;
      if (isFilled(val)) out.push(pad + key + ':', ...emit(val, ind + 2));
      else out.push(pad + key + ': ' + inline(val));
    }
    return out;
  }
  return [pad + fmtScalar(v)];
}

function dump(value) {
  if (!isFilled(value)) return inline(value) + '\n';
  return emit(value, 0).join('\n') + '\n';
}

/** Return the last fenced yaml block in a worker message, or the text itself. */
function extractYamlBlock(text) {
  const re = /```(?:ya?ml)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;
  let m;
  let last = null;
  while ((m = re.exec(String(text)))) {
    if (/^\s*["']?[\w-]+["']?\s*:/m.test(m[1])) last = m[1];
  }
  return last !== null ? last : String(text);
}

module.exports = { parse, dump, extractYamlBlock, YamlError };
