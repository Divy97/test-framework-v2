// The Runner, on a machine we own but are not PID 1 of (M10, ADR-0021).
//
// Docker hands this engine a container it owns outright: the Runner is PID 1, the Job
// arrives on stdin, tool calls come back down the same pipe, and `/blobs` is a bind mount
// that already outlives the container. A microVM gives none of those. There is no stdin on
// a command a substrate starts for us, the machine is shared with the substrate's own
// agent, and the store is an ordinary directory the worker copies out before destroying
// the machine.
//
// So the same `runJob` runs here with three things supplied differently:
//
//   - **The Job is a file.** `--job /work/job.json`, written before this starts.
//   - **Tool calls are files.** The host drops `<spool>/in/<n>.json`, this yields them in
//     order, and every reply is mirrored to `<spool>/out/<id>.json` — the durable path
//     behind the stdout one, for a stream that drops mid-phase (the spike found
//     re-attaching to a command's output replays a window and then closes, so the stream
//     is not resumable and the files are what recovery reads).
//   - **The teardown is scoped to a uid**, because sweeping `/proc` here would stop the
//     substrate's agent along with the agent's leftovers.
//
// What does NOT change is the shape of the channel: one JSON object per line on stdout,
// events and replies interleaved, exactly as the container writes them. The executor above
// demultiplexes the same way for both substrates, which is the point of the seam.
//
// `/work/rpc` is root-owned 0700, so the repro — uid 1000 — cannot forge a `{done: true}`
// and choose its own ending, and cannot answer a tool call on the host's behalf.

import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT, isWorkerReply, REPRO_UID, runJob, type Job } from './runner.js';
import { ObservationFailed } from './verify.js';

const WORK = '/work';
const BLOBS = '/blobs';

/** How often the spool is re-read when it is empty. */
const POLL_MS = 50;

/**
 * Tool calls, in the order the host wrote them.
 *
 * A file per call, named with an increasing integer, deleted once it has been read so the
 * directory cannot grow across a long agent session. A file that does not parse yet is
 * left alone and retried on the next pass rather than skipped: `writeFiles` makes no
 * promise about atomicity, and a half-written call read as garbage would hang the host
 * waiting for a reply to a call this end never saw whole.
 *
 * The generator never returns on its own. `serveToolCalls` returns when it reads
 * `{done: true}`, which closes this — the same lifetime the stdin reader has in Docker.
 *
 * ponytail: polled, not watched. `fs.watch` needs a fallback on every filesystem that does
 * not support it, and a tool call already costs a `writeFiles` API round trip of a few
 * hundred milliseconds, so 50ms of latency here is not the thing to optimise. Move to
 * `fs.watch` with this as the fallback if a profile ever says the poll costs anything.
 */
export async function* spoolRequests(
  dir: string,
  options: { pollMs?: number } = {},
): AsyncGenerator<string> {
  const pollMs = options.pollMs ?? POLL_MS;
  const index = (name: string) => Number(name.replace(/\D+/g, '')) || 0;
  for (;;) {
    const names = (await readdir(dir).catch(() => [] as string[]))
      .filter((name) => name.endsWith('.json'))
      .sort((a, b) => index(a) - index(b));
    let read = 0;
    for (const name of names) {
      const path = join(dir, name);
      const raw = await readFile(path, 'utf8').catch(() => null);
      if (raw === null) continue;
      const line = raw.trim();
      if (line === '') continue;
      try {
        JSON.parse(line);
      } catch {
        // Still being written. Leave it and come back.
        continue;
      }
      await rm(path, { force: true }).catch(() => {});
      read += 1;
      yield line;
    }
    if (read === 0) await new Promise((done) => setTimeout(done, pollMs));
  }
}

