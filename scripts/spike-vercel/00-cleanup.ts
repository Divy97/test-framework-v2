// Stop every sandbox a spike left behind. Run it first, and after any script that died.
import { Sandbox } from '@vercel/sandbox';
import { creds, TAG, record } from './lib.js';

const page = await Sandbox.list({ ...creds(), tags: TAG });
let stopped = 0;
for (const entry of page.sandboxes) {
  if (entry.status !== 'running' && entry.status !== 'pending') continue;
  try {
    const sandbox = await Sandbox.get({ ...creds(), name: entry.name });
    await sandbox.stop();
    stopped += 1;
  } catch (error) {
    record('cleanup', `${entry.name}: ${String((error as Error).message ?? error)}`);
  }
}
record('cleanup', `${page.sandboxes.length} tagged, ${stopped} stopped`);
