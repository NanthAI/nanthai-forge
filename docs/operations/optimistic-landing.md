# Optimistic landing and recovery

Forge has one landing path: the [hosted landing queue](../agents/workflow.md#landing-queue).
The native-owner optimistic mode this page used to describe ran only in the local landing
driver. That driver was removed with one client mode (Issue 657d63ee), along with its
`undo-revert` action.

What replaces it on the hosted queue:

- **Land first, audit after.** `acceptance.landingMode: "fast"` lands a change on its own
  check and verifies main afterwards. A red audit finds the culprit and reverts it, or opens
  a fix. A project earns fast mode from its own audit history. See
  [landing modes](../pre-queue-checks.md#landing-modes) for the rules, the flake policy and
  the command that turns it on.
- **Compensating a landing.** `nforge x ROOT revert '{"target":...}'` makes a compensating
  Lane. It lands through the queue with an ordinary check and acceptance; main never rewinds
  ([agent workflow](../agents/workflow.md)).

`acceptance.landing: "optimistic"` is still accepted in a policy for compatibility. On the
hosted queue it only opts out of grouped landing, the same as `"serial"`.
