// The demo's database. `node:sqlite` because a dependency-free demo is one that
// never flakes on a registry, and ADR-0013's recipe still has an install step so
// the network asymmetry it describes is exercised either way.

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const DB_PATH = join(dirname(fileURLToPath(import.meta.url)), 'demo.db');

export const open = () => new DatabaseSync(DB_PATH);

export function migrate() {
  const db = open();
  db.exec(`
    create table if not exists orders (
      id integer primary key,
      customer text not null,
      status text not null,
      cents integer not null
    );
  `);
  db.close();
  return 'migrated';
}

export function seed() {
  const db = open();
  db.exec('delete from orders');
  const insert = db.prepare('insert into orders (id, customer, status, cents) values (?, ?, ?, ?)');
  // Order 3 is the control fixture: its total is correct, and the issue claiming
  // otherwise must not reproduce.
  insert.run(1, 'Ada', 'pending', 1250);
  insert.run(2, 'Grace', 'shipped', 4075);
  insert.run(3, 'Alan', 'shipped', 999);
  insert.run(4, 'Edsger', 'cancelled', 300);
  db.close();
  return 'seeded 4 orders';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'migrate') console.log(migrate());
  else if (command === 'seed') console.log(seed());
  else {
    console.error('usage: node db.mjs migrate | seed');
    process.exitCode = 1;
  }
}
