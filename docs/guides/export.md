# Keep a copy of your work

Accepted source, saved Lane work and account metadata are different exports.

## Accepted source and history

A connected mirror keeps accepted main in your repository. Read its state before relying on the latest commit:

```sh
nforge github status PROJECT
```

A mirror can lag the accepted State. The status reports that gap. [Git serving](../git-serving.md) explains plain clone and fetch, including saved Lane refs for project members. Git serving is a read/export path; contributions go through Lanes and landings.

## Planning and project metadata

The source mirror does not contain Forge Items, Initiatives, their comments or versions,
relations, check/acceptance receipts or Lane metadata. Saved Lane source refs are a source
copy, not the complete Lane record. [Planning](../planning.md#planning-export-and-full-archives)
describes the retained planning data and the staged import path.

A single downloadable project archive with a fresh-project round trip is not available yet.
Its receipt-ID mapping and visibility contract remain open. Existing same-project recovery
is not that portable archive; a source download or Git mirror must not be described as
“everything”. Keeping a copy is independent of deletion and adds no required removal step.

## Saved work and recovery

[Source exchange](../operations/source-exchange.md) describes retained Work and source recovery. Preserve the original request and operation id after an interruption; reconciliation does not mean uploading a new proposal. A downloaded source tree alone is not the complete retained work record.

## Account metadata

Use Account → Your data, signed in on the web, to read the current inventory and export metadata (device and agent credentials are refused there). Check the stated contents: metadata does not include source bytes, secret values or credentials. Read [security](../security.md) and [current status](../status.md) for the delivered account-data scope.

Export does not require deleting a project or account. If you choose a removal action separately, read exactly what its current control says it removes and keeps.
