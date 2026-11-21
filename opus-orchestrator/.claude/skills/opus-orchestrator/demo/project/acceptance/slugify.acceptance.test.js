'use strict';
// Acceptance checks for slugify that go beyond the unit tests. They encode the
// owner's rule for very long titles, which the task description does not state.
const test = require('node:test');
const assert = require('node:assert/strict');
const { slugify } = require('../src/slugify.js');

test('a long title is cut to at most 40 characters', () => {
  const slug = slugify('a'.repeat(100));
  assert.equal(slug.length, 40);
});

test('the cut never leaves a trailing dash', () => {
  const slug = slugify('The quick brown fox jumps over the lazy dog and keeps running far away');
  assert.equal(slug, 'the-quick-brown-fox-jumps-over-the-lazy');
});

test('a slug that already fits is left alone', () => {
  assert.equal(slugify('A short title'), 'a-short-title');
});
