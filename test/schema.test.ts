// The property that makes a migration runner unnecessary (M10).
//
// `npm run db:apply` pipes `db/schema.sql` at whatever `DATABASE_URL` names and does no
// bookkeeping: no versions table, no ordering, no up and down. That is sound for exactly
// one reason — every statement in the file is idempotent, so applying it twice is applying
// it once, and a half-finished apply can be re-run rather than reasoned about.
//
// It is a property of the FILE, and a file is edited by whoever needs a column next. One
// plain `create table` and the command silently stops being safe to re-run: the second
// apply fails partway, having already committed the statements before it. So the property
// is asserted rather than remembered.
//
// When this test becomes a nuisance — a rename, a backfill, anything that must TRANSFORM
// data — that is the signal to build the versioned runner, not to loosen this.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

/** Every DDL statement the file opens, with its leading keywords. */
const statements = [...schema.matchAll(/^(create|alter|drop)\b[^;]*/gim)].map((match) =>
  match[0].replace(/\s+/g, ' ').trim(),
);

describe('db/schema.sql can be applied twice', () => {
  test('every statement in it is idempotent', () => {
    // Enumerated rather than counted: a failure has to say WHICH line is not safe to
    // re-run, or the person reading it has to diff twenty statements by eye.
    const notIdempotent = statements.filter(
      (statement) => !/\bif not exists\b/i.test(statement) && !/\bif exists\b/i.test(statement),
    );
    expect(notIdempotent).toEqual([]);
  });

  test('and there is something to be idempotent about', () => {
    // THE control. The filter above is vacuously satisfied by a regex that matches
    // nothing — a schema file renamed or a pattern that stopped working would read as a
    // clean pass forever.
    expect(statements.length).toBeGreaterThan(15);
    expect(statements.some((one) => /^create table/i.test(one))).toBe(true);
    expect(statements.some((one) => /^alter table/i.test(one))).toBe(true);
  });

  test('nothing in it destroys data, because this file is run against production', () => {
    // `db:apply` points at whatever `DATABASE_URL` says, and that is the hosted database.
    // A `drop table` here would be a command an operator runs to add a column and which
    // silently takes a table away.
    expect(schema).not.toMatch(/^\s*drop\s+(table|column|database)/im);
    expect(schema).not.toMatch(/^\s*truncate/im);
  });
});
