## Work projection index domains

Derived rows are split without changing logical collection names, record keys,
positions or values. `projectPlanningRecords` holds `planning*` roots/versions/comments and
`planningSearch:payload` search fragments. Other `:payload` chunks, `source*`
and `_workStore*` comparison rows live in `projectWorkDataRecords`. Other collections stay
in `projectWorkRecords`. All remain disposable projections of retained canonical Work/source.
No collection is dropped: generic record pages, selected lookups and source-return snapshots
are readers even when no specialised screen names that collection.
