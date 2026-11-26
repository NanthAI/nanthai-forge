# Keep a copy of your work

You can keep copies of accepted source, planning history, saved Lane work and account metadata.

## Accepted source and history

A connected mirror keeps accepted main in your repository. Check it from your Forge clone before relying on the latest commit:

```sh
nforge github status .
```

A mirror can lag the accepted State. The status reports that gap. [Git serving](../git-serving.md) describes accepted main and saved Lane refs. [Public project access](access.md#browse-or-share-a-public-project) explains what visitors can see and how to clone a Forge project.

## Planning and project metadata

Project owners can open their project’s `/planning` page and choose **More planning actions** →
**Export planning history** to save `forge-planning.json`. The download covers retained Items, Initiatives, comments
and versions across the project. See the [planning export format](../planning.md#planning-export-and-full-archives).

The source mirror omits Forge Items, Initiatives, their comments, versions and relations,
check and acceptance receipts, and Lane metadata. A saved Lane ref carries that Lane's
source. A single project archive that can be imported into a fresh project is still planned.

## Saved work and recovery

[Source exchange](../operations/source-exchange.md) describes retained Work and source recovery. Preserve the original request and operation id after an interruption; reconciliation does not mean uploading a new proposal. A downloaded source tree alone is not the complete retained work record.

## Account metadata

Use Account → Your data, signed in on the web, to read the current inventory and export metadata (device and agent credentials are refused there). Check the stated contents: metadata does not include source bytes, secret values or credentials. Read [security](../security.md) and [current status](../status.md) for the delivered account-data scope.

Export does not require deleting a project or account. If you choose a removal action separately, read exactly what its current control says it removes and keeps.
