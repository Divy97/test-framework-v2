// The orders page, as a function.
//
// Separate from `server.mjs` so it can be rendered without booting anything. That is
// not tidiness: it is what makes a reproduction of the copy bug runnable in a sealed
// phase container with no browser and no service in it. A test that had to fetch a
// URL would need the app up; a test that grepped the source would be an oracle over
// the tree rather than over the behaviour.

export const page = (rows) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Orders</title></head>
<body>
<!-- BUG orders-heading: this heading is misspelled. Only visible by rendering. -->
<h1>Ordres</h1>
<table>
<tr><th>Order</th><th>Customer</th><th>Status</th><th>Total</th></tr>
${rows
  .map(
    (row) =>
      `<tr><td>${row.id}</td><td>${row.customer}</td><td>${row.status}</td>` +
      `<td>$${(row.cents / 100).toFixed(2)}</td></tr>`,
  )
  .join('\n')}
</table>
</body>
</html>
`;
