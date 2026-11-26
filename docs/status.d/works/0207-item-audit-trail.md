[Item audit trails](../../planning.md#audit-trail) read bounded, paged timelines for one Item
(`planning {planningItemId, history:true}`) and bounded UTC window views per Initiative or project
(`planning {history:{from, to?, change?}}`) from the existing journal with zero new tables or
indexes; window rows carry the Item's `## Decisions` lines dated in the window (`decisions`); device planning puts record `agent` and `agentClient` in the same mutation.
Item Audit pages Lanes and landing notes by Item membership, including landings after any number
of follow-up Intents.
