// The tool surface (ADR-0011).
//
// Two halves of one contract, deliberately in one file so they cannot drift: the
// SCHEMAS, which the host loop hands to the model, and the EXECUTION, which runs
// inside the sandbox. A tool whose schema promises something its implementation
// does not do is the whole boundary undone, and keeping them apart is how that
// happens.
//
// "Promoting an action from an opaque command string to a typed tool call is what
// makes the harness able to see it" is ADR-0011's stated payoff. The cost, which
// the same ADR names, is that the tool surface becomes the attack surface: the
// container was the fence, and now these functions are. So:
//
//   - every path argument goes through `resolveInside` (src/paths.ts), the same
//     check the verification engine uses, and a refusal is a RESULT the agent
//     reads rather than an abort;
//   - `git_commit` can commit and cannot push, add a remote, or check out a ref,
//     because it only ever invokes `add` and `commit` with argv this file builds;
//   - every result is bounded, because an unbounded result is an unbounded line
//     on the channel and an unbounded prompt on the way back to the model.
//
// What is NOT here: any attempt to constrain what the agent SAYS. ADR-0006's
// amendment is explicit — constrain the tools because we execute them; do not
// constrain the agent's reasoning to make its self-report easier to trust. We
// still do not trust it, so we still do not need it structured.

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { glob, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { put } from './blobs.js';
import { Browser } from './browser.js';
import { PathRefused, resolveInside } from './paths.js';

const execFileAsync = promisify(execFile);

/** Ceiling on one tool result. Bounds the channel, the host disk, and the next prompt. */
export const MAX_TOOL_OUTPUT = 64 * 1024;
/** Per-call ceiling on a shell write. A service that never returns must not wedge the run. */
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
/** How many named sessions one run may hold open. Each is a live process. */
const MAX_SESSIONS = 16;

/**
 * A tool the model may call. `input_schema` is JSON Schema because that is what
 * the Messages API takes; there is no second source for these shapes.
 *
 * The descriptions say WHEN to reach for a tool, not only what it does — a
 * description that states only the mechanics leaves the model to guess the
 * trigger, and the guess is what the harness then has to live with.
 */
export type ToolSchema = {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
};

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'shell_create',
    description:
      'Open a NAMED shell session that stays alive until the phase ends. Use this for anything ' +
      'long-lived — a dev server, a worker, a database — and for any command whose side effects ' +
      'later commands depend on (an activated virtualenv, an exported variable, a changed ' +
      'directory). One session per service. The session survives across tool calls; a plain ' +
      'one-shot command does not need one, but nothing is lost by using one.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Session id, e.g. "web" or "build".' } },
      required: ['name'],
    },
  },
  {
    name: 'shell_write',
    description:
      'Run a command in a named session created by shell_create and return everything it wrote ' +
      'plus its exit status. Blocks until the command finishes, so background a long-running ' +
      'service yourself (append " &") if you need the session back. Output is truncated past ' +
      `${MAX_TOOL_OUTPUT} bytes; redirect to a file and read it in pieces if you need more.`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The session id passed to shell_create.' },
        input: { type: 'string', description: 'Shell command line to run.' },
        timeout_ms: { type: 'number', description: 'Optional per-command ceiling.' },
      },
      required: ['name', 'input'],
    },
  },
  {
    name: 'read',
    description:
      'Read a UTF-8 file inside the workspace. Prefer this over `cat` in a shell: the result is ' +
      'bounded and the path is checked. Paths are relative to the workspace root.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write',
    description:
      'Create or overwrite a file inside the workspace, making parent directories as needed. ' +
      'Use this for a new file; use edit to change part of an existing one.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit',
    description:
      'Replace one exact occurrence of a string in a file. Fails when the string is absent or ' +
      'appears more than once — include enough surrounding text to make it unique. Safer than ' +
      'rewriting a file you have only partly read.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'grep',
    description:
      'Search file contents under the workspace with a POSIX extended regular expression, ' +
      'reporting file:line:text. Use this to find where something is defined or used before ' +
      'reading whole files. No matches is a normal, successful result.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Optional subdirectory or file to limit the search to.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'glob',
    description:
      'List workspace files matching a glob pattern, e.g. "src/**/*.ts". Use this to learn the ' +
      'shape of a codebase before grepping it.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'browser_navigate',
    description:
      'Open a URL in the headless browser and report the title. Use this to LOOK at the running ' +
      'application — a wrong string on a page, a control that does nothing, a layout that hides ' +
      'something — which is the class of bug you cannot find by reading code. Only reachable when ' +
      'a service is running; there is no internet.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'e.g. http://127.0.0.1:8080/orders' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_click',
    description:
      "Click the first element matching a CSS selector, through the page's own handlers. Fails if " +
      'nothing matches, which is itself a useful answer when the report says a control is missing.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
    },
  },
  {
    name: 'browser_type',
    description:
      'Set a form field to a value and fire the input and change events a framework listens for. ' +
      'Use this to reach a state the report describes before looking at the result.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' } },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_text',
    description:
      'The RENDERED text of the page, or of one element. Usually what you want rather than a ' +
      'screenshot: it is what the user reads, and you can compare it to the words in the report.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'Optional; the whole body if omitted.' } },
      required: [],
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture the viewport as a PNG and return the content-addressed reference it was stored ' +
      'under. The image is attached to the pull request so a human can see what you saw. It is ' +
      'evidence of NOTHING — no verdict reads it, and a screenshot cannot raise the tier of a ' +
      'reproduction. Take one when a person would want to see the bug.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_console',
    description:
      'Console output and browser log entries since the page loaded. Read this when something ' +
      'silently does not happen — a failed request or a thrown error is often the whole bug.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'git_commit',
    description:
      'Stage every change in the workspace and commit it. This is the ONLY way anything you did ' +
      'leaves this environment: the working tree is destroyed when the phase ends, so an ' +
      'uncommitted change did not happen. There is no push, no branch, no checkout — commit and ' +
      'nothing else.',
    input_schema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
];

