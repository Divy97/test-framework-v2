// Supervising the agent. The Runner spawns `claude -p --output-format
// stream-json`, reads its stdout, and turns each line into a transcript event.
//
// The governing rule is ADR-0006: this is TESTIMONY. The Runner observes that
// bytes arrived on a pipe — never that they are true. So nothing here parses the
// agent's output for meaning, and nothing it says can reach a verdict. The one
// structured field, `claimed_type`, is named for what it is.
//
// The agent cannot append to the event stream. It writes to a pipe this process
// owns, and every line is re-serialised through JSON.stringify on its way into a
// payload, so a message shaped like a RunEvent lands inside a string and stays
// there. It runs as the unprivileged repro user for the same reason the repro
// does: root in the Runner's PID namespace could reach the channel through
// /proc/1/fd/N whatever this file did.
//
// No output schema is imposed. `claude` has a --json-schema flag and we
// deliberately do not use it: v1 of the prior project failed by trusting a
// model's self-report, and the answer is not a better schema but an engine that
// checks independently (Q7, "loose agent, strict judge").

import { spawn } from 'node:child_process';
import { put } from './blobs.js';
import type { AgentFinishedV1, RunEvent } from './events.js';

/**
 * Ceilings on an untrusted stream. Every one of them is a fact when hit, never a
 * silent truncation: a cut-off transcript that reads as complete is the failure
 * mode this project exists to refuse.
 */
const MAX_MESSAGES = 10_000;
const MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 600_000;

export type AgentOptions = {
  runId: string;
  /** Seq of the last event already in the log; transcript events start at afterSeq + 1. */
  afterSeq: number;
  /** What to ask. The prompt's content is the caller's business, not this file's. */
  prompt: string;
  /** The worktree the agent works in. */
  cwd: string;
  blobRoot: string;
  timeoutMs?: number;
  maxMessages?: number;
  maxLineBytes?: number;
  /** Drop to this uid/gid, as the repro does. Omitted outside the sandbox. */
  runAs?: { uid: number; gid: number };
};

/** What the agent's own stream claimed this line was. Testimony about testimony. */
const claimedType = (line: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === 'object' && 'type' in parsed) {
      const type = (parsed as { type: unknown }).type;
      // A non-string `type` is the agent being creative. Record that we saw no
      // usable claim rather than putting an object where a label goes.
      return typeof type === 'string' ? type : null;
    }
    return null;
  } catch {
    // Not JSON at all. Still testimony, still recorded — the raw bytes are the
    // artifact, and a crash here would let malformed output kill a real run.
    return null;
  }
};

/**
 * Run the agent to completion (or to a ceiling) and return its transcript as
 * events. Throws nothing on a non-zero agent exit: an agent that fails is an
 * observation, not a failure to observe.
 */
export async function superviseAgent(options: AgentOptions): Promise<RunEvent[]> {
  const { runId, prompt, cwd, blobRoot } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxMessages = options.maxMessages ?? MAX_MESSAGES;
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;

  const child = spawn(
    'claude',
    ['-p', prompt, '--output-format', 'stream-json', '--verbose'],
    {
      cwd,
      // The agent gets no stdin. It is not an interactive session, and leaving
      // the parent's stdin attached would hand it the Job on the way in.
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.runAs ?? {}),
    },
  );

  const lines: { raw: string; type: string | null }[] = [];
  let stopped: AgentFinishedV1['stopped'] = 'exit';
  let buffer = '';
  /**
   * Set the moment a ceiling is hit, and checked before anything else is read.
   *
   * Killing the process does not stop data already in flight — chunks queued
   * before the signal still arrive — so without this the cap overshoots by
   * however much the agent had buffered. A cap that records "5" and stores 6 is
   * a lie about the size of its own record.
   */
  let done = false;
  /** No process exists when spawn itself failed, so there is no status to report. */
  let spawned = true;

  const finish = (why: AgentFinishedV1['stopped']) => {
    if (!done) stopped = why;
    done = true;
    // SIGKILL, not SIGTERM: the agent is the thing under judgement, and a
    // ceiling it has already breached is not an invitation to shut down politely.
    child.kill('SIGKILL');
  };

  const timer = setTimeout(() => finish('timeout'), timeoutMs);

  await new Promise<void>((resolve) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (done) return;
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (raw.length > 0) {
          lines.push({ raw, type: claimedType(raw) });
          if (lines.length >= maxMessages) return finish('line_cap');
        }
        newline = buffer.indexOf('\n');
      }
      // A line that never ends is how an unbounded write arrives. Stop rather
      // than grow: storing the fragment would be storing truncated bytes as if
      // they were the whole line.
      if (buffer.length > maxLineBytes) return finish('byte_cap');
    });
    // stderr is drained but not recorded. It is the agent's diagnostics, not its
    // transcript, and mixing the two would put unstructured noise in the record.
    child.stderr.resume();
    // `close`, not `exit`: exit can fire while stdout still has buffered data,
    // which would drop the agent's last messages — including, usually, its
    // result line.
    child.on('close', () => resolve());
    child.on('error', () => {
      // Spawn failure (no `claude` on PATH). No process ever existed, so the
      // status Node reports is about the attempt, not about an execution — and a
      // plausible-looking code there would claim the agent ran and failed.
      spawned = false;
      resolve();
    });
  });
  clearTimeout(timer);

  let seq = options.afterSeq;
  const events: RunEvent[] = [];
  for (const [index, line] of lines.entries()) {
    events.push({
      run_id: runId,
      seq: ++seq,
      ts: new Date().toISOString(),
      type: 'AGENT_MESSAGE',
      payload: {
        v: 1,
        n: index,
        claimed_type: line.type,
        raw_hash: await put(blobRoot, line.raw),
        bytes: Buffer.byteLength(line.raw),
      },
    });
  }

  events.push({
    run_id: runId,
    seq: ++seq,
    ts: new Date().toISOString(),
    type: 'AGENT_FINISHED',
    payload: {
      v: 1,
      messages: lines.length,
      // A signalled death reports -1 for the same reason a repro's does: -1 is
      // not a status any process can exit with, so it cannot be mistaken for one.
      // A spawn that never happened reports it too — Node puts its own code on
      // the child there, which would read as an execution that returned.
      exit_code: spawned ? (child.exitCode ?? -1) : -1,
      ...(spawned && child.signalCode ? { signal: child.signalCode } : {}),
      stopped,
    },
  });

  return events;
}
