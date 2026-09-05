// Item 10. The root model the Runner assumes: the default user is uid 1000, root is one
// `sudo` away, root can SIGSTOP a uid-1000 process (the reap), `chown` works, and uid 1000
// cannot read root's stdout through /proc.
//
// The managed image's `/bin/sh` is dash and it ships no `procps`, so nothing here uses
// `pgrep`, `exec -a` or bash-isms. Pids come from `$!` written to a file.
import { create, sh, verdict, record, done, stopQuietly } from './lib.js';

const sandbox = await create({ networkPolicy: 'deny-all' });
try {
  const who = await sh(sandbox, 'id -u; id -un; sudo -n id -u 2>&1');
  const [uid, name, asRoot] = who.out.split('\n');
  record('10', `default user uid ${uid} (${name}); sudo -n id -u → ${asRoot}`);
  verdict('10.uid-1000', uid === '1000', `default user is uid ${uid}`);
  verdict('10.sudo', asRoot === '0', `sudo -n id -u → ${asRoot}`);

  // A uid-1000 sleep, kept alive by its parent shell so the detached command owns it,
  // with its pid written before the wait.
  await sandbox.runCommand({ cmd: 'sh', args: ['-c', 'sleep 300 & echo $! > /tmp/u.pid; wait'], detached: true });
  await new Promise((r) => setTimeout(r, 800));
  const stop = await sh(sandbox, 'p=$(cat /tmp/u.pid); sudo -n kill -STOP "$p" && grep State /proc/"$p"/status && stat -c %u /proc/"$p"; sudo -n kill -KILL "$p"');
  verdict('10.root-stops-uid-1000', /State:\s+T/.test(stop.out) && /\n1000\s*$/.test(`\n${stop.out}`), stop.out.replace(/\n/g, ' | ') || `exit ${stop.code}`);

  const chown = await sh(sandbox, 'sudo -n sh -c "touch /tmp/x && chown 1000:1000 /tmp/x && stat -c %u /tmp/x"');
  verdict('10.chown', chown.out.trim() === '1000', chown.out || `exit ${chown.code}`);

  // Root's process, then its fd/1 read as the default user: the Runner relies on this being refused.
  await sandbox.runCommand({ cmd: 'sh', args: ['-c', 'sleep 30 > /tmp/root-out & echo $! > /tmp/root.pid; wait'], sudo: true, detached: true });
  await new Promise((r) => setTimeout(r, 800));
  const fd = await sh(sandbox, 'p=$(cat /tmp/root.pid); readlink /proc/"$p"/fd/1 2>&1 || echo FD_UNREADABLE');
  verdict('10.fd-unreadable', /FD_UNREADABLE|Permission denied/.test(fd.out), fd.out.replace(/\n/g, ' | '));
} finally {
  await stopQuietly(sandbox);
}
done();