export type ToolCall = { id: string; tool: string; input: Record<string, unknown> };
/** What a tool did. `ok: false` is a refusal or a failure the agent is told about, never an abort. */
export type ToolResult = { id: string; ok: boolean; output: string };

/** Where the tools act: one participant's private world, as the Runner built it. */
export type ToolWorld = {
  /** The workspace root. Every path argument resolves inside this and nowhere else. */
  root: string;
  gitDir: string;
  runAs?: { uid: number; gid: number };
  env: Record<string, string>;
  /**
   * Where a screenshot is banked. The Runner's STAGING directory, not `/blobs`: blobs
   * reach the mounted store only at the final flush, so nothing a participant writes
   * is visible to another participant or to the host mid-run (ADR-0010).
   */
  blobRoot?: string;
};

/** A named shell session: a live `sh` the Runner owns a handle to (ADR-0014). */
type Session = {
  child: ReturnType<typeof spawn>;
  /** Output seen since the last command's sentinel. */
  buffer: string;
  /** Set while a command is in flight, so a second write cannot interleave. */
  busy: boolean;
  exited: boolean;
};

/**
 * The sessions this container holds open, and the tools that act on its world.
 *
 * A class rather than free functions because a named session is state with a
 * lifetime, and ADR-0014's whole argument is that the Runner should HOLD the
 * handle instead of discovering the process in `/proc` afterwards.
 */
