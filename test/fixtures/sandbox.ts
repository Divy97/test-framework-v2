// A substrate that is not there (M10, 10d).
//
// `executor-vercel.ts` is where the seal, the ordering and the teardown live, and all
// three are decisions rather than transport — so they have to be testable without a
// Vercel account, a token, or a network. This is the `SandboxClient` the executor talks
// to, with an in-memory filesystem and a scripted Runner.
//
// What it deliberately does NOT fake is the protocol. The lines a script yields are the
// same JSON-lines channel `runner.ts` writes, and the tool calls it reads are the same
// files `writeFiles` puts in the spool — so a test that passes here is a test about the
// executor's logic and not about a mock that agrees with it.
//
// The network is modelled as one function of the sandbox's current policy, because that
// is exactly the thing under test: an executor that probed before flipping, or believed
// the policy field instead of the probe, would see a different answer here than a correct
// one does.

import { SessionEnded } from '../../src/vercel-client.js';
import type {
  Compute,
  NetworkPolicy,
  SandboxClient,
  SandboxHandle,
  Started,
} from '../../src/vercel-client.js';

export type FakeSandbox = {
  id: string;
  from: { image: string } | { snapshot: string };
  /** What it was created with, never overwritten — so a test can assert the CREATE policy. */
  readonly createdWith: NetworkPolicy;
  policy: NetworkPolicy;
  files: Map<string, Buffer>;
  /** Every shell line the executor ran, in order. */
  commands: string[];
  /** When the policy last changed, as a count of commands run — enough to order events. */
  flippedAfter: number | null;
  stopped: boolean;
  /** The session length this sandbox was created with, so a test can assert the clamp. */
  timeoutMs: number;
  tags: Record<string, string>;
  /** The paths `PREPARE` made, so a test can assert the Runner's world exists. */
  prepared: Set<string>;
};

/** What a scripted Runner is given: the sandbox, and a way to read the tool calls sent to it. */
export type RunnerContext = {
  sandbox: FakeSandbox;
  /** Every `{call}`/`{done}` line written into the spool so far, in order. */
  spool(): string[];
  /** Resolves once a line matching the predicate has been written into the spool. */
  awaitSpool(match: (line: string) => boolean): Promise<string>;
};

export type FakeOptions = {
  /**
   * What the Runner says on stdout, for a phase that streams. Absent, the sandbox answers
   * a single `{finished}` and exits 0 — enough for a phase that is not being driven.
   */
  runner?: (context: RunnerContext) => AsyncIterable<string>;
  /**
   * Whether a probe run inside this sandbox reaches the internet. The default models the
   * platform honestly: open under `allow-all`, sealed under `deny-all`.
   *
   * Override it to model the failure the guard exists for — a policy the platform
   * accepted and did not apply.
   */
  reachable?: (sandbox: FakeSandbox) => boolean;
  /** What the environment build's `tar` produces, as `{ name: contents }`. */
  blobs?: Record<string, string>;
  /** Bytes to answer `/out/agent.bundle` with. Absent, the agent handed nothing over. */
  handover?: Buffer;
  /** Make `create` throw, to test that a failed build is reported and not thrown. */
  refuseCreate?: boolean;
  /** What `tar` says when it fails, so the collection path can be exercised. */
  tarFails?: string;
  /**
   * End the session after this many stdout chunks, the way the platform does.
   *
   * Modelled as a throw from the STREAM rather than a clean end, because that is what
   * 10a item 11 measured: `logs()` throws `StreamError` and `wait()` throws a 410. A fake
   * that simply stopped yielding would exercise the happy path and prove nothing.
   */
  endSessionAfter?: number;
};

/**
 * A tar of a handful of small files, built by hand.
 *
 * The executor untars with the real `tar`, so this has to be a real archive — a fake that
 * answered with anything else would make the collection path untested precisely where it
 * touches the filesystem. 512-byte headers, ustar, one block per file, two empty blocks
 * at the end.
 */
