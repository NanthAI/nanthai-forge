# Recover an existing project

This is the lead's off-machine drill runbook. Fixture tests support the commands;
they are not evidence of a recovery on another machine. Record measured results
in the drill's private report. The recovered machine becomes owner. The old Mac
returns as a source client, retaining its old owner directory for reconciliation.
No lease, account transfer, new project or new access condition is involved.

## Inputs on the replacement machine

Use only off-machine inputs: a compatible Forge package and lockfile, this
runbook, the saved project ID/deployment URL, expected source/Work/evidence pins,
and the existing account's sign-in and separately backed-up runner references,
application/auth/environment configuration and Secret Object keyring. Never copy
credential values into request JSON or the report. Local bindings and parent
finish-driver retry files are not part of the portable backup. Recovery restores
saved data; it does not resume the old parent command or any check process.

Use Node 24.22.1+ (24.x) and a fresh owner destination with an existing parent
directory. `OWNER` is the recovered directory, `DEPLOYMENT_URL` the surviving or
restored Forge backend, `PROJECT_ID` the existing project, and `SOURCE` the matching
Forge source/package directory. Keep the source deployment and original owner.

For the drill fixture, include accepted main, an unlanded saved Lane, a later
hosted note, a finished synthetic check with a retained artifact, one missing
evidence file, and a running synthetic check with captured output. Capture and
copy off-machine all main receipt IDs, Lane base/head/checkpoint IDs, file hashes,
artifact hashes, run IDs/statuses and the later note's text/operation ID. Missing
evidence is an expected coverage omission, not a failed source recovery.

These commands prepare a disposable local fixture without running its recorded
checks. `FIXTURE_PARENT` is a private scratch directory. They do not modify the
real owner. Host this fixture only in the lead's selected drill project.

```sh
cd "$SOURCE"
export FIXTURE_PARENT
node --input-type=module <<'JS'
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { recoveryFixture } from './tests/recovery-fixture.mjs';
const f = await recoveryFixture({after() {}}, true);
mkdirSync(process.env.FIXTURE_PARENT, {recursive:true});
writeFileSync(join(process.env.FIXTURE_PARENT, 'fixture.json'), JSON.stringify({
  original: f.root, main: f.main, laneId: f.lane.id, laneHead: f.saved.head,
  intentId: f.secondIntent.id, runs: f.runIds,
  files: f.manifest.files, unavailable: f.manifest.unavailable,
}, null, 2));
copyFileSync(f.exported.archive.path, join(process.env.FIXTURE_PARENT, 'native-owner.tar.gz'));
console.log(JSON.stringify({original:f.root, fixture:join(process.env.FIXTURE_PARENT,'fixture.json')}));
JS
```

The generated run histories are synthetic fixtures, not evidence that those
commands ran. Set `ORIGINAL_OWNER` and `INTENT_ID` from `fixture.json`. In the
lead's selected disposable hosted environment, create its hosted project once
and save the returned project ID and binding separately:

```sh
nforge login "$DEPLOYMENT_URL"
nforge host "$ORIGINAL_OWNER" --deployment "$DEPLOYMENT_URL" --wait
nforge host "$ORIGINAL_OWNER" --status
nforge hosted-work "$DEPLOYMENT_URL" "$PROJECT_ID" '{"action":"workspace"}'
```

Record that workspace's current revision as `HOSTED_REVISION`. Add the later
hosted note without pushing another local checkpoint. Retain `NOTE_OPERATION_ID`:

```sh
export INTENT_ID NOTE_OPERATION_ID HOSTED_REVISION
node --input-type=module <<'JS' > "$FIXTURE_PARENT/later-note.json"
console.log(JSON.stringify({action:'command', operationId:process.env.NOTE_OPERATION_ID,
  revision:Number(process.env.HOSTED_REVISION),
  command:{action:'note',intentId:process.env.INTENT_ID,kind:'comment',text:'Later hosted drill note'}}));
JS
export DEPLOYMENT_URL PROJECT_ID
node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {makeFunctionReference} from 'convex/server';
import {coordinationClient} from './dist/coordination-client.js';
const request = JSON.parse(readFileSync(join(process.env.FIXTURE_PARENT,'later-note.json'),'utf8'));
const client = coordinationClient(process.env.DEPLOYMENT_URL);
console.log(JSON.stringify(await client.action(makeFunctionReference('projectWorkActions:command'), {
  projectId:process.env.PROJECT_ID,operationId:request.operationId,revision:request.revision,
  command:JSON.stringify(request.command),
})));
JS
```

