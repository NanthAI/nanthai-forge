Clone roots refresh from accepted main with `nforge pull ROOT`, agent `pull {}`
and the existing MCP `forge_task`. Root `status` reports freshness and accepted
source revision distance. Pull refuses local tracked edits, preserves disjoint
ignored outputs/dependency links, resumes interrupted publication, reuses cached
and unchanged local bytes, and fetches no source packs. Current pulls cost one
head query and no R2 GETs; receipts report requests and transferred bytes. Pull
preserves the root and surviving directory inodes for existing shells/editors and
applies through the Lane checkout's in-place delta journal, so its file work
scales with changed paths (unchanged files are trusted through the stat index).
