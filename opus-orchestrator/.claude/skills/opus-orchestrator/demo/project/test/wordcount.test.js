'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { wordcount } = require('../src/wordcount.js');

test('counts words separated by single spaces', () => {
  assert.equal(wordcount('one two three'), 3);
});

test('treats runs of whitespace, tabs and newlines as one separator', () => {
  assert.equal(wordcount('  one \t two\n\nthree  '), 3);
});

test('returns 0 for an empty or blank text', () => {
  assert.equal(wordcount(''), 0);
  assert.equal(wordcount('  \n\t '), 0);
});

test('counts punctuation attached to a word as part of that word', () => {
  assert.equal(wordcount('Hello, world! Again...'), 3);
});
