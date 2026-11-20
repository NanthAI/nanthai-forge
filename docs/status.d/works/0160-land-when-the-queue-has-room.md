- `land {"maxChecks":N}` submits only while fewer than N checks run or wait (at most N with it), judged by the
  server with the submit, and a land without room waits on a live query instead of a polling
  loop; behind `FORGE_QUEUE_LAND_WHEN_ROOM`, off by default
  ([agent workflow](../../agents/workflow.d/sections/2250-land-when-the-queue-has-room.md)).
