// A scripted Messages API, for testing the agent loop without a credential.
//
// This is the successor to the fake `claude` on PATH, and it exists for the same
// reason that one did: what has to be proven is behaviour under output a real
// model will never produce on demand — a tool call naming a path outside the
// workspace, a `git_commit` after a forged event, ten thousand turns, a refusal.
// A recorded real transcript is a separate artifact, for the demo.
//
// It is deliberately a real HTTP server rather than a mocked SDK. The thing under
// test includes the SDK's tool runner: how it renders our schemas, how it feeds
// results back, when it stops. Stubbing that out would leave the one integration
// 5a introduces asserted nowhere.

import { createServer, type Server } from 'node:http';

/** One assistant turn the fake will serve, in order. */
export type Turn = {
  /** Blocks to return. `tool_use` blocks make the runner call our tools. */
  content: unknown[];
  stop_reason?: 'tool_use' | 'end_turn' | 'max_tokens' | 'refusal';
};

export type FakeModel = {
  baseURL: string;
  /** Every request body the SDK sent, parsed. The tool schemas and results are in here. */
  requests: Record<string, unknown>[];
  close: () => Promise<void>;
};

/**
 * Serve `turns` in order, then `end_turn` forever.
 *
 * Running past the end is not an error: a test that scripts three turns and gets
 * four has learned something about the runner, and hanging or 500ing would hide
 * it behind a timeout.
 */
export function fakeModel(turns: Turn[], options: { status?: number; body?: string } = {}): Promise<FakeModel> {
  const requests: Record<string, unknown>[] = [];
  let served = 0;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      } catch {
        requests.push({ unparsed: Buffer.concat(chunks).toString() });
      }
      // A scripted failure, for the path where the model API itself refuses.
      if (options.status !== undefined) {
        response.writeHead(options.status, { 'content-type': 'application/json' });
        response.end(options.body ?? '{"type":"error","error":{"type":"api_error","message":"scripted"}}');
        return;
      }
      const turn = turns[served] ?? { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' as const };
      served += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: `msg_${served}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: turn.content,
          stop_reason: turn.stop_reason ?? 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the fake model did not bind a port'));
        return;
      }
      resolve({
        baseURL: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

/** A `tool_use` block, since every test writes several. */
export const call = (name: string, input: Record<string, unknown>, id = `toolu_${name}`) => ({
  type: 'tool_use',
  id,
  name,
  input,
});

/** One assistant turn from an OpenAI-shaped API. */
export type ChatTurn = {
  content?: string | null;
  reasoning?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  finish_reason?: string;
};

/**
 * The same idea for `/chat/completions`, because the OpenRouter path is OUR loop.
 *
 * The Anthropic fixture above tests the SDK's tool runner as much as our code. Here
 * there is no SDK: the turn-taking, the `tool` messages, the id matching are all
 * `src/openrouter.ts`. A real server rather than a stubbed `fetch` for that exact
 * reason — the request body has to survive serialisation and a real round trip, which
 * is where a shape error actually shows up.
 */
export function fakeChat(
  turns: ChatTurn[],
  options: { status?: number; body?: string; repeatLast?: boolean; errorBody?: { message?: string; code?: number } } = {},
): Promise<FakeModel> {
  const requests: Record<string, unknown>[] = [];
  let served = 0;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      } catch {
        requests.push({ unparsed: Buffer.concat(chunks).toString() });
      }
      if (options.status !== undefined) {
        response.writeHead(options.status, { 'content-type': 'application/json' });
        response.end(options.body ?? '{"error":{"message":"scripted"}}');
        return;
      }
      // A 200 that is actually a refusal. Not invented for symmetry: this is what
      // OpenRouter really answered when an upstream provider rejected the request, and
      // reading `response.ok` alone reported it as the MODEL's failure rather than ours.
      if (options.errorBody !== undefined) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: options.errorBody }));
        return;
      }
      // `repeatLast` is how a test drives the loop into its OWN ceiling: a model that
      // asks for a tool forever. Without it the fixture ends the turn and the ceiling
      // is never reached, so the assertion would pass for the wrong reason.
      const fallback: ChatTurn = options.repeatLast
        ? (turns[turns.length - 1] ?? { content: 'done' })
        : { content: 'done', finish_reason: 'stop' };
      const turn = turns[served] ?? fallback;
      served += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: `chatcmpl_${served}`,
          object: 'chat.completion',
          model: 'scripted/model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: turn.content ?? null,
                ...(turn.reasoning === undefined ? {} : { reasoning: turn.reasoning }),
                ...(turn.tool_calls === undefined ? {} : { tool_calls: turn.tool_calls }),
              },
              finish_reason: turn.finish_reason ?? (turn.tool_calls ? 'tool_calls' : 'stop'),
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 5 },
        }),
      );
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the fake chat API did not bind a port'));
        return;
      }
      resolve({
        baseURL: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

/** An OpenAI-shaped tool call. `args` is stringified, as the wire format requires. */
export const fnCall = (name: string, args: Record<string, unknown> | string, id = `call_${name}`) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});
