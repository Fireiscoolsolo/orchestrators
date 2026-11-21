'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { slugify } = require('../src/slugify.js');

test('lowercases and joins words with single dashes', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('collapses runs of punctuation and spaces into one dash', () => {
  assert.equal(slugify('Rock & Roll -- live!'), 'rock-roll-live');
});

test('removes accents', () => {
  assert.equal(slugify('Crème Brûlée à la carte'), 'creme-brulee-a-la-carte');
});

test('has no leading or trailing dash', () => {
  assert.equal(slugify('  ...Hello, World!!!  '), 'hello-world');
});

test('keeps digits', () => {
  assert.equal(slugify('Top 10 tips for 2026'), 'top-10-tips-for-2026');
});

test('returns an empty string when nothing is left', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify('?!?'), '');
});
