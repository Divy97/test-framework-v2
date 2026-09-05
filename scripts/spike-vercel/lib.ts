// Shared by the thirteen spike scripts (M10, 10a). Nothing here is engine code.
//
// Every script answers one question about Vercel Sandbox with a number beside it, and
// prints PASS or FAIL. The criteria are `docs/milestone-10.md` § "The spike, itemised".
// A script that cannot run says why and exits 2, so an unrun item never reads as PASS.

import { Sandbox } from '@vercel/sandbox';

export type Creds = { token?: string; teamId?: string; projectId?: string };

/**
 * How the SDK is told who we are. Two ways, and the first needs nothing in `.env`:
 *
 *   - **The Vercel CLI's login.** `vercel login` writes a session the SDK reads itself
 *     (`getAuth()`), and it resolves the team and project on its own (`inferScope()`: a
 *     linked `.vercel/project.json` if `vercel link` was run, else your default team and
 *     a default project it creates). Pass nothing and it does all of that.
 *   - **An account token** in `VERCEL_TOKEN` with `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`,
 *     for a machine with no CLI session — the worker, later.
 *
 * Nothing here can tell whether a CLI session exists without asking the SDK, so with no
 * env the scripts simply try; an unauthenticated SDK throws a clear error on the first
 * call and `run-all.sh` records it as a CRASH with that message.
 */
export const creds = (): Creds => {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token && teamId && projectId) return { token, teamId, projectId };
  if (token || teamId || projectId) {
    console.error('SKIP  VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID go together; set all three, or none and use `vercel login`');
    process.exit(2);
  }
  return {};
};

export const REGION = process.env.ENGINE_VERCEL_REGION ?? 'iad1';
/** A managed image with node and git, until ours are pushed (item 13). */
export const IMAGE = process.env.ENGINE_VERCEL_IMAGE ?? 'vercel/sandbox/node:22';
export const AGENT_IMAGE = process.env.ENGINE_VERCEL_AGENT_IMAGE;
export const TAG = { spike: 'm10' };

export const ms = (t: number) => `${Math.round(t)}ms`;
export const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
};
export const pct = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN;
};