export class ToolHost {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly world: ToolWorld) {}

  /**
   * Close every session. Called at the end of the phase — the boundary ADR-0014
   * keeps the reap at. Teardown closes handles this object owns; there is
   * nothing to enumerate, which is the point.
   */
  /**
   * The browser, launched on first use.
   *
   * Lazily, because most runs never need one and Chromium is expensive to start. A
   * container without it fails HERE, as a tool result the agent reads, rather than at
   * container startup where it would look like the environment being broken.
   */
  private browser(): Browser {
    this.chromium ??= new Browser();
    return this.chromium;
  }

  private chromium?: Browser;

  /**
   * Take a screenshot and BANK it, returning the ref rather than the bytes.
   *
   * The bytes would blow the result ceiling and put a picture in the next prompt. The
   * ref goes into the transcript, so the pull request can show what the agent saw —
   * and the blob is written at the moment it is taken, which is the thing ADR-0011
   * says a typed tool call buys over an opaque command.
   */
  private async screenshot(): Promise<string> {
    const png = await this.browser().screenshot();
    if (!this.world.blobRoot) {
      throw new Error('there is nowhere to store a screenshot in this container');
    }
    const ref = await put(this.world.blobRoot, png);
    return `${ref} (${png.length} bytes, png)`;
  }

  async close(): Promise<void> {
    await this.chromium?.close();
    for (const session of this.sessions.values()) {
      try {
        // The group, not the child: a service started with `&` is a grandchild,
        // and killing only the shell leaves it running into the next phase —
        // exactly the survivor ADR-0010 measured.
        if (session.child.pid) process.kill(-session.child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    this.sessions.clear();
  }

  async run(call: ToolCall): Promise<ToolResult> {
    const ok = (output: string): ToolResult => ({ id: call.id, ok: true, output: cap(output) });
    const no = (output: string): ToolResult => ({ id: call.id, ok: false, output: cap(output) });
    try {
      switch (call.tool) {
        case 'shell_create':
          return ok(await this.shellCreate(str(call.input.name, 'name')));
        case 'shell_write':
          return await this.shellWrite(call);
        case 'read':
          return ok(await this.read(str(call.input.path, 'path')));
        case 'write':
          return ok(await this.write(str(call.input.path, 'path'), str(call.input.content, 'content')));
        case 'edit':
          return ok(
            await this.edit(
              str(call.input.path, 'path'),
              str(call.input.old_string, 'old_string'),
              str(call.input.new_string, 'new_string'),
            ),
          );
        case 'grep':
          return ok(await this.grep(call));
        case 'glob':
          return ok(await this.glob(str(call.input.pattern, 'pattern')));
        case 'browser_navigate':
          return ok(await this.browser().navigate(str(call.input.url, 'url')));
        case 'browser_click':
          return ok(await this.browser().click(str(call.input.selector, 'selector')));
        case 'browser_type':
          return ok(
            await this.browser().type(str(call.input.selector, 'selector'), str(call.input.text, 'text')),
          );
        case 'browser_text':
          return ok(
            await this.browser().text(
              call.input.selector === undefined ? undefined : str(call.input.selector, 'selector'),
            ),
          );
        case 'browser_screenshot':
          return ok(await this.screenshot());
        case 'browser_console':
          return ok(this.browser().console());
        case 'git_commit':
          return ok(await this.commit(str(call.input.message, 'message')));
        default:
          // Not an abort. The model asked for a tool that does not exist, which
          // is a thing to tell it rather than a thing to die of.
          return no(`there is no tool called ${call.tool}`);
      }
    } catch (error) {
      // Every failure a tool can have is a fact about the tool call, and the
      // agent is the one who needs to know. A refused path in particular must
      // read as a refusal and not as an engine fault: ADR-0011 makes path
      // confinement load-bearing, and a boundary that crashes the run when it
      // holds is a boundary nobody will keep.
      return no(error instanceof PathRefused ? `refused: ${error.message}` : String(error));
    }
  }

  private async shellCreate(name: string): Promise<string> {
    if (this.sessions.has(name) && !this.sessions.get(name)!.exited) {
      return `session ${name} already exists`;
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`already holding ${MAX_SESSIONS} sessions; close one first`);
    }
    const child = spawn('sh', [], {
      cwd: this.world.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so `close()` reaches a service the agent
      // backgrounded inside the session rather than only the shell above it.
      detached: true,
      ...(this.world.runAs ?? {}),
      env: { ...process.env, ...this.world.env },
    });
    const session: Session = { child, buffer: '', busy: false, exited: false };
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    // Merged, because a build that fails on stderr and says nothing on stdout is
    // the ordinary case and splitting them would hide half of every failure.
    child.stdout!.on('data', (chunk: string) => (session.buffer += chunk));
    child.stderr!.on('data', (chunk: string) => (session.buffer += chunk));
    child.on('close', () => (session.exited = true));
    child.on('error', () => (session.exited = true));
    this.sessions.set(name, session);
    return `session ${name} created`;
  }

  private async shellWrite(call: ToolCall): Promise<ToolResult> {
    const name = str(call.input.name, 'name');
    const input = str(call.input.input, 'input');
    const timeoutMs =
      typeof call.input.timeout_ms === 'number' && call.input.timeout_ms > 0
        ? call.input.timeout_ms
        : DEFAULT_SHELL_TIMEOUT_MS;
    const session = this.sessions.get(name);
    if (!session || session.exited) {
      return { id: call.id, ok: false, output: `no live session called ${name}` };
    }
    if (session.busy) {
      return { id: call.id, ok: false, output: `session ${name} is still running a command` };
    }
    session.busy = true;
    session.buffer = '';
    // A sentinel, because the shell never closes and there is no other end-of-
    // output signal. It carries `$?` so the exit status of the command the agent
    // actually asked for survives — the sentinel `printf` would otherwise be the
    // last command and its own status would be all that was left to read.
    const marker = `__engine_${Math.abs(hash(`${name}:${input}`))}__`;
    session.child.stdin!.write(`${input}\nprintf '%s %s\\n' ${marker} "$?"\n`);
    const settled = await waitFor(session, marker, timeoutMs);
    session.busy = false;
    if (!settled) {
      return {
        id: call.id,
        ok: false,
        output: cap(`${session.buffer}\n[no result after ${timeoutMs}ms; the command is still running]`),
      };
    }
    return {
      id: call.id,
      ok: settled.status === 0,
      output: cap(`${settled.output}[exit ${settled.status}]`),
    };
  }

  private async read(path: string): Promise<string> {
    const { target } = await this.inside(path);
    return await readFile(target, 'utf8');
  }

  private async write(path: string, content: string): Promise<string> {
    const { rel, target } = await this.inside(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    await this.chownToAuthor(target);
    return `wrote ${rel} (${Buffer.byteLength(content)} bytes)`;
  }

  private async edit(path: string, oldString: string, newString: string): Promise<string> {
    const { rel, target } = await this.inside(path);
    const body = await readFile(target, 'utf8');
    const first = body.indexOf(oldString);
    if (first === -1) throw new Error(`${rel} does not contain that string`);
    if (body.indexOf(oldString, first + 1) !== -1) {
      throw new Error(`${rel} contains that string more than once; include more context`);
    }
    await writeFile(target, body.slice(0, first) + newString + body.slice(first + oldString.length));
    await this.chownToAuthor(target);
    return `edited ${rel}`;
  }

  private async grep(call: ToolCall): Promise<string> {
    const pattern = str(call.input.pattern, 'pattern');
    const where = call.input.path === undefined ? '.' : (await this.inside(str(call.input.path, 'path'), true)).rel;
    // `--` and `-e`, so neither the pattern nor the path can be read as options.
    // `-I` skips binaries: a matched byte in a compiled artifact is noise, and a
    // very long binary line is how a bounded result becomes one useless line.
    const { stdout } = await this.spawnCapture('grep', ['-rnI', '-e', pattern, '--', where]);
    return stdout.trim() === '' ? 'no matches' : stdout;
  }

  private async glob(pattern: string): Promise<string> {
    const found: string[] = [];
    // `cwd`, so the pattern cannot name an absolute path; every hit is still
    // re-proved inside the root, because a glob can follow a symlinked directory
    // out of the tree and report a name that looks local.
    for await (const entry of glob(pattern, { cwd: this.world.root })) {
      const path = typeof entry === 'string' ? entry : String(entry);
      try {
        await this.inside(path, true);
        found.push(path);
      } catch {
        // Outside the workspace however it got here. Not reported, so the
        // listing cannot be used to learn what exists beyond the fence.
      }
      if (found.length >= 1000) break;
    }
    return found.length === 0 ? 'no matches' : found.sort().join('\n');
  }

  private async commit(message: string): Promise<string> {
    // Two subcommands, argv built here. There is no path by which this becomes a
    // push, a remote, or a checkout — that is a property of what is not written
    // rather than of a filter, which is the only kind of restriction ADR-0011
    // treats as real.
    const git = async (args: string[]) =>
      await this.spawnCapture('git', args, {
        GIT_DIR: this.world.gitDir,
        GIT_WORK_TREE: this.world.root,
      });
    await git(['add', '-A', '--']);
    // `-c`, not a config write: the identity is ours to state and the agent's
    // git config is attacker-controlled.
    const { stdout, status } = await git([
      '-c', 'user.email=agent@engine.invalid',
      '-c', 'user.name=engine agent',
      'commit', '--quiet', '-m', message,
    ]);
    // `git commit` with nothing staged exits 1 saying "nothing to commit", and
    // `spawnCapture` tolerates 1 because `grep` needs it to. Left unchecked, the
    // agent was told it committed and `rev-parse HEAD` handed back the BASE sha —
    // so the tool reported success for a commit that does not exist. The
    // orchestrator refuses that handover correctly, but by then the agent has moved
    // on believing its work is safe, which is the one thing this tool must not do.
    if (status !== 0) {
      throw new Error(`nothing was committed: ${stdout.trim().split('\n').slice(-3).join(' ')}`);
    }
    const { stdout: head } = await git(['rev-parse', 'HEAD']);
    return `${stdout.trim()}\ncommitted ${head.trim()}`.trim();
  }

  /** Every path argument, through the same check the verification engine uses. */
  private async inside(path: string, allowSymlinks = false) {
    return await resolveInside(await this.rootPath(), path, { allowSymlinks, subject: 'path' });
  }

  /**
   * The workspace root, resolved.
   *
   * `resolveInside` compares a real path against this one, so handing it an
   * unresolved root refuses every EXISTING file whenever any ancestor is a
   * symlink — which is the ordinary case for a temp directory on macOS, where
   * `/var` is a link to `/private/var`. `verify()` resolves its root before the
   * first call for exactly this reason; the tools have to as well. A `read` that
   * reports "outside the repository" for a file plainly inside it is a boundary
   * that has stopped meaning anything.
   */
  private async rootPath(): Promise<string> {
    this.resolvedRoot ??= await realpath(this.world.root);
    return this.resolvedRoot;
  }

  private resolvedRoot?: string;

  /**
   * Hand a file the tools wrote to the author, when there is one.
   *
   * The worker is root and the shells run as uid 1000, so a file `write` created
   * would otherwise be root-owned inside a tree the agent's own commands cannot
   * modify — and `git commit`, which runs as the author, could not add it.
   */
  private async chownToAuthor(target: string): Promise<void> {
    if (!this.world.runAs) return;
    await execFileAsync('chown', [`${this.world.runAs.uid}:${this.world.runAs.gid}`, target]).catch(
      () => {},
    );
  }

  /**
   * Run one command to completion, as the author, with a bounded buffer.
   *
   * A non-zero exit is not always an error here — `grep` says "no matches" with
   * exit 1 — so the status comes back rather than throwing, and each caller says
   * what it means.
   */
  private async spawnCapture(
    file: string,
    args: string[],
    extraEnv: Record<string, string> = {},
  ): Promise<{ stdout: string; status: number }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        cwd: this.world.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(this.world.runAs ?? {}),
        env: { ...process.env, ...this.world.env, ...extraEnv },
      });
      let stdout = '';
      let over = false;
      const take = (chunk: string) => {
        if (over) return;
        stdout += chunk;
        if (stdout.length > MAX_TOOL_OUTPUT * 4) {
          over = true;
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      };
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', take);
      child.stderr!.on('data', take);
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0 && code !== 1) {
          reject(new Error(`${file} ${args[0]} failed: ${stdout.trim().split('\n').slice(-3).join(' ')}`));
          return;
        }
        resolve({ stdout, status: code ?? -1 });
      });
    });
  }
}

