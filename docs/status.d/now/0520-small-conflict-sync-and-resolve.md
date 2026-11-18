Small conflict sync and resolve calculations reuse verified input States within
the existing bounded execution paths. Source file-binding lookup excludes cached
ancestry manifests and sends State descriptors directly to the catalog. The 4k/29k
build guards enforce one source action per small conflict sync or resolve; complete
resolve still includes its save. See [sync/resolve costs](../../research/sync-resolve-costs.md)
for measured scope and remaining live latency qualifications.
