- Hosted write-access members can subscribe to `projectFeed:page` for terminal landing and check
  outcomes, Lane saves and closes, and directed Lane attention. An optional Lane query also returns
  its current queue position. The server advertises `feed`. See [hosted project feed](../../architecture.md#hosted-project-feed).
- `nforge watch ROOT` streams selected events to a host or invokes a local command with
  the event on standard input. Landing acceptance waits use the feed when the deployment
  advertises it and the CLI has the retained Lane selection. See [connect a host to
  Forge events](../../guides/event-feed.md).