export function tarOf(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'utf8');
    header.write('0000000\0', 108, 8, 'utf8');
    header.write('0000000\0', 116, 8, 'utf8');
    header.write(`${Buffer.byteLength(content).toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
    header.write('00000000000\0', 136, 12, 'utf8');
    header.write('0', 156, 1, 'utf8');
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');
    // The checksum is computed with the checksum field itself read as spaces.
    header.write('        ', 148, 8, 'utf8');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
    const body = Buffer.from(content, 'utf8');
    const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    body.copy(padded);
    blocks.push(header, padded);
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/**
 * Who `writeFiles` runs as on the managed image, and who the repro drops to.
 *
 * The same number, which is the fact the whole spool design turns on — see the refusal in
 * `writeFiles` below.
 */
export const SANDBOX_UID = 1000;

/** One JSON line, as the Runner would write it. */
export const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

/**
 * The seq the Runner in this sandbox would start from.
 *
 * Read out of the Job the executor wrote, rather than assumed — the executor bumps
 * `afterSeq` past the events it writes itself, and a script that numbered from 1
 * regardless would be a fake agreeing with an implementation instead of with the Runner.
 * `fold()` refuses both a gap and a duplicate, so getting this wrong is a real defect
 * that only a faithful fixture can show.
 */
export const afterSeqOf = (sandbox: FakeSandbox): number => {
  const raw = sandbox.files.get('/work/job.json');
  return raw ? ((JSON.parse(raw.toString('utf8')) as { afterSeq?: number }).afterSeq ?? 0) : 0;
};

export function fakeSandboxes(options: FakeOptions = {}): {
  client: SandboxClient;
  sandboxes: FakeSandbox[];
  snapshots: string[];
  dropped: string[];
} {
  const sandboxes: FakeSandbox[] = [];
  const snapshots: string[] = [];
  const dropped: string[] = [];
  const reachable = options.reachable ?? ((sandbox: FakeSandbox) => sandbox.policy === 'allow-all');

  const handleFor = (fake: FakeSandbox): SandboxHandle => {
    const spool: string[] = [];
    const waiting: { match: (line: string) => boolean; settle: (line: string) => void }[] = [];
    const notice = (written: string) => {
      spool.push(written);
      for (let index = waiting.length - 1; index >= 0; index -= 1) {
        const waiter = waiting[index]!;
        if (waiter.match(written)) {
          waiting.splice(index, 1);
          waiter.settle(written);
        }
      }
    };

    return {
      id: fake.id,
      writeFiles: async (files) => {
        for (const file of files) {
          // THE ONE PERMISSION THIS FAKE MODELS, because one uid difference is the whole
          // of the transport's design. `writeFiles` runs as uid 1000 — the uid the repro
          // drops to — and `PREPARE` makes the spool root-owned 0700 so that user cannot
          // forge `{done: true}`. Which means the host cannot write it either. Without
          // this refusal the executor could go back to writing tool calls with
          // `writeFiles`, every call would fail EACCES on the first live agent phase, and
          // the suite would stay green.
          if (file.path.startsWith('/work/rpc/')) {
            throw new Error(`EACCES: the spool is root-owned 0700 and writeFiles runs as uid ${SANDBOX_UID}`);
          }
          fake.files.set(file.path, file.content);
        }
      },
      readFile: async (path) => {
        if (path === '/out/agent.bundle') return options.handover ?? null;
        if (path.endsWith('blobs.tar')) return tarOf(options.blobs ?? {});
        return fake.files.get(path) ?? null;
      },
      run: async (command) => {
        fake.commands.push(command);
        // The probes, answered from the policy the platform is modelled as holding — not
        // from the field the executor set. Exit 0 means REACHED.
        if (command.includes("require('dns')")) {
          return reachable(fake)
            ? { exitCode: 0, output: 'RESOLVED 1.2.3.4' }
            : { exitCode: 1, output: 'DNS_FAIL EAI_AGAIN' };
        }
        if (command.includes("require('dgram')")) {
          return reachable(fake) ? { exitCode: 0, output: 'UDP_ANSWERED 45' } : { exitCode: 3, output: 'UDP_TIMEOUT' };
        }
        // `PREPARE` is what makes the paths the Runner needs. Recorded rather than
        // assumed, so a test can assert that `/out` is one of them — without it
        // `handOverCommits` finds no directory and silently hands over nothing.
        if (command.includes('mkdir -p')) {
          for (const path of ['/work', '/blobs', '/out', '/opt/env']) {
            if (command.includes(path)) fake.prepared.add(path);
          }
          return { exitCode: 0, output: '' };
        }
        if (command.includes('tar -cf')) {
          return options.tarFails
            ? { exitCode: 0, output: `${options.tarFails}\nTAR 2` }
            // The listing mentions `TAR 0` on purpose: a substring match anywhere in a
            // stream the guest influences is not a check, and only reading the LAST line
            // tells a real success from a filename.
            : { exitCode: 0, output: './\n./TAR 0-shaped-name\nTAR 0' };
        }
        // A tool call, delivered the way the executor delivers one: base64 inside a
        // command, because the spool is root-owned and `writeFiles` runs as uid 1000.
        const delivered = /printf %s '([A-Za-z0-9+/=]*)'/.exec(command);
        if (delivered && command.includes('/rpc/in/')) {
          notice(Buffer.from(delivered[1]!, 'base64').toString('utf8').trim());
          return { exitCode: 0, output: '' };
        }
        // The environment build awaits the Runner whole rather than streaming it, so the
        // same script has to answer both shapes. Joined into `output`, which is what the
        // executor parses there.
        if (command.includes('runner-vm') && options.runner) {
          let output = '';
          for await (const chunk of options.runner({
            sandbox: fake,
            spool: () => [...spool],
            awaitSpool: (match) => {
              const already = spool.find(match);
              if (already !== undefined) return Promise.resolve(already);
              return new Promise<string>((settle) => waiting.push({ match, settle }));
            },
          })) {
            output += chunk;
          }
          return { exitCode: 0, output };
        }
        return { exitCode: 0, output: '' };
      },
      start: async (command): Promise<Started> => {
        fake.commands.push(command);
        const script = options.runner ?? (async function* () {
          yield line({ finished: { handover: null } });
        });
        let done = () => {};
        const finished = new Promise<void>((resolve) => (done = resolve));
        return {
          id: 'cmd-1',
          chunks: () =>
            (async function* () {
              let yielded = 0;
              try {
                for await (const chunk of script({
                  sandbox: fake,
                  spool: () => [...spool],
                  awaitSpool: (match) => {
                    const already = spool.find(match);
                    if (already !== undefined) return Promise.resolve(already);
                    return new Promise<string>((settle) => waiting.push({ match, settle }));
                  },
                })) {
                  yield { stream: 'stdout' as const, data: chunk };
                  yielded += 1;
                  if (options.endSessionAfter !== undefined && yielded >= options.endSessionAfter) {
                    throw new SessionEnded('Sandbox stream was closed before the command finished');
                  }
                }
              } finally {
                done();
              }
            })(),
          wait: async () => {
            await finished;
            if (options.endSessionAfter !== undefined) {
              throw new SessionEnded('Sandbox has stopped execution');
            }
            return 0;
          },
          kill: async () => {
            done();
          },
        };
      },
      setNetworkPolicy: async (policy) => {
        fake.policy = policy;
        fake.flippedAfter = fake.commands.length;
      },
      snapshot: async () => {
        const ref = `snap-${snapshots.length + 1}`;
        snapshots.push(ref);
        fake.stopped = true;
        return { ref };
      },
      stop: async (): Promise<Compute | null> => {
        // A session that has already ended cannot be ended again, and the executor's
        // sweep counts what it actually stopped — so a fake that answered twice would
        // make the sweep's number a lie.
        if (fake.stopped) throw new Error('this sandbox is not running');
        fake.stopped = true;
        return { sandboxId: fake.id, activeCpuMs: 1234, durationMs: 5678 };
      },
    };
  };

  return {
    sandboxes,
    snapshots,
    dropped,
    client: {
      create: async ({ from, policy, timeoutMs, tags }) => {
        if (options.refuseCreate) throw new Error('the platform refused to create a sandbox');
        const fake: FakeSandbox = {
          id: `sbx-${sandboxes.length + 1}`,
          from,
          createdWith: policy,
          policy,
          files: new Map(),
          commands: [],
          flippedAfter: null,
          stopped: false,
          timeoutMs,
          tags: tags ?? {},
          prepared: new Set<string>(),
        };
        sandboxes.push(fake);
        return handleFor(fake);
      },
      list: async (tags) =>
        sandboxes
          .filter((fake) => !fake.stopped)
          .filter((fake) => Object.entries(tags).every(([key, value]) => fake.tags[key] === value))
          .map((fake) => ({ id: fake.id })),
      get: async (id) => {
        const fake = sandboxes.find((one) => one.id === id);
        return fake ? handleFor(fake) : null;
      },
      dropSnapshot: async (ref) => {
        dropped.push(ref);
      },
    },
  };
}
