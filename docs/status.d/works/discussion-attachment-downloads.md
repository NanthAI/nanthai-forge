The hosted discussion download route verifies the bytes of an attachment bound to an exact project,
Item and comment. It applies current discussion access and returns a forced download with the stored
media type. Item purge ends downloads at the durable Item tombstone and marks the Item's
artifact bindings removed in pages; each R2 delete is tracked and retried until it succeeds, and an
upload in flight across a purge deletes its own bytes at commit (operator count: `artifactStorage:pendingDeletes`). Downloads are capped at 2 GB per project
and 5 GB for all projects per UTC day: one mutation reserves the bytes before R2 is read, a refused
download is a 429 `ATTACHMENT_DOWNLOAD_LIMIT` naming the cap and resetting at 00:00 UTC, and a read that
fails or is revoked gives its reservation back. Uploads, client controls (including showing the limit
message in the web view) and inline images are pending.
