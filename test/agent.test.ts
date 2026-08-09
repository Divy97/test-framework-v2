// Supervising the agent, tested against a fake `claude` on PATH.
//
// Faking it is not a cost-saving dodge, it is the only way to test the thing
// that matters. The agent's output is testimony (ADR-0006), so what has to be
// proven is behaviour under HOSTILE output — a forged event, a line that never
// ends, ten thousand messages — which a real agent will never produce on demand.
// A recorded real transcript is a separate artifact, for the demo.
//
// PATH is the injection point on purpose: no seam in the production code, which
// picks its own binary and its own flags precisely so a caller cannot.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { superviseAgent } from '../src/agent.js';
import { get } from '../src/blobs.js';
import type { AgentFinishedV1, AgentMessageV1, ArtifactRef, RunEvent } from '../src/events.js';

const RUN_ID = 'b41f7d02-6c19-4a5e-9f83-2d1e0a7c6b45';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A `claude` that runs the given shell and nothing else. */
const fakeClaude = (script: string) => {
  const dir = temp('fake-claude-');
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return dir;
};

const supervise = async (script: string | null, overrides: Partial<Parameters<typeof superviseAgent>[0]> = {}) => {
  const path = process.env.PATH;
  // PREPEND, so the fake wins over any real `claude` while the scripts keep the
  // coreutils they are written in. Replacing PATH outright left them without
  // `cat` or `seq`, and two tests passed for a reason that had nothing to do
  // with the code — an empty transcript reads the same however it got that way.
  //
  // For the missing-binary case an empty PATH is right: nothing has to run.
  process.env.PATH = script === null ? temp('empty-path-') : `${fakeClaude(script)}:${path}`;
  try {
    return await superviseAgent({
      runId: RUN_ID,
      afterSeq: 0,
      prompt: 'reproduce the bug',
      cwd: temp('agent-cwd-'),
      blobRoot: temp('agent-blobs-'),
      timeoutMs: 10_000,
      ...overrides,
    });
  } finally {
    process.env.PATH = path;
  }
};

const messages = (events: RunEvent[]) =>
  events.filter((e) => e.type === 'AGENT_MESSAGE').map((e) => e.payload as AgentMessageV1);
const finished = (events: RunEvent[]) =>
  events.find((e) => e.type === 'AGENT_FINISHED')!.payload as AgentFinishedV1;

