// The demo storefront. One file, no dependencies, two seeded bugs.
//
// The bugs are ordinary mistakes rather than puzzles: a typo in a heading and a
// dropped WHERE clause. That is deliberate — a demo whose bugs are cleverer than
// real bugs proves nothing about real bugs.

import { createServer } from 'node:http';
import { open } from './db.mjs';
import { page } from './page.mjs';
import { selectOrders } from './orders.mjs';

const PORT = Number(process.env.PORT ?? 8080);

const json = (response, status, body) => {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/healthz') {
    json(response, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/orders') {
    const db = open();
    const status = url.searchParams.get('status');
    const rows = selectOrders(db, status);
    db.close();
    json(response, 200, { status, orders: rows });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/orders') {
    const db = open();
    const rows = db.prepare('select id, customer, status, cents from orders order by id').all();
    db.close();
    const body = page(rows);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
    return;
  }

  json(response, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`demo listening on http://127.0.0.1:${PORT}`);
});
