// Stop every sandbox a spike left behind. Run it first, and after any script that died.
import { Sandbox } from '@vercel/sandbox';
import { creds, TAG, record } from './lib.js';

const page = await Sandbox.list({ ...creds(), tags: TAG });
let seen = 0;
let stopped = 0;
// The paginator iterates across pages; `page.sandboxes` alone is the first page.
for await (const entry of page) {
  seen += 1;
  if (entry.status !== 'running' && entry.status !== 'pending') continue;
  try {
    const sandbox = await Sandbox.get({ ...creds(), name: entry.name });
    await sandbox.stop();
    stopped += 1;
  } catch (error) {
    record('cleanup', `${entry.name}: ${String((error as Error).message ?? error)}`);
  }
}
record('cleanup', `${seen} tagged, ${stopped} stopped`);
