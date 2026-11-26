## Concurrent agents and the human cockpit

From a hosted clone or Lane, use `nforge coordination . JSON` or `nforge mcp-coordination .`. Both use your saved sign-in unless `FORGE_AUTH_TOKEN` overrides it. Approve the device in the signed-in browser after `nforge login`, or use `nforge login --scope coordination` for a coordination-only device. Never print credentials, put them in arguments, commit them or reuse a source-only `FORGE_AGENT_TOKEN` as write authority. Preserve pending operations if you need to sign in again. Coordination uses a separate MCP connection from `nforge mcp ROOT --agent`.

Announce a distinct session UUID for each environment/task, with increasing sequence and accurate `working`, `waiting`, `observing` or `completed` status. Link the actual Intent, Lane and source head and the paths/dependencies you intend to touch. This is an observation, not a lock or a verified claim of independence:

```json
{
  "action": "publish",
  "operationId": "NEW_UUID",
  "command": {
    "kind": "activity",
    "sessionId": "SESSION_UUID",
    "sequence": 1,
    "name": "Source worker",
    "environment": "Local Lane",
    "status": "working",
    "summary": "Implementing incremental source exchange",
    "context": {
      "intentId": "INTENT_ID",
      "laneId": "LANE_ID",
      "head": "HEAD",
      "paths": ["src/example.ts"],
      "dependsOn": []
    }
  }
}
```

Read `{"action":"feed","cursor":null,"pageSize":50}` before related edits and when changing work phase. Read additional pages while `isDone` is false. Keep `continueCursor` and seen operation IDs across reconnects; `cursorReset:true` means an older opaque cursor was restarted, so deduplicate replayed operation IDs; replay an original mutation UUID/payload after an unknown outcome. The feed is append-only and separate from the archived Work revision. `sessions` reads current observations, and `recent` reads newest events first, using the same paging fields.

Heartbeat with `{"action":"touch","sessionId":"SESSION_UUID"}` about every 30 s while working (last-seen only, no feed event; MCP `forge_announce` and `watch` with `sessionId` do it for you). Sessions report heartbeat receipt time (`lastSeen`) separately from `lastActivity` and `activityKind`. Heartbeats do not reset activity time. MCP workflow mutations touch activity as `MCP call`. Current hosted actions are listed in the generated contract above. Retained coordination records can still carry older native action names.

Before editing shared files, claim them: `{"action":"claim","paths":["src/api/"],"intentId":"INTENT_ID","ttlMinutes":60}` (MCP `forge_claim`). The reply lists overlapping active claims by others; a claim is advisory, never a lock. Renew with `claimId`, release with `{"action":"release","claimId":"…"}`; `overlaps` checks paths without claiming.

When waiting for related work, use `{"action":"watch","cursor":"LAST_CURSOR","waitMs":30000,"related":true,"sessionId":"SESSION_UUID"}` or MCP `forge_coordination_watch` with `related:true`. Related means events touching your claims, the session's Intent/Lane/paths, or addressed to you, including server `change` events for hosted Work writes, exchange pushes and source returns (Lane, head and up to 50 changed paths; missing paths mean unknown). It returns new events or an observed-empty timeout and closes the subscription. Resume from the returned cursor; authentication/network failure is not an empty feed.

Send fixed-choice questions and hand-backs with the [agent commands](../../workflow.md#questions-and-hand-back-hosted).
Use the coordination inbox to read retained messages and answers. Acknowledge
by id with `ack`; pass `choice` to record a question's exact answer.

Increment sequence on subsequent activity updates, including waiting/completed. Last-seen reports server receipt time; silence is unknown, not proof of online/offline status. Completing a session does not accept source or close an Intent. Source-read grants remain read-only; coordination never grants source writes, checks, locks or extra access. The human hosted Work page subscribes to the same indexed activity/message records without downloading a source archive.

Close finished work with `nforge x ROOT complete '{"laneId":"LANE_ID"}'` (or `intentId`); reopen with `start --reopen`. Acceptance does this automatically unless `keepOpen:true`. `ready` means review-ready, not complete. Completion retains source, dirty files, checkpoints, Candidates and evidence and does not prevent further edits or accept a Channel. Completion/reopening transitions use portable Work format8; older readers reject it rather than silently dropping lifecycle history. Session completion is a separate observation.
