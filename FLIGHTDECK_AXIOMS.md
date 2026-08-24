# FLIGHTDECK_AXIOMS

Binding rules for what FlightDeck displays. Violation is a bug, not a preference.

These exist because an operator makes decisions from these cards. A card that is
merely *plausible* is worse than a card that is blank: a blank card sends you to
look, a plausible wrong one sends you to act. Every axiom below is a rule about
never producing the plausible-wrong case.

Disagreement is a reason to PR this file, never to override it in the moment.
The same standing as `WAVE_AXIOMS.md`.

---

## AX-1 — Display only what agent data says. Never infer.

Every displayed value traces to a field in an emitted event. No estimation, no
extrapolation, no "probably still running."

**The clock corollary.** Any computation involving *now* uses the **server's**
clock, carried in the frame, against a **timestamp from the data**. Client-side
timers are not permitted as a source of truth: the page may not be open, may have
just loaded, or FlightDeck may have restarted — and each of those silently resets
a running timer while the number keeps looking authoritative.

Two shapes are always safe because both endpoints are facts:

- `server_now − last_event.ts` — time since last update
- `server_now − activity_start.ts` — time since a start we were *told about*

A duration whose start we were never told about is not displayable. That is not a
gap to fill with a default; it is the absence of a measurement.

> Current violation: the blocked-on-you figure is a hybrid. Historical intervals
> come from event timestamps (`src/metrics.ts`, correct), but the open interval is
> ticked by a client `setInterval` (`src/ui/page.ts:325`) reading
> `data-blocked-ms` (`src/ui/eta_strip.ts:36`) from page load. A restart or a
> reload resets it while the number keeps looking authoritative.
>
> `src/metrics.ts:12` already names the split — *"that keeps ticking is a UI
> concern … this module intentionally does not"* — so the module boundary is
> right. The UI half is the part that needs a server-supplied `now`.

---

## AX-2 — If we do not know, we do not guess. Mark the hole.

A missing value renders as visibly missing. It never renders as a zero, a dash
that reads as zero, an empty string, or a default.

**The pair is atomic.** A numerator is meaningful only against a known
denominator and a known start. When either is unknown, display neither — `?`,
not `0 / ?`. `0` in that position is not a measurement, it is an initialisation:
it means *"we have observed zero"*, which on a card with no lifecycle head is a
different claim from *"zero happened"*.

**Name the kind of hole.** "Structurally unknowable" and "an emit failed" are
different problems for the reader and must look different. A hole with no
explanation is a second hole.

**The test for whether a metric is real:** *if it can return its happy answer
when its input is empty, it is not a metric yet.* A display that cannot
distinguish "no data" from "the data says zero" is displaying nothing, twice.

---

## AX-3 — Everything displayed is attributable.

FlightDeck monitors **agents**. Every card, metric, and queue entry is
attributable either to **one named agent** or explicitly to **all agents**.

Cards therefore either *represent* an agent, or are wrapped in an agent context.
The concern queue identifies the agent for each concern.

"All agents" is a real attribution and must be labelled as one. It is never a
place to put values whose owner we failed to resolve — that is a hole, and AX-2
governs it.

*(Host-scoped attribution — "all agents on this host" — is deliberately out of
scope. Add it when there is a decision that needs it, not before.)*

---

## AX-4 — Identify by session. Display by name.

**Identity is the session id.** It is assigned rather than chosen, stable across
a rename, and unique per session.

**Display is the Dev-Name.** It is chosen, mutable, and not unique — an agent may
rename itself mid-session, and two agents may pick the same name.

Conflating the two loses real information. One agent that renamed reads as two
agents; two agents that collided read as one.

**Name changes are recorded, not absorbed.** The session carries its name history,
so an operator can reconstruct who was who. A card may show the current name; the
record keeps the sequence.

**Process identity is the collision detector.** `pid + host` is per-process, which
is exactly the granularity that catches the aoe/tmux double-start. Two distinct
sessions or pids presenting one Dev-Name in one project is an **error state**, and
FlightDeck should surface it rather than fold them together. This is a capability,
not a formality: it is a class of error the board currently cannot see at all.

`pid` is not the primary key — it does not survive a restart and is not unique
across hosts. Session identifies; pid+host detects.

**No identity fallback may collide.** A degraded identity must degrade to something
*visibly* degraded, never to a value two different agents could share.

