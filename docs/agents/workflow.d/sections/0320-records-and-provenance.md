`records {collection,parentId?|status?|id?,version?,cursor?}` pages canonical
retained work and pins each immutable version; a page is not a project snapshot.
`provenance {candidateId,file?,lines?,cursor?}` reads one changed file and up to
20 Lane history versions, including syncs. Continue the returned cursor with the
same selection. Partial history/dependencies mark line attribution partial;
requester accounts do not establish an unrecorded executor identity. Both readers
reuse current project authority, including after cached source reads, with no
writes, wakes or idle observers. Provenance uses at most three metadata queries
plus batch R2 descriptor/download pages; source bytes stay in R2.
