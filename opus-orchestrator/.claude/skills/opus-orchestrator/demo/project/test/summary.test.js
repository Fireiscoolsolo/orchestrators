'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../src/summary.js');

test('summarize returns the slug and the word count', () => {
  assert.deepEqual(summarize('Hello, World!'), { slug: 'hello-world', words: 2 });
});

test('summarize handles an empty text', () => {
  assert.deepEqual(summarize(''), { slug: '', words: 0 });
});

test('summarize counts words from the original text, not from the slug', () => {
  assert.deepEqual(summarize('Rock & Roll -- live!'), { slug: 'rock-roll-live', words: 5 });
});
