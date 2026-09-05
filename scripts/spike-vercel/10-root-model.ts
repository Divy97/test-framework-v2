// Item 10. The root model the Runner assumes: sudo, uid 1000, root can SIGSTOP uid 1000,
// chown works, and uid 1000 cannot read root's fd/1.
import { create, sh, verdict, record, done, stopQuietly } from './lib.js';

const sandbox = await create({ networkPolicy: 'deny-all' });
try {
  const who = await sh(sandbox, 'id -u; id -un; sudo -n id -u 2>&1');
  record('10', `default user / sudo: ${who.out.replace(/\n/g, ' ')}`);
  verdict('10.sudo', who.out.trim().endsWith('0'), 'sudo -n id -u → 0');
  const uid = await sh(sandbox, 'getent passwd 1000 || id 1000 2>&1 || echo NO_UID_1000');
  record('10', `uid 1000: ${uid.out}`);
  const stop = await sh(
    sandbox,
    'sudo -n sh -c \'(exec -a spikesleep sleep 300 &) ; sleep 0.5; pid=$(pgrep -f spikesleep | head -1); kill -STOP $pid && grep State /proc/$pid/status; kill -KILL $pid\'',
    { sudo: true },
  );
  verdict('10.sigstop', /State:\s+T/.test(stop.out), stop.out.replace(/\n/g, ' ') || `exit ${stop.code}`);
  const chown = await sh(sandbox, 'sudo -n sh -c "touch /tmp/x && chown 1000:1000 /tmp/x && stat -c %u /tmp/x"');
  verdict('10.chown', chown.out.trim() === '1000', chown.out || `exit ${chown.code}`);
  const fd = await sh(sandbox, 'sudo -n sh -c "sleep 30 > /tmp/root-out & echo \\$! > /tmp/root-pid"; sleep 0.3; p=$(cat /tmp/root-pid); id -u; readlink /proc/$p/fd/1 2>&1 || echo FD_UNREADABLE');
  record('10', `/proc/<root>/fd/1 as default user: ${fd.out.replace(/\n/g, ' ')}`);
} finally {
  await stopQuietly(sandbox);
}
done();
