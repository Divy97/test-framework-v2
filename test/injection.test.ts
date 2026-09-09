// Secrets reach a sandbox with no way out, or they do not reach it (10l, ADR-0017).
//
// ADR-0017's decision is an ABSENCE rather than a restriction: *"no production-shaped
// secret is injected into a container that has a network route. Not behind an allowlist —
// an absence."* An egress allowlist was the alternative and is rejected there for a reason
// worth restating, because it is the intuition this file exists to hold the line against:
// the domain a secret is *for* is exactly where an exfiltration disguised as a legitimate
// call would go. Narrowing the target is not removing it.
//
// So the rule cannot be "the policy we sent was deny-all". That is a claim about what we
// asked for, and `SANDBOX_SEALED` exists precisely because the platform can accept a policy
// and not apply it. The rule is: a probe ran INSIDE this sandbox, after the policy, and
// found neither DNS nor a route. `mayInject` is that rule, in one place, shared by both
// executors so they cannot answer differently.
//
// What that costs, stated plainly rather than discovered later: the agent sandbox has a
// route by design — `install` needs a package registry (ADR-0013) — and it is sealed only
// after the recipe has already replayed. **So stored credentials never reach `install`,
// `migrate`, `seed`, or a service's startup.** They reach the phases that judge, where the
// project's own `test` command runs. A repository whose *install* needs a private token
// cannot be served by this design, and ADR-0017 names the fix (pre-warm the dependencies,
// then take the agent's network away too) as the boundary that has to move first.

import { describe, expect, it } from 'vitest';
import { mayInject } from '../src/executor.js';
import { fold } from '../src/fold.js';
import type { RunEvent } from '../src/events.js';
import { demoRunEvents } from '../src/fixtures/demo-run.js';

const SEALED = { dns: false, route: false };

describe('the rule, in the one place both executors read it', () => {
  it('lets a probed, sealed judging sandbox have them', () => {
    for (const phase of ['base', 'fix'] as const) {
      expect(mayInject({ phase, networked: false, probe: SEALED }), phase).toBeNull();
    }
  });

  it('refuses a sandbox that has a network route, whatever the probe said', () => {
    // The agent's. Even handed a clean probe — which cannot happen, but a caller could
    // construct it — the route is disqualifying on its own, because the ADR's objection is
    // the existence of the route and not what a probe made of it.
    const refused = mayInject({ phase: 'agent', networked: true, probe: SEALED });
    expect(refused).toMatch(/has a network route/);
    expect(refused).toContain('ADR-0017');
  });

  it('refuses a sandbox nobody probed, because an unobserved seal is not a seal', () => {
    // `executor-docker.ts` is permanently in this state: `--network none` removes every
    // interface, so there is nothing to probe from and nothing it can report observing.
    // "The flag we passed usually works" is exactly the claim the vercel probe exists
    // because it would not accept.
    const refused = mayInject({ phase: 'base', networked: false, probe: null });
    expect(refused).toMatch(/was not probed/);
  });

  it.each([
    [{ dns: true, route: false }],
    [{ dns: false, route: true }],
    [{ dns: true, route: true }],
  ])('refuses a sandbox whose probe found a way out: %j', (probe) => {
    const refused = mayInject({ phase: 'fix', networked: false, probe });
    expect(refused).toMatch(/still reached the network under deny-all/);
    // The numbers, so a reader can tell which half leaked.
    expect(refused).toContain(`dns ${probe.dns}`);
    expect(refused).toContain(`route ${probe.route}`);
  });

  it('is a REASON rather than a boolean, so the refusal can be recorded in words', () => {
    // A boolean would have made the abort's `reason` a sentence written at the call site,
    // twice, in two executors — which is how the two come to say different things about the
    // same refusal.
    expect(typeof mayInject({ phase: 'base', networked: true, probe: null })).toBe('string');
    expect(mayInject({ phase: 'base', networked: false, probe: SEALED })).toBeNull();
  });
});

describe('a withheld secret changes the record and no verdict', () => {
  /**
   * THE DEMO LOG, with the abort spliced in — not a log written here.
   *
   * The first version of this built a minimal run by hand and both sides folded to
   * `reproduced: false`, so "the same verdict with it and without" was comparing two runs
   * that had reached no verdict at all. The assertion passed and proved nothing, which is
   * the failure mode this whole file is about in the other direction.
   *
   * `demoRunEvents` is the fixture `fold`, `confidence` and the browser test are already
   * built on, and it reproduces. Splicing renumbers everything after the insertion, because
   * the fold refuses a gap and a duplicate alike.
   */
  const spliced = (withheld: boolean): RunEvent[] => {
    const out: RunEvent[] = [];
    let seq = 0;
    for (const event of demoRunEvents) {
      // AFTER the registration and BEFORE the first `TEST_RUN`, which is where a real one
      // lands: the executor writes it as it hands the Job to a judging sandbox.
      if (withheld && event.type === 'TEST_RUN' && !out.some((e) => e.type === 'VERIFICATION_ABORTED')) {
        out.push({
          run_id: event.run_id,
          seq: ++seq,
          ts: event.ts,
          type: 'VERIFICATION_ABORTED',
          payload: { v: 1, phase: 'setup', cause: 'secrets_withheld', reason: '1 stored value(s) were withheld: …' },
        });
      }
      out.push({ ...event, seq: ++seq });
    }
    return out;
  };
  const log = spliced;

  it('disqualifies nothing: the same log folds to the same verdict with it and without', () => {
    // THE assertion this cause exists to earn. `fold.ts` disqualifies an attempt on
    // `environment` and `ceiling`, blocks a run on `missing_env`, and `confidence.ts` reads
    // `handover`. `secrets_withheld` is in none of those branches — the phase ran and is
    // still judged; what a reader learns is that a world they configured was not fully
    // supplied. If a future edit adds it to a disqualifying branch, this fails.
    const without = fold(log(false));
    const with_ = fold(log(true));

    expect(with_.reproduced).toBe(without.reproduced);
    expect(with_.reproducedAttempt).toBe(without.reproducedAttempt);
    expect(with_.shownOnBase).toBe(without.shownOnBase);
    expect(with_.status).toBe(without.status);
    expect(with_.regression).toBe(without.regression);
    expect(with_.completedAttempts).toEqual(without.completedAttempts);
    // Reproduced, in both — so the comparison is between two runs that reached a verdict,
    // not between two that reached none.
    expect(with_.reproduced).toBe(true);
  });

  it('but it IS in the record, which is the whole reason it is an event', () => {
    const state = fold(log(true));
    expect(state.aborts).toHaveLength(1);
    expect(state.aborts[0]!.cause).toBe('secrets_withheld');
    expect(state.aborts[0]!.reason).toMatch(/withheld/);
  });

  it('and it names how many, never which value', () => {
    // An event is append-only and forever. `redact.ts` covers a value that reaches a
    // command line; the only defence for one that reaches a payload is never putting it
    // there, so the abort counts and quotes the rule.
    const state = fold(log(true));
    expect(state.aborts[0]!.reason).not.toMatch(/sk-|postgres:\/\/|Bearer /);
  });
});
