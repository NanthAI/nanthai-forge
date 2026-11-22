[Item audit trails](../../planning.md#audit-trail) read bounded, paged timelines for one Item
(`planning {planningItemId, history:true}`) and bounded UTC window views per Initiative or project
(`planning {history:{from, to?, change?}}`) from the existing journal with zero new tables or
indexes; device planning puts record `agent` and `agentClient` in the same mutation.