let failures = 0;
export const verdict = (item: string, ok: boolean, detail: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${item}  ${detail}`);
};
export const record = (item: string, detail: string) => console.log(`INFO  ${item}  ${detail}`);
export const done = () => process.exit(failures === 0 ? 0 : 1);

type CreateParams = Parameters<typeof Sandbox.create>[0];
/** One sandbox, tagged so `00-cleanup` can find what a crashed script left behind. */
export const create = (params: Partial<NonNullable<CreateParams>> = {}) =>
  Sandbox.create({
    ...creds(),
    region: REGION,
    image: IMAGE,
    persistent: false,
    timeout: 10 * 60_000,
    tags: TAG,
    ...params,
  } as NonNullable<CreateParams>);

/** Run a shell line and get everything back. */
export const sh = async (
  sandbox: Sandbox,
  command: string,
  opts: { sudo?: boolean; timeoutMs?: number; cwd?: string } = {},
) => {
  // A default ceiling, because a probe that hangs under `deny-all` would otherwise block
  // until the sandbox's own timeout — the very thing item 2 measures.
  const finished = await sandbox.runCommand({ cmd: 'sh', args: ['-c', command], timeoutMs: 120_000, ...opts });
  return { code: finished.exitCode, out: (await finished.output('both')).trim(), ms: finished.durationMs ?? NaN };
};

/**
 * The managed image runs as `ubuntu`, uid 1000, with passwordless sudo — and `writeFiles`
 * writes as that user. `/opt` and `/` are root's, so the paths the Runner uses (`/opt/env`,
 * `/work`) have to be made writable first. The executor (10d) needs this same step.
 */
export const prepare = async (sandbox: Sandbox) => {
  const made = await sh(sandbox, 'sudo -n mkdir -p /opt/env /work && sudo -n chown -R "$(id -u):$(id -g)" /opt/env /work && id -u');
  if (made.code !== 0) throw new Error(`could not prepare /opt/env and /work: ${made.out}`);
  return made.out;
};

/** True only when a probe failed the way a sealed sandbox fails — not because node crashed. */
export const sealedFailure = (probe: { code: number; out: string }) =>
  probe.code !== 0 && /^(DNS_FAIL|UDP_TIMEOUT|UDP_FAIL|TCP_FAIL|TIMEOUT|TCP_CONNECTED_NO_DATA|TCP_CONNECTED_THEN_|HTTP_FAIL|TLS_FAIL|TLS_TIMEOUT)/.test(probe.out);

/**
 * The three egress probes, in node so they work on any image with a node binary. Each
 * prints one word and exits 0 only if the network was REACHED — so "all non-zero" is
 * the sealed answer, and the word says how it failed.
 */
// A minimal DNS query for `example.com` (A), built in place so nothing here is a hex
// string somebody has to trust. Shared by the UDP and TCP probes.
const DNS_QUERY = "const name=Buffer.concat([Buffer.from([7]),Buffer.from('example'),Buffer.from([3]),Buffer.from('com'),Buffer.from([0])]);const q=Buffer.concat([Buffer.from([0x12,0x34,1,0,0,1,0,0,0,0,0,0]),name,Buffer.from([0,1,0,1])]);";

/**
 * Probes that EXCHANGE DATA, because a connect that succeeds proves nothing: the first
 * run of item 1 saw `connect()` to 1.1.1.1:53 complete under `deny-all` while HTTP died
 * with a socket error — the shape of a proxy that accepts the handshake and then drops
 * the connection. The question is whether a byte ever reaches the destination, so each
 * probe here sends something and waits for an answer only the destination could give.
 * Each prints one word and exits 0 only if the network was REACHED; the word says how it
 * failed. `${ms}` is the per-probe timeout.
 */
export const probes = (ms = 4000) => ({
  /** The system resolver, whatever the sandbox points it at. */
  dns: `node -e "require('dns').promises.lookup('registry.npmjs.org').then(r=>{console.log('RESOLVED',r.address);process.exit(0)},e=>{console.log('DNS_FAIL',e.code);process.exit(1)})"`,
  /** DNS over UDP straight to 1.1.1.1 — a proxy cannot terminate UDP the way it terminates TCP. */
  udp: `node -e "${DNS_QUERY}const d=require('dgram').createSocket('udp4');setTimeout(()=>{console.log('UDP_TIMEOUT');process.exit(3)},${ms});d.on('message',m=>{console.log('UDP_ANSWERED',m.length);process.exit(0)});d.on('error',e=>{console.log('UDP_FAIL',e.code);process.exit(1)});d.send(q,53,'1.1.1.1')"`,
  /** DNS over TCP to 1.1.1.1: connect, SEND the query, and wait for the answer. */
  tcp: `node -e "${DNS_QUERY}const s=require('net').connect(53,'1.1.1.1');let c=false;s.setTimeout(${ms},()=>{console.log(c?'TCP_CONNECTED_NO_DATA':'TIMEOUT');process.exit(3)});s.on('connect',()=>{c=true;s.write(Buffer.concat([Buffer.from([0,q.length]),q]))});s.on('data',m=>{console.log('TCP_DATA',m.length);process.exit(0)});s.on('error',e=>{console.log(c?'TCP_CONNECTED_THEN_'+e.code:'TCP_FAIL '+e.code);process.exit(1)});s.on('close',()=>{if(c){console.log('TCP_CONNECTED_THEN_CLOSED');process.exit(2)}})"`,
  /** A TLS handshake to 1.1.1.1:443 with SNI — completes only if the real server answers. */
  tls: `node -e "const s=require('tls').connect({host:'1.1.1.1',port:443,servername:'one.one.one.one'});s.setTimeout(${ms},()=>{console.log('TLS_TIMEOUT');process.exit(3)});s.on('secureConnect',()=>{console.log('TLS_OK',s.getProtocol());process.exit(0)});s.on('error',e=>{console.log('TLS_FAIL',e.code||e.message);process.exit(1)})"`,
  http: `node -e "fetch('http://1.1.1.1/',{signal:AbortSignal.timeout(${ms})}).then(r=>{console.log('HTTP',r.status);process.exit(0)},e=>{console.log('HTTP_FAIL',e.cause?.code??e.name);process.exit(1)})"`,
  /** Connect only — kept as INFORMATION, never a verdict: it says whether a proxy is in the path. */
  connect: `node -e "const s=require('net').connect(53,'1.1.1.1');s.setTimeout(${ms},()=>{console.log('CONNECT_TIMEOUT');process.exit(3)});s.on('connect',()=>{console.log('CONNECT_ACCEPTED');process.exit(0)});s.on('error',e=>{console.log('CONNECT_REFUSED',e.code);process.exit(1)})"`,
});

/** The ordinary set (4s) and the fast set for polling a flip (1s). */
export const PROBES = probes(4000);
export const FAST_PROBES = probes(1000);

/** A loopback server on 8080 that answers `ok`, left running. */
export const LOOPBACK_SERVER = `node -e "require('http').createServer((q,r)=>r.end('ok')).listen(8080,'127.0.0.1')"`;
export const LOOPBACK_PROBE = `node -e "fetch('http://127.0.0.1:8080/').then(r=>r.text()).then(t=>{console.log('LOOPBACK',t);process.exit(t==='ok'?0:1)},e=>{console.log('LOOPBACK_FAIL',e.cause?.code??e.name);process.exit(1)})"`;

export const stopQuietly = async (sandbox: Sandbox | undefined) => {
  if (!sandbox) return;
  try {
    await sandbox.stop();
  } catch (error) {
    record('cleanup', `stop failed: ${String((error as Error).message ?? error)}`);
  }
};