> **Resolved at source, not yet fleet-deployed** — both violations named below
> were in the kit rather than here, in
> `claudecode-workflow:scripts/flightdeck-session-emit.sh`, and both are fixed
> on that repo's `main`. Neither fix is in effect until an agent reinstalls the
> kit (merged ≠ shipped) — until then, this file's own compatibility reads
> (`src/ui/presence.ts`, `tests/presence.test.ts`) keep exercising the
> old-shape population on purpose; do not remove them on the strength of this
> note alone. Kept as a worked example regardless: two DIFFERENT identity
> fallbacks, in the same file, by the same hand, that each violated this axiom.
>
> **The session fallback collided.** The old chain —
> `session="${FLIGHTDECK_SESSION_ID:-${CLAUDE_SESSION_ID:-$(basename "$PWD")}}"`
> — degraded two agents in one project to the SAME key (`basename "$PWD"`), so
> the aoe/tmux double-start, precisely the error state a second key exists to
> catch, was undetectable on the path where it was most likely: the two
> sessions folded into one card and read as one busy agent. Fixed
> (cc-workflow#1166) by widening the chain — below the hook's own stdin
> `session_id`, the first and still-primary tier — to
> `FLIGHTDECK_SESSION_ID → CLAUDE_CODE_SESSION_ID → tmux-${TMUX_PANE#%} →
> basename "$PWD"` — each tier distinct per session before falling through to
> the collision-prone last resort.
>
> **The agent fallback violated both halves of this axiom's headline
> sentence, not just the "visibly degraded" half.** The old line,
> `agent="$host"`, was ONCE the correct pattern — the deck had no way to
> render "no real identity" honestly, so faking the agent field to the
> hostname was the only available *visible* degradation. But it never stopped
> colliding either: every agent-less session on one host degraded to the SAME
> key (the host), exactly the shape `tests/presence.test.ts`'s "two
> agent-less sessions on the SAME host aggregate into one unattributed row"
> case exists to catch. Once flightdeck#38 gave the deck a real, honest
> degradation path (`attributed: false`, rendered distinctly, tallied), the
> "visible" half became actively counterproductive too: a fabricated value
> dressed as attribution, not a visibly-marked absence. Fixed
> (cc-workflow#1151) by omitting `--agent` from the emit call entirely when no
> Dev-Name resolves, letting the deck's own honest-absence rendering take
> over.

---

## AX-5 — Staleness is first-class.

Every agent carries how old its information is, derived as
`server_now − last_event.ts`. Pure data on both ends; no inference (AX-1).

Staleness is a **card state**, not a number in a tooltip. An agent last heard from
two hours ago must look different at a glance from one last heard from thirty
seconds ago — the point is scanning a board, not interrogating a card.

Staleness is reported. It is never *interpreted*: "stale" says when we last heard,
it does not claim the agent is dead, stuck, or finished. Inferring a status from
silence is an AX-1 violation.

Agent-level granularity is sufficient. Per-metric staleness is not currently
justified.

---

## AX-6 — One field, one meaning.

A field name has a single declared type and a single semantics across every
emitter. A field that means different things in different contexts is two fields
sharing one name, and must be split.

This applies to types as much as to names: a field declared "string or structured"
that one side emits as a string and the other reads as an object is the same
defect wearing a permissive schema.

> Current violations:
>
> - **`phase`** carries both the plan phase (`P1`, `P2` — baked into wave ids like
>   `P1W1`) and the workflow node name (`Flight loop`, `Rehydrate`, `session`).
>   Every `phase` value in the live store is a node name; no plan phase appears at
>   all. Agents confuse the two routinely, which is why the concept is being
>   renamed to **Wavetrain** rather than merely disambiguated. That rename must
>   carry a compatibility story: `phase` also lives in `phases-waves.json`, in the
>   event schema, and inside historical wave ids.
> - **`detail`** is declared *"Free-form detail payload (string or structured)"* in
>   the emitter's `schema.json` and `detail?: unknown` in
>   `src/events/contract.ts:100`. The emitter ships a JSON **string**; `asRecord`
>   (`src/fold.ts:92`) accepts only **objects**; the field is dropped and nothing
>   errors. That is how `planTotal` never reaches a card
>   (`Wave-Engineering/claudecode-workflow#1145`).

A new field may not be added to a name that is already occupied. Disambiguate
first, then extend.

---

## Why these are axioms and not guidelines

Each one names a failure that has already happened here, and every one of those
failures had the same shape: **an operation that could not distinguish "did the
thing" from "did nothing", reported as success.**

A dependency scan that passed over zero manifests. A repo count that returned 0
because a URL rewrite was in force. A test that passed because the code it
claimed to exercise had already exited. A filter that matched zero rows by
construction, where zero rows read as a finding. A campaign card reading `0 / ?`
for a campaign whose plan file has known totals sitting on disk.

None of those threw an error. All of them were read as answers.

---

## Where the work is tracked

Parent plan: **`Wave-Engineering/claudecode-workflow#1146`** — the FlightDeck card
contract. It carries the four decision-grade fields (agent name, current state,
work items done/total, waves done/total), the implementation sequence, and the
emit-side prerequisites.

Symptoms of these axioms' absence, already filed:

| issue | axiom |
|---|---|
| `#31` — a headless activity renders as a phantom campaign | AX-2, AX-6 |
| `claudecode-workflow#1144` — one campaign, two activity ids | AX-3, AX-4 |
| `claudecode-workflow#1145` — `--detail` ships JSON as a string | AX-6 |
