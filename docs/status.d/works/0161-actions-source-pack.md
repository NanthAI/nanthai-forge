- Actions planning supports a default-off source-pack capability that skips the
  historical pack State read. Verified members seed a fresh cache by content id,
  and the plan checks the complete Candidate tree after fetching missing blobs.
  Pack failures record a reason and retry through full source transfer.
  [GitHub Actions checks](../../operations/github-actions-checks.md#forge-source-packs)
