---
status: accepted
---

# Live streaming: SSE, not WebSockets

The dashboard's live view is a tail of an append-only, per-run event stream.
The browser never sends anything upstream on that channel — commands (rerun,
approve) are ordinary HTTP POSTs.

**Decision.** Server-Sent Events.

- The data flow is strictly unidirectional; SSE is the honest fit, WebSockets
  would be capability we don't use.
- Reconnection is built in: the browser resends `Last-Event-ID`, which maps
  1:1 onto the event `seq`. Resuming a dropped stream is `WHERE run_id = ?
  AND seq > ?` — no protocol invented, no missed events, no duplicates.
- Plain HTTP: proxies, auth middleware, and curl all work unmodified.

**Rejected.** WebSockets (bidirectional capability with none of our traffic
needing it; hand-rolled reconnection/resume where SSE gives it for free).
Polling (workable, but turns "live transcript" into "jerky transcript" for no
saved complexity).

**Revisit when** the dashboard needs low-latency upstream interaction on the
same channel (collaborative control, interactive steering of a run).
