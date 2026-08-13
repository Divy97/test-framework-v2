// A headless browser, in the agent sandbox only (ADR-0006's v1.5 amendment).
//
// The browser is how the agent FINDS a bug it cannot find by reading — a wrong string
// rendered on a page is the canonical v1.5 bug. What the engine JUDGES is still a
// committed command's exit code, run in a container with no browser in it. So this
// adds a capability to the agent and gives the judge nothing new to trust, which is
// the only way a system built on distrusting its agent can accept a new capability.
//
// Screenshots, console logs and network traces are TESTIMONY. They are banked as
// blobs at the moment they are taken, shown in the pull request, and are inputs to no
// verdict. A browser-driven agent-authored reproduction is Tier 2, exactly like any
// other agent-authored one: being able to see the bug does not make the reproduction
// independent.
//
// No puppeteer, no playwright, no websocket package. Chromium speaks the DevTools
// protocol over a WebSocket, and Node 22 has a WebSocket — so this is a few dozen
// lines and one fewer supply chain inside the container that runs untrusted code.
// `Runtime.evaluate` does the DOM work, which is why click and type need no input
// synthesis: the page's own event handlers are what matter, not the pixels.

import { spawn, type ChildProcess } from 'node:child_process';

/** Where the image puts it. Named by the Dockerfile so a base-image change fails loudly. */
/**
 * Read at LAUNCH, not at import.
 *
 * It was a module-level `const`, so anything setting `ENGINE_CHROMIUM` after this module
 * was imported — which is every test that wants to point the browser somewhere, and any
 * caller configuring at runtime — was silently ignored and got `ENOENT` for the container
 * default. A configuration variable that only works if you set it before an import you do
 * not control is not a configuration variable.
 */
const chromium = () => process.env.ENGINE_CHROMIUM ?? '/usr/bin/chromium-browser';
const PORT = 9222;
const START_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 30_000;

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void };

/**
 * One browser, one tab, for the life of the agent phase.
 *
 * One tab because a reproduction is a page, and a tool surface with tab management on
 * it is a surface with more to get wrong than it buys. The agent navigates; if it
 * needs two pages it navigates twice.
 */
export class Browser {
  private child: ChildProcess | null = null;
  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Console output and failed requests, in order. Testimony, and bounded. */
  private readonly log: string[] = [];
  /** Set when the browser could not be started at all. Reported, never thrown from a listener. */
  private spawnFailure: string | null = null;

