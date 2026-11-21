'use strict';

// SIMULATED worker output (scripted, no model).
const { slugify } = require('./slugify.js');
const { wordcount } = require('./wordcount.js');

function summarize(text) {
  return { slug: slugify(text), words: wordcount(text) };
}

module.exports = { summarize };