/** Read a session's buffer until the sentinel lands, or give up and say so. */
function waitFor(
  session: Session,
  marker: string,
  timeoutMs: number,
): Promise<{ output: string; status: number } | null> {
  return new Promise((resolve) => {
    const check = () => {
      const at = session.buffer.indexOf(marker);
      if (at === -1) return false;
      const rest = session.buffer.slice(at + marker.length);
      const end = rest.indexOf('\n');
      if (end === -1) return false; // The status has not arrived yet.
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ output: session.buffer.slice(0, at), status: Number(rest.slice(0, end).trim()) });
      return true;
    };
    // Polled rather than event-driven: the sentinel can be split across two
    // chunks, so the test is over the accumulated buffer either way, and a timer
    // is the one construction that also covers a shell that dies mid-command.
    const poll = setInterval(() => {
      if (!check() && session.exited) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve({ output: session.buffer, status: -1 });
      }
    }, 20);
    const timer = setTimeout(() => {
      clearInterval(poll);
      resolve(null);
    }, timeoutMs);
  });
}

/**
 * Truncate, and SAY SO. A silently cut result reads exactly like a complete one,
 * which is the failure mode this project exists to refuse — the same reason
 * `AGENT_FINISHED` carries `stopped`.
 */
const cap = (output: string): string =>
  Buffer.byteLength(output) <= MAX_TOOL_OUTPUT
    ? output
    : `${Buffer.from(output).subarray(0, MAX_TOOL_OUTPUT).toString('utf8')}\n[truncated at ${MAX_TOOL_OUTPUT} bytes]`;

/** The model's arguments are untyped JSON. A missing string is a bad call, not a crash. */
const str = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
};

/** Stable per (session, command), so the sentinel is not a literal the agent can print. */
const hash = (text: string): number => {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return h;
};
