// Item 14, added after the first live runs. Not a question about Vercel — a question
// about OUR images, which the first thirteen never asked because they all ran against
// the managed one.
//
// Three live runs have now died on the difference: `timeout restricted to <= 45m`,
// `sh: sudo: not found`, and an entrypoint at a path no Dockerfile creates. All three
// were unfindable against the fake and obvious in one round trip here. This asks the
// rest of the questions before a fourth one does.
import { create, sh, verdict, record, done, stopQuietly, probes, sealedFailure, IMAGE } from './lib.js';

const sandbox = await create({ networkPolicy: 'deny-all' });
try {
  record('14', `image ${IMAGE}`);

  const who = await sh(sandbox, 'id -u; pwd; command -v sudo || echo NO_SUDO');
  const [uid, cwd, sudo] = who.out.split('\n');
  record('14', `uid ${uid}, cwd ${cwd}, sudo ${sudo}`);
  verdict('14.root', uid === '0', `commands run as uid ${uid}`);
  // The cwd is why `--import tsx` can be a bare specifier in the entrypoint: node
  // resolves it from the cwd upwards, so the same command from `/` dies in the loader.
  verdict('14.cwd', cwd === '/app', `sh -c starts in ${cwd}, and the image's WORKDIR is /app`);

  // Where the engine's code actually is. The executor's default named
  // `/engine/src/runner-vm.ts` until this script said otherwise: no Dockerfile has ever
  // created `/engine`, and the answer here is why the default is now `/app`.
  const where = await sh(sandbox, 'ls -d /engine /app 2>&1; ls /app/src/runner-vm.ts 2>&1');
  record('14', where.out.replace(/\n/g, ' | '));
  verdict('14.runner-path', !/\/app\/src\/runner-vm\.ts: No such/.test(where.out), '/app/src/runner-vm.ts exists');
  verdict('14.no-engine-dir', /\/engine: No such file/.test(where.out), '/engine does not exist, and nothing should name it');

  // Whether the Runner actually starts. `ENOENT /work/job.json` is the Runner running
  // and finding no Job — which is exactly as far as it should get with nothing prepared.
  const boot = await sh(sandbox, 'node --import tsx /app/src/runner-vm.ts 2>&1 | head -3');
  record('14', `boot: ${boot.out.replace(/\n/g, ' | ')}`);
  verdict('14.boots', boot.out.includes('job.json') && !boot.out.includes('ERR_MODULE_NOT_FOUND'), 'the Runner starts and looks for its Job');

  // The repro's user. On the managed image the default IS uid 1000, so the separation
  // came for free; on an image whose commands are root it has to be made.
  const node = await sh(sandbox, 'id -u node 2>&1');
  record('14', `uid of the \`node\` user: ${node.out.trim()}`);
  verdict('14.node-user', node.out.trim() === '1000', 'the image ships the uid 1000 the repro drops to');

  // The rest of the vocabulary `executor-vercel.ts` speaks into a sandbox. Alpine's
  // `/bin/sh` is busybox ash and its coreutils are busybox applets, not GNU — the flags
  // that work on the managed image's Ubuntu are not automatically here.
  const tools = await sh(
    sandbox,
    [
      'mkdir -p /tmp/k/a && printf hi > /tmp/k/a/f',
      'tar -cf /tmp/k.tar -C /tmp/k . && echo "TAR $?"',
      'tar -tf /tmp/k.tar | tr "\\n" " "',
      'printf %s aGVsbG8= | base64 -d',
      'printf x | tee /tmp/k/t > /dev/null && test -s /tmp/k/t && echo TEE_OK',
      'chmod -R 0700 /tmp/k && chown -R root:root /tmp/k && echo PERMS_OK',
      'rm -rf /tmp/k && echo RM_OK',
    ].join('; '),
  );
  record('14', tools.out.replace(/\n/g, ' | '));
  for (const [name, want] of [
    ['tar-c', 'TAR 0'],
    ['tar-t', './a/f'],
    ['base64-d', 'hello'],
    ['tee', 'TEE_OK'],
    ['perms', 'PERMS_OK'],
    ['rm', 'RM_OK'],
  ] as const) {
    verdict(`14.${name}`, tools.out.includes(want), `expected ${want}`);
  }

  // The two egress probes the executor seals with, run here so the words THIS image
  // produces are recorded rather than assumed. `sealedFailure` is what the executor
  // believes about them.
  const { dns, udp } = probes();
  const sealed = await Promise.all([sh(sandbox, dns), sh(sandbox, udp)]);
  record('14', `probes: ${sealed.map((one) => `${one.out} (exit ${one.code})`).join(' | ')}`);
  verdict('14.probes-sealed', sealed.every(sealedFailure), 'both probes fail the way a sealed sandbox fails');
} finally {
  await stopQuietly(sandbox);
}
done();
