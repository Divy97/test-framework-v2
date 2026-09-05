// Shared by the thirteen spike scripts (M10, 10a). Nothing here is engine code.
//
// Every script answers one question about Vercel Sandbox with a number beside it, and
// prints PASS or FAIL. The criteria are `docs/milestone-10.md` § "The spike, itemised".
// A script that cannot run says why and exits 2, so an unrun item never reads as PASS.

import { Sandbox } from '@vercel/sandbox';

export type Creds = { token: string; teamId: string; projectId: string };

export const creds = (): Creds => {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !teamId || !projectId) {
    console.error('SKIP  set VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID (the SDK needs all three)');
    process.exit(2);
  }
  return { token, teamId, projectId };
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
  const finished = await sandbox.runCommand({ cmd: 'sh', args: ['-c', command], ...opts });
  return { code: finished.exitCode, out: (await finished.output('both')).trim(), ms: finished.durationMs ?? NaN };
};

/**
 * The three egress probes, in node so they work on any image with a node binary. Each
 * prints one word and exits 0 only if the network was REACHED — so "all non-zero" is
 * the sealed answer, and the word says how it failed.
 */
export const PROBES = {
  dns: `node -e "require('dns').promises.lookup('registry.npmjs.org').then(r=>{console.log('RESOLVED',r.address);process.exit(0)},e=>{console.log('DNS_FAIL',e.code);process.exit(1)})"`,
  tcp: `node -e "const s=require('net').connect(53,'1.1.1.1');s.setTimeout(4000,()=>{console.log('TIMEOUT');process.exit(3)});s.on('connect',()=>{console.log('ROUTED');process.exit(0)});s.on('error',e=>{console.log('TCP_FAIL',e.code);process.exit(1)})"`,
  http: `node -e "fetch('http://1.1.1.1/',{signal:AbortSignal.timeout(4000)}).then(r=>{console.log('HTTP',r.status);process.exit(0)},e=>{console.log('HTTP_FAIL',e.cause?.code??e.name);process.exit(1)})"`,
};

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