  /** Launch, attach to a tab, and start collecting console output. Idempotent. */
  async start(): Promise<void> {
    if (this.socket) return;
    this.child = spawn(
      chromium(),
      [
        '--headless=new',
        // Chromium's own sandbox needs privileges this container does not have, and
        // the container IS the sandbox here — it holds no credential, has no event
        // channel and its filesystem is destroyed. Layering a second one inside would
        // buy nothing and cost the browser starting at all.
        '--no-sandbox',
        '--disable-gpu',
        // `/dev/shm` is small in a container and Chromium's default use of it is how
        // "the tab crashed" happens with no other explanation.
        '--disable-dev-shm-usage',
        `--remote-debugging-port=${PORT}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], detached: true },
    );
    // A spawn that never happened — no chromium in this image — fires on the child
    // and NOTHING is listening, so it escapes as an uncaught exception and takes the
    // process with it. That is the Runner, in a container, mid-run.
    //
    // Caught by the suite rather than by review: `tools.test.ts` runs in-process on a
    // machine with no chromium, and the whole test file died. Recorded here so
    // `waitForTarget` can report the real cause instead of timing out after twenty
    // seconds with "never answered" — "the browser is not in this image" and "the
    // browser crashed" are different operational faults.
    this.child.on('error', (error) => {
      this.spawnFailure = String(error);
    });

    const target = await this.waitForTarget();
    this.socket = new WebSocket(target);
    await new Promise<void>((resolve, reject) => {
      this.socket!.addEventListener('open', () => resolve(), { once: true });
      this.socket!.addEventListener('error', () => reject(new Error('could not attach to the browser')), {
        once: true,
      });
    });
    this.socket.addEventListener('message', (event) => this.receive(String(event.data)));

    // A session on the page target, so `Runtime.evaluate` runs in the page rather
    // than in the browser process.
    const { targetInfos } = (await this.send('Target.getTargets')) as {
      targetInfos: { targetId: string; type: string }[];
    };
    const pageTarget = targetInfos.find((info) => info.type === 'page');
    if (!pageTarget) throw new Error('the browser started with no page in it');
    const attached = (await this.send('Target.attachToTarget', {
      targetId: pageTarget.targetId,
      flatten: true,
    })) as { sessionId: string };
    this.sessionId = attached.sessionId;

    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
  }

  async close(): Promise<void> {
    this.socket?.close();
    this.socket = null;
    try {
      if (this.child?.pid) process.kill(-this.child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    this.child = null;
  }

  /** Navigate and wait for the load event. Returns the title and the URL that loaded. */
  async navigate(url: string): Promise<string> {
    await this.start();
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await Promise.race([loaded, new Promise((done) => setTimeout(done, CALL_TIMEOUT_MS))]);
    const title = await this.evaluate('document.title');
    const at = await this.evaluate('location.href');
    return `loaded ${String(at)} — title: ${String(title)}`;
  }

  /**
   * Click by CSS selector, through the page's own event handlers.
   *
   * `element.click()` rather than synthesised input events: what a reproduction cares
   * about is what the application does, and dispatching a real mouse event at
   * coordinates would make the tool depend on layout.
   */
  async click(selector: string): Promise<string> {
    await this.start();
    const found = await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'missing'; el.click(); return 'clicked'; })()`,
    );
    if (found === 'missing') throw new Error(`nothing matches ${selector}`);
    return `clicked ${selector}`;
  }

  /** Set a field's value and fire the events a framework listens for. */
  async type(selector: string, text: string): Promise<string> {
    await this.start();
    const result = await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'missing';
        el.focus(); el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'typed'; })()`,
    );
    if (result === 'missing') throw new Error(`nothing matches ${selector}`);
    return `typed into ${selector}`;
  }

  /** A PNG of the viewport, as raw bytes. The caller banks it; this does not. */
  async screenshot(): Promise<Buffer> {
    await this.start();
    const { data } = (await this.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    return Buffer.from(data, 'base64');
  }

  /** The rendered text of the page, or of one element. What the agent actually reads. */
  async text(selector?: string): Promise<string> {
    await this.start();
    const expression = selector
      ? `(document.querySelector(${JSON.stringify(selector)}) ?? {}).innerText ?? 'missing'`
      : 'document.body.innerText';
    return String(await this.evaluate(expression));
  }

  /** Console output and failed requests since the browser started. Testimony. */
  console(): string {
    return this.log.length === 0 ? 'nothing logged' : this.log.join('\n');
  }

  private async evaluate(expression: string): Promise<unknown> {
    const { result, exceptionDetails } = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value?: unknown }; exceptionDetails?: { text: string } };
    if (exceptionDetails) throw new Error(`the page threw: ${exceptionDetails.text}`);
    return result.value;
  }

  private async waitForTarget(): Promise<string> {
    const until = Date.now() + START_TIMEOUT_MS;
    let last = 'never answered';
    while (Date.now() < until) {
      // Fail fast on a spawn that never happened. Polling for twenty seconds for a
      // process that does not exist is a slow way to say the image is wrong.
      if (this.spawnFailure) {
        throw new Error(`the browser could not be started: ${this.spawnFailure} (is ${chromium()} present?)`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/json/version`, {
          signal: AbortSignal.timeout(2_000),
        });
        const body = (await response.json()) as { webSocketDebuggerUrl?: string };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
        last = 'no debugger url';
      } catch (error) {
        last = String((error as Error).message ?? error);
      }
      await new Promise((done) => setTimeout(done, 150));
    }
    // Named rather than a timeout with no cause: "the browser is not in this image"
    // and "the browser crashed on startup" are different operational faults.
    throw new Error(`the browser did not come up on port ${PORT} (${last}); is ${chromium()} present?`);
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.socket) throw new Error('the browser is not attached');
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    // Every call after the attach goes to the PAGE session. Without this,
    // `Runtime.evaluate` runs in the browser process, where there is no document.
    if (this.sessionId && !method.startsWith('Target.')) message.sessionId = this.sessionId;
    this.socket.send(JSON.stringify(message));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} did not answer in ${CALL_TIMEOUT_MS}ms`));
      }, CALL_TIMEOUT_MS).unref();
    });
  }

  private once(event: string): Promise<void> {
    return new Promise((resolve) => this.waiters.push({ event, resolve }));
  }

  private readonly waiters: { event: string; resolve: () => void }[] = [];

  private receive(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      result?: unknown;
      error?: { message: string };
      params?: Record<string, unknown>;
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const settle = this.pending.get(message.id);
      if (!settle) return;
      this.pending.delete(message.id);
      if (message.error) settle.reject(new Error(message.error.message));
      else settle.resolve(message.result);
      return;
    }
    if (message.method) {
      // RESOLVE the waiters this event is for, and put the rest back.
      //
      // This used to filter the matching waiter out of the list and drop it on the
      // floor without ever calling `resolve`, so the promise `navigate()` awaits for
      // `Page.loadEventFired` never settled. The `Promise.race` around it then always
      // fell through to the 30-second ceiling — meaning EVERY navigation cost 30s and
      // reported success, in the container as well as on a host. It is a performance
      // bug that looks like a slow page, which is why it survived: nothing was ever
      // wrong with the result, only with how long the agent waited for it.
      const waiting = this.waiters.splice(0);
      for (const waiter of waiting) {
        if (waiter.event === message.method) waiter.resolve();
        else this.waiters.push(waiter);
      }
      // Console output and browser log entries, kept bounded: an application that
      // logs in a loop must not fill host memory through a tool nobody is reading.
      // `Runtime.exceptionThrown` as well as the two log channels.
      //
      // Without it an uncaught page exception was INVISIBLE: a page containing
      // `<script>notAFunction()</script>` left `console()` reading `nothing logged`. That
      // is the failure the browser exists to find — ADR-0006's amendment gave the agent a
      // browser to see bugs it cannot find by reading, and a JavaScript error is the most
      // common thing a rendered page gets wrong.
      if (
        message.method === 'Runtime.consoleAPICalled' ||
        message.method === 'Log.entryAdded' ||
        message.method === 'Runtime.exceptionThrown'
      ) {
        if (this.log.length < 200) this.log.push(summarise(message.method, message.params ?? {}));
      }
    }
  }
}

/** One line per log entry. The bytes are testimony; the shape is ours. */
function summarise(method: string, params: Record<string, unknown>): string {
  if (method === 'Log.entryAdded') {
    const entry = params.entry as { level?: string; text?: string } | undefined;
    return `[${entry?.level ?? 'log'}] ${entry?.text ?? ''}`;
  }
  // An uncaught page exception, which used to be invisible: neither of the two log
  // channels carries one, so a page whose script threw read as a page with nothing to
  // say. Reported at `[error]` so it reads like what it is, with the first stack frame —
  // the message alone rarely names the file.
  if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails as
      | { text?: string; url?: string; lineNumber?: number; exception?: { description?: string } }
      | undefined;
    const where = details?.url ? ` (${details.url}:${(details.lineNumber ?? 0) + 1})` : '';
    return `[error] ${details?.exception?.description ?? details?.text ?? 'uncaught exception'}${where}`;
  }
  const args = (params.args as { value?: unknown; description?: string }[] | undefined) ?? [];
  const level = String(params.type ?? 'log');
  return `[${level}] ${args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' ')}`;
}
