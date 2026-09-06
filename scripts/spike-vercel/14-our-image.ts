// Item 14, added after the first live runs. Not a question about Vercel — a question
// about OUR images, which the first thirteen never asked because they all ran against
// the managed one.
//
// Two live runs have now died on the difference: `timeout restricted to <= 45m` and
// `sh: sudo: not found`. Both were unfindable against the fake and obvious in one
// round trip here. This asks the rest of the questions before a third one does.
import { create, sh, verdict, record, done, stopQuietly, IMAGE } from './lib.js';

const sandbox = await create({ networkPolicy: 'deny-all' });
try {
  record('14', `image ${IMAGE}`);

  const who = await sh(sandbox, 'id -u; pwd; command -v sudo || echo NO_SUDO');
  const [uid, cwd, sudo] = who.out.split('\n');
  record('14', `uid ${uid}, cwd ${cwd}, sudo ${sudo}`);
  verdict('14.root', uid === '0', `commands run as uid ${uid}`);

  // Where the engine's code actually is. `executor-vercel.ts` names
  // `/engine/src/runner-vm.ts`, and the Dockerfile's WORKDIR is `/app`.
  const where = await sh(sandbox, 'ls -d /engine /app 2>&1; ls /app/src/runner-vm.ts /engine/src/runner-vm.ts 2>&1');
  record('14', where.out.replace(/\n/g, ' | '));
  verdict('14.engine-path', where.out.includes('/engine/src/runner-vm.ts') && !where.out.includes('No such file or directory'), 'the path the executor starts exists');

  // Whether the Runner can actually be started, from whatever cwd `sh -c` gives us.
  // `--import tsx` is a BARE specifier: node resolves it from the cwd upwards, so a
  // command that runs from `/` finds no `node_modules` and dies on the loader rather
  // than on the script.
  const boot = await sh(sandbox, 'node --import tsx /app/src/runner-vm.ts --help 2>&1 | head -5; echo "EXIT=$?"');
  record('14', `from default cwd: ${boot.out.replace(/\n/g, ' | ')}`);

  const bootCd = await sh(sandbox, 'cd /app && node --import tsx src/runner-vm.ts --help 2>&1 | head -5; echo "EXIT=$?"');
  record('14', `from /app: ${bootCd.out.replace(/\n/g, ' | ')}`);
  verdict('14.tsx-resolves', !bootCd.out.includes('ERR_MODULE_NOT_FOUND'), 'tsx resolves for the Runner');

  // The repro's user. On the managed image the default IS uid 1000, so the separation
  // came for free; on an image that runs as root it has to be made.
  const node = await sh(sandbox, 'id -u node 2>&1');
  record('14', `uid of the \`node\` user: ${node.out.trim()}`);
  verdict('14.node-user', node.out.trim() === '1000', 'the image ships the uid 1000 the repro drops to');
} finally {
  await stopQuietly(sandbox);
}
done();
