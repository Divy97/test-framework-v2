// The demo's own suite. It PASSES on the buggy tree, and that is the point: the
// recipe's `test` command has to be a command that works before the agent shows
// up, or a red base phase would mean nothing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrate, open, seed } from '../db.mjs';
import { page } from '../page.mjs';

test('the seed loads and totals are what the fixture says', () => {
  migrate();
  seed();
  const db = open();
  const rows = db.prepare('select id, cents from orders order by id').all();
  db.close();
  assert.equal(rows.length, 4);
  // Order 3 is the control fixture: 999 cents is $9.99 and the issue claiming
  // otherwise is claiming something false.
  assert.equal(rows.find((row) => row.id === 3).cents, 999);
});

test('the page renders a row per order', () => {
  // Deliberately NOT asserting the heading. The heading is a seeded bug and this suite
  // has to pass on the buggy tree — the recipe's `test` command is what an agent runs
  // before it has written anything, and a red one would mean nothing.
  migrate();
  seed();
  const db = open();
  const rows = db.prepare('select id, customer, status, cents from orders order by id').all();
  db.close();
  const html = page(rows);
  assert.match(html, /<td>Grace<\/td>/);
  assert.match(html, /\$40\.75/);
});
