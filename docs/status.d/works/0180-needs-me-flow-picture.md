- Needs me opens on the Flow picture, "On the way to main": the line's stops (Editing, Saved, In queue,
  Checking, main) as isometric platforms with one block per open Lane, Lanes checked together as one
  tower and main as today's landings hour by hour. The Checking stop splits Lanes in the check phase from
  passed Lanes waiting to land, using the same counts in the top bar, Flow and Lanes. The top bar keeps
  each count with its stop name and stacks the single-count stops on phones. A `+` marks figures from
  the capped feed. Passed Lanes waiting to land are amber. The picture shows five figures
  (landed this hour, land to main, needs fix, reverted, main green or red), a state legend (one small block per look the picture draws, one word each, the meaning on hover) and a
  bar for running checks: the Standing line's roll with one segment per running check, filled by its elapsed time
  against the day's middle landing time, a segment per Lane that passed and waits to land, and empty segments
  for room to start more checks, with the Lane count and time in each segment's hover. The green hover dates the
  latest full pass when the existing FYI audit page reports its finish time. CI minutes sit full width under
  the bar, as the day's accounted minutes. FYI has no tile row. It replaced "Moving without you",
  shares the top bar's line read and the page's Needs you and FYI reads, stands
  top left of a 2 x 2 (Needs you top right, Loose ends bottom left, FYI bottom right; Reset layout returns to it and a saved layout is kept), gives Needs you width while it holds anything, and a
  held block's tag goes to its row. On phones, flat rows follow Needs you in reading and keyboard order.
  A cube opens its Lane. The top-bar stops, station labels and the solid columns used past the 60-Lane
  feed cap open station drawers. A drawer makes at most one batched read when opened. Flow animates moving work when fresh
  and quiets its loops after a minute without input. Reduced motion removes the animation.
- Home uses the same viewer-specific decision rules as Needs me: asked-ahead requests and agent-only holds
  do not count. Incomplete project or decision pages show a lower bound, not an exact zero. Home reads once
  per project-list page, not once per project, and does not subscribe or poll. An already-read decision can
  enter or leave the count at its known deadline in the browser without a request. Home and Flow use the latest
  recorded main-audit verdict rather than the check on a Candidate. Without a verdict they distinguish no
  configured check from health not reported.
- Flow links up to five recent receipts to Code History, with their landing IDs and the titles available
  in the existing live-line and FYI responses. A retained revert is marked separately from a landing taken out of main.
  A manual revert leaves its receipt link in the live-line summary even when its Needs you notice clears.
  The audit recovery count still covers main-audit recoveries only.

- The Lane yard, Lane review, History, Needs you and Item discussion use the same public byline. It links the handle and agent run when the viewer may see them. The Yard names the latest save. Lane review names the save that published the pinned head. Held reviews, History and discussion use the recorded submission, receipt or comment.
- The agent run page shows the latest [local Forge hook state](../../agents/hooks.md#hook-state-on-an-agent-run) reported on a Lane start or save, with the report time. Older clients leave it unreported.
- Needs you and `nforge agent ROOT approve-link '{}'` list held reviews from the landing queue, with one approval link per submission. Overlapping Lanes and later Lane saves leave those reviews visible. Needs me and the Lane page ask once before approving a held Candidate with no recorded check run; dismissing the sheet approves nothing.
