'use strict';

// SIMULATED worker output (scripted, no model): slugify after the correction request,
// which asked for exactly the change that the failing acceptance check named.
const MAX_LENGTH = 40;

function slugify(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/-+$/, '');
}

module.exports = { slugify };
