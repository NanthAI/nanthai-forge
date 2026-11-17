# Keep a copy of your work

Accepted source, saved Lane work and account metadata are different exports.

## Accepted source and history

A connected mirror keeps accepted main in your repository. Read its state before relying on the latest commit:

```sh
nforge github status PROJECT
```

A mirror can lag the accepted State. The status reports that gap. [Git serving](../git-serving.md) explains plain clone and fetch, including saved Lane refs for project members. Git serving is a read/export path; contributions go through Lanes and landings.

## Saved work and recovery

[Source exchange](../operations/source-exchange.md) describes retained Work and source recovery. Preserve the original request and operation id after an interruption; reconciliation does not mean uploading a new proposal. A downloaded source tree alone is not the complete retained work record.

## Account metadata

Use the account's data controls to read the current inventory and export metadata. Check the stated contents: metadata does not include source bytes, secret values or credentials. Read [security](../security.md) and [current status](../status.md) for the delivered account-data scope.

Export does not require deleting a project or account. If you choose a removal action separately, read exactly what its current control says it removes and keeps.