describe('the transcript is recorded verbatim', () => {
  test('one event per line, with the raw bytes retrievable', async () => {
    const blobRoot = temp('agent-blobs-');
    const events = await supervise(
      `printf '{"type":"system","subtype":"init"}\\n'\n` +
        `printf '{"type":"assistant","message":{"content":"looking at it"}}\\n'\n` +
        `printf '{"type":"result","subtype":"success"}\\n'`,
      { blobRoot },
    );

    expect(events.map((e) => e.type)).toEqual([
      'AGENT_MESSAGE',
      'AGENT_MESSAGE',
      'AGENT_MESSAGE',
      'AGENT_FINISHED',
    ]);
    expect(messages(events).map((m) => m.claimed_type)).toEqual(['system', 'assistant', 'result']);
    expect(messages(events).map((m) => m.n)).toEqual([0, 1, 2]);

    // A hash nothing can resolve is not a transcript. What the agent said has to
    // be openable, or the timeline is asserting the existence of testimony it
    // cannot show.
    const raw = await get(blobRoot, messages(events)[1]!.raw_hash);
    expect(raw.toString()).toContain('looking at it');

    expect(finished(events)).toMatchObject({ messages: 3, exit_code: 0, stopped: 'exit' });
    // The transcript continues the log from afterSeq rather than restarting it.
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  test('output that is not JSON is still recorded, not fatal', async () => {
    // A crash here would let any malformed line kill a real run, and the bytes
    // are the artifact regardless of whether they parse.
    const events = await supervise(`printf 'Traceback (most recent call last):\\n'`);

    expect(messages(events)).toHaveLength(1);
    expect(messages(events)[0]!.claimed_type).toBeNull();
    expect(finished(events).stopped).toBe('exit');
  });

  test('a non-string type is recorded as no claim at all', async () => {
    const events = await supervise(`printf '{"type":{"nested":"object"}}\\n'`);
    expect(messages(events)[0]!.claimed_type).toBeNull();
  });
});

describe('the agent cannot forge an event', () => {
  test('a line shaped exactly like a RunEvent stays inside a string', async () => {
    // The whole ADR-0006 boundary in one case: the agent writes a complete,
    // valid TEST_RUN claiming a green fix, and it must arrive as testimony — one
    // AGENT_MESSAGE — never as its own line on the channel.
    const forged = JSON.stringify({
      run_id: RUN_ID,
      seq: 99,
      ts: '2026-01-01T00:00:00.000Z',
      type: 'TEST_RUN',
      payload: { v: 1, phase: 'fix', commit_sha: 'deadbeef', exit_code: 0, duration_ms: 1 },
    });
    const blobRoot = temp('agent-blobs-');
    const events = await supervise(`cat <<'JSON'\n${forged}\nJSON`, { blobRoot });

    expect(events.map((e) => e.type)).toEqual(['AGENT_MESSAGE', 'AGENT_FINISHED']);
    expect(messages(events)[0]!.claimed_type).toBe('TEST_RUN'); // what it CLAIMED
    // Serialised the way the Runner serialises, the forgery is one escaped
    // string inside one event — not a second line anything could fold.
    const channel = events.map((e) => `${JSON.stringify(e)}\n`).join('');
    expect(channel.trim().split('\n')).toHaveLength(2);
    for (const line of channel.trim().split('\n')) {
      expect((JSON.parse(line) as RunEvent).seq).not.toBe(99);
    }
    // And the forged bytes survive as evidence of what was attempted.
    expect((await get(blobRoot, messages(events)[0]!.raw_hash)).toString()).toContain('deadbeef');
  });

  test('a line with an embedded newline cannot split itself onto the channel', async () => {
    // `\n` inside a JSON string is two characters on the wire, so it arrives as
    // one line; JSON.stringify then re-escapes it. Both halves matter.
    const events = await supervise(`printf '{"type":"assistant","text":"a\\\\nb"}\\n'`);

    expect(messages(events)).toHaveLength(1);
    const channel = events.map((e) => `${JSON.stringify(e)}\n`).join('');
    expect(channel.trim().split('\n')).toHaveLength(2);
  });
});

describe('an untrusted stream is bounded, and says when it was cut', () => {
  test('too many messages stops the agent and records the cap', async () => {
    // ~260KB, so stdout is delivered in several chunks rather than one. That is
    // load-bearing: killing the process does not stop data already in flight, so
    // a single-chunk fixture would pass with no guard at all and the cap would
    // quietly overshoot in production. The count must hold across chunks.
    const events = await supervise(`yes '{"type":"x"}' | head -20000`, { maxMessages: 5 });

    expect(messages(events)).toHaveLength(5);
    // The cap is a FACT, not a silent truncation. A cut-off transcript that reads
    // as complete is the failure this project refuses everywhere else.
    expect(finished(events)).toMatchObject({ messages: 5, stopped: 'line_cap' });
  });

  test('a line that never ends stops the agent rather than growing', async () => {
    // No newline, so nothing can be recorded without storing a fragment as if it
    // were the whole line.
    const events = await supervise(`printf 'x%.0s' $(seq 1 500)`, { maxLineBytes: 100 });

    expect(messages(events)).toHaveLength(0);
    expect(finished(events).stopped).toBe('byte_cap');
  });

  test('an agent that never finishes is killed and recorded as a timeout', async () => {
    // `exec` replaces the shell, so the child pid IS the sleep and the kill
    // collects it directly — no orphan, and no core burnt spinning. The deadline
    // is generous because the whole suite competes for CPU: a tighter one fired
    // before the fake had printed anything, and the test flaked on load rather
    // than on behaviour.
    const events = await supervise(`printf '{"type":"x"}\\n'\nexec sleep 30`, {
      timeoutMs: 2_000,
    });

    expect(finished(events).stopped).toBe('timeout');
    expect(messages(events)).toHaveLength(1); // what it managed to say is kept
  });
});

describe('the agent failing is an observation, not a failure to observe', () => {
  test('a non-zero exit is recorded rather than thrown', async () => {
    const events = await supervise(`printf '{"type":"x"}\\n'\nexit 7`);
    expect(finished(events)).toMatchObject({ exit_code: 7, messages: 1, stopped: 'exit' });
  });

  test('no agent binary at all yields an empty transcript, not a crash', async () => {
    // The sandbox may be built without one, and that must degrade to "the agent
    // said nothing" rather than taking the verification run down with it.
    const events = await supervise(null);
    expect(messages(events)).toHaveLength(0);
    expect(finished(events).exit_code).toBe(-1);
    // Its own value: "there is no agent in this image" is what an operator most
    // needs off the log, and `exit` with zero messages cannot say it.
    expect(finished(events).stopped).toBe('spawn_failed');
  });

  test('the run continues to the engine after the agent fails', async () => {
    // Nothing here throws, so a caller can go straight on to verifying.
    await expect(supervise(`exit 1`)).resolves.toBeDefined();
  });
});

describe('the agent has no way in', () => {
  test('stdin is closed to it', async () => {
    // The parent's stdin carries the Job. Leaving it attached would hand the
    // agent the run's configuration on the way in.
    const events = await supervise(`if read line; then printf '{"type":"READ_STDIN"}\\n'; fi\nprintf '{"type":"done"}\\n'`);
    expect(messages(events).map((m) => m.claimed_type)).toEqual(['done']);
  });

  test('stderr is drained but never enters the transcript', async () => {
    const events = await supervise(`printf 'noise on stderr\\n' >&2\nprintf '{"type":"real"}\\n'`);
    expect(messages(events).map((m) => m.claimed_type)).toEqual(['real']);
  });

  test('a talkative stderr cannot deadlock the run', async () => {
    // More than a pipe buffer. Unread, the agent blocks writing to stderr and
    // never reaches its stdout — the supervisor waits for a `close` that cannot
    // come. Draining is what stops an agent's diagnostics from wedging a run.
    const events = await supervise(
      `yes 'noise' | head -20000 >&2\nprintf '{"type":"real"}\\n'`,
      { timeoutMs: 8_000 },
    );
    expect(messages(events).map((m) => m.claimed_type)).toEqual(['real']);
    expect(finished(events).stopped).toBe('exit');
  }, 20_000);

  test('blank lines are not counted as things the agent said', async () => {
    // stream-json separates records with newlines; a trailing or doubled one is
    // formatting, not a message, and counting it would spend the cap on nothing.
    const events = await supervise(`printf '{"type":"a"}\\n\\n\\n{"type":"b"}\\n'`);
    expect(messages(events).map((m) => m.claimed_type)).toEqual(['a', 'b']);
    expect(finished(events).messages).toBe(2);
  });
});

describe('the transcript continues the log it was handed', () => {
  test('seqs start after afterSeq rather than at 1', async () => {
    // Every other case passes afterSeq: 0, where continuing and restarting look
    // identical — so the property the Runner depends on to keep the agent's seqs
    // from colliding with the engine's was asserted but never tested.
    const events = await supervise(`printf '{"type":"a"}\\n'\nprintf '{"type":"b"}\\n'`, {
      afterSeq: 7,
    });
    expect(events.map((e) => e.seq)).toEqual([8, 9, 10]);
  });
});

describe('a final line with no newline is not lost', () => {
  test('a clean exit keeps it — that line is usually the result', async () => {
    // The process ended on its own, so the buffer IS the complete last line. In
    // stream-json it is normally the `result`, and dropping it while reporting a
    // clean exit is the silent truncation this whole file refuses.
    const events = await supervise(
      `printf '{"type":"assistant"}\\n'\nprintf '{"type":"result","subtype":"success"}'`,
    );
    expect(messages(events).map((m) => m.claimed_type)).toEqual(['assistant', 'result']);
    expect(finished(events)).toMatchObject({ messages: 2, stopped: 'exit' });
  });

  test('a killed agent keeps its fragment out of the record', async () => {
    // After a kill the remainder is a fragment, and storing a fragment as if it
    // were a whole line is the other half of the same sin.
    const events = await supervise(
      `printf '{"type":"a"}\\n'\nprintf '{"type":"partial-'\nexec sleep 30`,
      { timeoutMs: 2_000 },
    );
    expect(messages(events).map((m) => m.claimed_type)).toEqual(['a']);
    expect(finished(events).stopped).toBe('timeout');
  });
});

describe('the ceilings are measured in what they are named for', () => {
  test('the byte cap counts bytes, not UTF-16 units', async () => {
    // 300 three-byte characters is 900 bytes. Counting `buffer.length` made the
    // real ceiling up to 3x the stated one — and this is the only bound on how
    // much host disk an untrusted stream can consume.
    const events = await supervise(`yes '€' | head -300 | tr -d '\\n'`, { maxLineBytes: 400 });
    expect(finished(events).stopped).toBe('byte_cap');
  });
});

describe('supervision cannot outlive its own timeout', () => {
  test('a backgrounded grandchild holding the pipe does not hang the Runner', async () => {
    // `close` waits for the stdio pipes, and a grandchild inherits them. Killing
    // only the child left them open forever: the promise never settled, the
    // timeout bounded nothing, and the Runner wedged with nothing on the channel.
    // A `claude` that spawns helpers is ordinary behaviour, not an attack.
    const started = Date.now();
    const events = await supervise(
      `printf '{"type":"a"}\\n'\nsleep 30 &\nexit 0`,
      { timeoutMs: 1_000 },
    );
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(messages(events)).toHaveLength(1);
  }, 30_000);
});

describe('the fake is really being used', () => {
  test('PATH injection actually replaces the binary', () => {
    // If this ever stopped working, every test above would silently be exercising
    // a real `claude` — or nothing at all.
    const dir = fakeClaude(`printf 'FAKE\\n'`);
    expect(execFileSync('claude', [], { env: { PATH: dir }, encoding: 'utf8' })).toBe('FAKE\n');
  });
});