/** `--job=/path` or `--job /path`, with a default. */
export const flag = (argv: string[], name: string, fallback: string): string => {
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  const next = at === -1 ? undefined : argv[at + 1];
  // `--job --spool x` gives `job` no value. Taking `--spool` as a path would read the Job
  // out of a file nobody wrote and fail somewhere far from the mistake.
  return next !== undefined && !next.startsWith('--') ? next : fallback;
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const jobPath = flag(argv, 'job', `${WORK}/job.json`);
  const spool = flag(argv, 'spool', `${WORK}/rpc`);

  // THE PRECONDITION, enforced rather than assumed (10a item 10, ADR-0006).
  //
  // The spike found that on the managed image uid 1000 can `readlink` a root process's
  // `/proc/<pid>/fd/1` — which is a reminder of where the protection actually comes from.
  // The container entrypoint's fd/1 dead end closes ONE path to the channel; what keeps
  // the repro away from the private handle beside it is the kernel refusing one user the
  // fds of another. If the Runner runs as the same uid the repro drops to, that refusal
  // is gone: the agent can enumerate `/proc`, find this process, open the channel and
  // write forged events onto it.
  //
  // Vercel's managed images run as uid 1000 by default — the very uid `runAs` drops to —
  // so this is not hypothetical, and it is the sort of thing that would hold in a test
  // and quietly not hold in production. The worker starts this with `sudo` (ADR-0021);
  // refusing here is what makes forgetting to a loud failure rather than a silent one.
  const me = process.getuid?.();
  if (me === REPRO_UID) {
    throw new ObservationFailed(
      `the Runner is running as uid ${REPRO_UID}, the same user the repro drops to; ` +
        'nothing would separate the agent from the event channel — start it as another user (sudo)',
    );
  }

  // The same dead end the container entrypoint takes: this process's fd 1 IS the event
  // channel, and a participant that can write to it can forge events and truncate the one
  // before them (ADR-0006). Being PID 1 was never what made that work — holding a private
  // handle, and being a different user, is.
  const channel = openSync('/proc/self/fd/1', 'w');
  closeSync(1);
  openSync('/dev/null', 'w');

  const out = join(spool, 'out');
  await mkdir(out, { recursive: true, mode: 0o700 });

  /**
   * Every reply reaches the host twice: on the channel, which is fast and can drop, and as
   * a file, which is slow and cannot. Only replies — events are the log's, and the log has
   * its own durability in the plane.
   */
  const emit = (line: string) => {
    writeSync(channel, line);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (isWorkerReply(parsed) && 'result' in parsed) {
      // The id becomes a filename, and it is whatever the host called the tool call —
      // `ToolHost` echoes it back verbatim. Confined to one path segment rather than
      // trusted: `../` in an id would put a reply outside the spool.
      const id = parsed.result.id.replace(/[^A-Za-z0-9_-]/g, '') || 'reply';
      void writeFile(join(out, `${id}.json`), line).catch(() => {
        // The channel already carried it. A mirror that cannot be written is a recovery
        // path that will not be there, never a reason to fail the phase.
      });
    }
  };

  const job = JSON.parse(await readFile(jobPath, 'utf8')) as Job;
  return await runJob(job, WORK, BLOBS, emit, spoolRequests(join(spool, 'in')), {
    store: 'collected',
    field: { uid: REPRO_UID },
  });
}

if (process.argv[1]?.endsWith('runner-vm.ts') || process.argv[1]?.endsWith('runner-vm.js')) {
  main()
    .then((code) => {
      // Set, never `process.exit`: stdout on a pipe is asynchronous and exiting discards
      // what is still queued — the truncation that once cut a FIX_DIFF_OBSERVED in half
      // while the run reported success.
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // The same split the container entrypoint makes, and for the reason `EXIT`'s own
      // comment gives: `partial` and `silent` demand opposite things of a caller — fold
      // the channel, or ignore it and read stderr — so collapsing them leaves the
      // executor unable to tell evidence from nothing. The store refusal above is an
      // `ObservationFailed`, and would otherwise reach 10d as an indistinguishable 1.
      const failed = error instanceof ObservationFailed;
      process.stderr.write(`${failed ? 'ObservationFailed' : 'RunnerError'}: ${String(error)}\n`);
      process.exitCode = failed ? EXIT.silent : EXIT.bug;
    });
}
