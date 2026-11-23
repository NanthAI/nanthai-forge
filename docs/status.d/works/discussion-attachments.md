Planning discussions carry attachments stored in R2 (Item 9a3d6f5f). The project owner attaches up to four
files to a comment from the web composer (Attach) or the CLI/MCP (`comment-planning-item` with `files`, local
paths). Limits: 10 MB per image (PNG, JPEG, GIF, WebP), 25 MB per other file, 1 GB of attachments per project.
Each file takes three calls whatever its size: `discussionAttachmentUpload:prepare` (one mutation: access,
the project's stored bytes, the reservation and a signed create-only PUT), the PUT straight to R2, and
`commit` (an R2 HEAD that checks the exact size and checksum). The comment command then names the committed
files and the server rewrites their size and type from the binding; a comment can name only files committed for
that comment. A file whose comment never arrives is removed an hour later and its bytes return to the project's
allowance. A page shows a picture of 1 MB or less inline once it scrolls into view and asks first for a larger one;
every other file is a download, never drawn as a page.

The hosted discussion download route verifies the bytes of an attachment bound to an exact project,
Item and comment. It applies current discussion access and returns a forced download with the stored
media type. Item purge ends downloads at the durable Item tombstone and marks the Item's
artifact bindings removed in pages; each R2 delete is tracked and retried until it succeeds, and an
upload in flight across a purge deletes its own bytes at commit (operator count: `artifactStorage:pendingDeletes`).
Downloads are capped at 2 GB per project and 5 GB for all projects per UTC day: one mutation reserves the bytes
before R2 is read, a refused download is a 429 `ATTACHMENT_DOWNLOAD_LIMIT` naming the cap and resetting at
00:00 UTC (the web view shows that message), and a read that fails or is revoked gives its reservation back.
Uploads are off on a deployment until its operator sets `FORGE_DISCUSSION_UPLOADS=1`, after the deployed download at
the 25 MB maximum has been verified (not yet done on any deployment).
