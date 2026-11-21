'use strict';

// SIMULATED worker output (scripted, no model).
function wordcount(text) {
  const words = String(text).trim().split(/\s+/);
  return words[0] === '' ? 0 : words.length;
}

module.exports = { wordcount };
