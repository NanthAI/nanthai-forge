The negotiated [source authorship contract](../../agents/workflow.md#authorship-stamp-compatibility)
requires an agent model once at `start` (`model` or `FORGE_AGENT_MODEL`, with
`unknown` allowed), inherits it for save and land, and retains each save's stamp
independently. Person-only receipts record the person, and old agent clients
without a model show “not declared”. The proof page reads the selected save's
model and names the agent builder and person approver separately for supervised
landings, as does `landings`. The GitHub mirror uses the receipt for co-author
credit. Save-level blame and log attribution are tracked by Item 3968a655.
