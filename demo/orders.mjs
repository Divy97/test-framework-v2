// Reading orders, as a function.
//
// Separate from `server.mjs` for the same reason `page.mjs` is: a reproduction of the
// filter bug has to be runnable in a sealed phase container, where there is no service
// listening and no network. SQLite is a file, so a test can migrate, seed and query
// with nothing running — which is what makes the API bug provable by an exit code.

export function selectOrders(db, status) {
  // BUG shipped-filter: `status` is accepted and then ignored, so every order comes
  // back whatever was asked for.
  return db.prepare('select id, customer, status, cents from orders order by id').all();
}