Copy the native archive and `fixture.json` off-machine. The native archive route
below uses its matching hosted archive checkpoint; newly hosted projects use
objects, so use the surviving-hosted route for this newly seeded object project.
A local portable archive can also be restored independently with
`nforge restore-native ARCHIVE.tar.gz OWNER`, then explicitly connected with
`nforge recover OWNER reconnect --command-file REQUEST.json`. Preserve the
archive's older coverage and reconcile through the existing bound exchange
before publishing later local work; reconnect alone never publishes source.

## Route A: weekly deployment backup archive

The R4 weekly backup is a file-inclusive **Convex ZIP**, not a native project tar
archive. Download the retained ZIP and manifest using the existing operator R2
tooling. Verify the complete size/SHA-256 against that manifest. R2-hosted source
objects referenced by exported rows still require their separately surviving
bucket/configuration; a Convex storage export does not duplicate external R2
object bytes. Test that dependency during this drill.

Follow [hosted durability](hosted-durability.md#restore-into-a-fresh-deployment):
provision a fresh empty deployment, import before deploying matching code/schema,
then restore application, auth, environment and keyring configuration. Keep the
original ZIP. Use target credentials through the existing private environment.

```sh
npx convex import --deployment "$FRESH_TARGET_NAME" "$BACKUP_ZIP"
# Restore the matching saved application/auth/environment using the established
# deployment procedure, then compare the saved ZIP with the restored deployment.
node scripts/hosted-durability.mjs verify \
  --left-export "$BACKUP_ZIP" --right-deployment "$FRESH_TARGET_NAME"
```

With a concrete deployment key, use the selector rules in hosted durability
(the provider derives its deployment from that key). An interrupted provider
import has no Forge operation receipt: inspect the target/import status before
retrying. Do not infer application health from equal table/file hashes.

Sign in to the restored app. Open the same existing project, accepted main,
Intent/Lane/Candidate detail and retained evidence; exercise current access under
the recovered auth configuration. Confirm encrypted Secret Objects can be used
through their existing capabilities without exposing values. Set
`DEPLOYMENT_URL` to this restored backend, retain its imported `PROJECT_ID`, then
run Route B's guided command. This recovers the ZIP's captured project, not newer
work that never reached that weekly snapshot. No index backfill is part of recovery.

## Route B: surviving hosted copy

No old local binding is needed. Sign in with the existing project owner account.
Generate `RECOVERY_OPERATION_ID` once, retain it across every retry, and write a
credential-free request on the replacement machine:

```sh
nforge login "$DEPLOYMENT_URL"
export RECOVERY_OPERATION_ID DEPLOYMENT_URL PROJECT_ID
node --input-type=module <<'JS' > recovery.json
console.log(JSON.stringify({operationId:process.env.RECOVERY_OPERATION_ID,
  url:process.env.DEPLOYMENT_URL,projectId:process.env.PROJECT_ID}));
JS
nforge recover "$OWNER" --command-file recovery.json > recovery-result.json
nforge host "$OWNER" --status
```

The command obtains an authenticated checkpoint/journal pair, validates exact
source and evidence bytes, materializes every saved Lane, marks unfinished runs
interrupted, and explicitly reconnects this directory as the existing owner.
It never calls host/create, pushes, accepts source, starts checks or starts a
listener. The connection retains the existing project key and authority epoch.
`exchange pull` still opens selected main as a source client; it is not full-owner
recovery.

For a historical native archive checkpoint, add `archivePath` to `recovery.json`
pointing to that checkpoint's exact `.tar.gz`. The command fetches the matching
journal and checks both original archive and manifest hashes before overlay.
Without `archivePath`, an archive-backed hosted checkpoint downloads through its
existing authenticated range reader. Object-backed checkpoints download reusable
objects. `cacheRoot` optionally reuses verified local source; it never bypasses
fresh project authority or final source/Work CAS.

## Validate and run one deliberate check

Keep `recovery-result.json` private. Compare its `coverage.main` head/receipt,
every `coverage.lanes` base/head/checkpoint and included evidence size/SHA-256
against the off-machine fixture inventory. Read the saved Lane file and later
hosted note. Verify the retained artifact's exact bytes, the missing evidence in
`coverage.evidence.unavailable`, and the formerly running run's interrupted status.
`completeHistory:unknown` or `incomplete` remains visible and does not become a
claim of full saved-history coverage. Recovery capture age is unknown unless
supported by the separately retained capture receipt; connection time is not RPO.

Reconfigure executable/credential references for this machine using existing
check settings. Deliberately run a harmless synthetic check on a restored
Candidate and observe its exact run. A saved Lane without a clean Candidate
returns `NOT_FOUND`, so use the `viewId` of a restored run from `status`. This
starts a new check; it does not resume the restored one. No acceptance is needed:

```sh
export NODE_EXECUTABLE VIEW_ID
node --input-type=module <<'JS' > drill-check.json
console.log(JSON.stringify({name:'recovery-drill',executable:process.env.NODE_EXECUTABLE,
  args:['-e','console.log("recovery drill passed")'],environmentLabel:'Recovered machine'}));
JS
nforge agent "$OWNER" define-check --command-file drill-check.json
export DRILL_CHECK_ID
node --input-type=module <<'JS' > drill-run.json
console.log(JSON.stringify({viewId:process.env.VIEW_ID,checkId:process.env.DRILL_CHECK_ID}));
JS
nforge agent "$OWNER" run --command-file drill-run.json
# If pending, retain its operationId and observe it; do not start another run.
nforge agent "$OWNER" observe '{"operationId":"ORIGINAL_RUN_OPERATION_ID","waitMs":1000}'
nforge host "$OWNER" --listen
```

Take `DRILL_CHECK_ID` from define-check's result. Inspect check outcome and logs;
do not infer pass from queue admission. Stop the foreground listener with Ctrl+C
after exercising one owner request through the restored app.

## Original Mac returns

On the old Mac, stop its foreground owner listener and retain its entire owner
directory, including unpushed saved work and unsaved edits. Generate a **new**
operation UUID in a request for the same deployment/project, then run:

```sh
nforge recover "$OLD_OWNER" client --command-file return-as-client.json
nforge exchange "$OLD_OWNER" pull --target "$NEW_CLIENT_DIRECTORY"
nforge host "$OLD_OWNER" --status
```

The first command changes only this local binding's role to independent copy;
saved source and Work remain. The second opens selected main as an actual source
client in a fresh directory. The recovered machine remains owner. To undo the
local role selection, use `recover OLD_OWNER reconnect` with a new operation.
Neither action rotates project identity or fences another directory. If both
machines keep working as owners, existing source-return/checkpoint/Work/Channel
CAS and reconciliation still apply; stale source must merge or surface a conflict.
Never replace accepted work with the old directory or use `host --new` as recovery.

## Interrupted recovery and report

Retry the same request and destination. Private `.forge-recovery-…` staging
retains original pins, the matching journal and the reconnect request. Completed
reconnect receipts reconcile even if hosted Work later advances; current owner
authority is checked again before returning a cached result. A changed request
fails `WORK_OPERATION_CHANGED`; changed source/Work/authority before reconnect
fails `WORK_STALE`. Corrupt/missing content or an interrupted download never
publishes a partial owner. Existing unrelated destinations are preserved.
Completed retries do not overwrite new edits in the recovered owner.

If pins advanced before reconnect, the prior stage remains an independent saved
copy. Use a new operation and fresh destination to recover the newer selection,
or deliberately reconnect the retained independent owner and use existing
reconciliation for later source changes. No restore auto-replays external work.

Report both routes separately: source package identity, snapshot/archive hashes,
checkpoint and journal pins, main receipt and all saved Lane pins, evidence
coverage and omissions, current-auth checks, deliberate check outcome, reconnect
receipt and old-Mac client result. Record start/end times separately for
provisioning, provider import, application/config/auth restoration, download,
validation, materialization, deliberate check and reconnect, plus peak disk.
The command's combined elapsed time is not a breakdown of those stages; measure
the individual phases externally where needed. State RPO from the last observed
successful off-machine capture, and end-to-end RTO from actual drill timestamps.
Do not substitute fixture timings or upload completion time for either measure.
