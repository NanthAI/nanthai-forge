# Recover an existing project

This is the lead's off-machine drill runbook. Fixture tests support the commands;
they are not evidence of a recovery on another machine. Record measured results
in the drill's private report. Under server authority the recovered machine
becomes a runner and cache; native-owner projects retain owner recovery and local acceptance. The old Mac
retains its original directory and edits for reconciliation.
No lease, account transfer, new project or new access condition is involved.

## Inputs on the replacement machine

Use only off-machine inputs: a compatible Forge package and lockfile, this
runbook, the saved project ID/deployment URL, expected source/Work/evidence pins,
and the existing account's sign-in and separately backed-up runner references,
application/auth/environment configuration and Secret Object keyring. Never copy
credential values into request JSON or the report. Local bindings and parent
finish-driver retry files are not part of the portable backup. Recovery restores
saved data; it does not resume the old parent command or any check process.

Use Node 24.22.1+ (24.x) and a fresh cache destination with an existing parent
directory. `NEW_CACHE` is the recovered directory, `DEPLOYMENT_URL` the surviving or
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
A local portable archive can still be restored independently with
`nforge restore-native ARCHIVE.tar.gz INDEPENDENT_COPY`. It is a backup copy,
not server Route B and not authority to accept for a server-authority project.
Native-owner projects can also use `nforge recover NEW_OWNER` and explicit
`recover OWNER reconnect`; native-owner rollback preserves those paths. Returning
from server to owner authority requires the explicit higher-epoch rollback in operations.

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
run the guided recover command. Native-owner mode retains full owner recovery;
server mode follows Route B below. This recovers the ZIP's captured project, not newer
work that never reached that weekly snapshot. No index backfill is part of recovery.

## Route B: surviving hosted copy

Follow [Route B in operations](../operations.md#route-b-recover-a-runner-and-cache-from-hosted).
Use the replacement machine's compatible package, existing account, deployment
URL and project ID. This Route B applies to server authority or a pending local
switch to server. The recovered machine is a runner/cache and cannot become an
accepting native owner. A bound native-owner project, including rollback to
native-owner, instead retains full native recovery and local acceptance. The original Mac's files and unsent edits remain
available for reconciliation through hosted saves; starting an owner listener
or reconnecting an archive does not grant local acceptance under server authority.

Use the returned main head/receipt, authority epoch and hosted recovery counts to
compare the off-machine inventory. Stream immutable recovery rows to compare
exact acceptance receipts, queue outcomes, pending completion progress and stale
source-return receipts. Unknown history coverage stays unknown. Select and open
saved Lanes through hosted commands. Reconfigure credential references through
the existing runner setup, then deliberately run one harmless hosted Candidate
check with the registered worker. Observe the exact hosted run result. A passed
check does not locally accept a Candidate.

For a credential-free scripted drill, run `node tests/recovery-runner-drill.mjs`
after building core. It uses fake hosted tables and synthetic signing material;
no deployment, login, real repository or external account is involved. The check
itself runs a harmless Node command from verified recovered source. Report its
per-step timings separately from any actual off-machine RTO/RPO evidence.

## Interrupted recovery and report

Retry the same request and fresh destination. Private `.forge-recovery-…`
staging retains selected source/Work pins, table cursors and the original runner
registration UUID/configuration. Current access is rechecked on retries. A
changed request returns `WORK_OPERATION_CHANGED`; changed hosted pins during
capture return `WORK_STALE`. Original staged data remains available. An unrelated
destination is never replaced, and completed retries preserve new local edits.
No saved external command or unknown paid execution is automatically replayed.

Report Route A and Route B separately: compatible package, deployment backup
pins where relevant, selected main head/receipt, authority epoch, exact hosted
recovery rows/counts and omissions, runner identity and registration receipt,
current-auth checks, deliberate hosted check outcome and absence of local
acceptance authority. Time provisioning, provider import, application/auth
restoration, hosted selection, checkout, fold, registration, publication and
check separately. Live dropped landings and recovery-point age require actual
hosted evidence; local fixture timings do not establish either.

## Hosted machine lifecycle drill

Q4 exercises restart during acceptance, thirty minutes of client sleep and ten
minutes of client network loss under hosted source authority. Passing evidence
requires one original passing check, one acceptance receipt and no stranded
submission. Reconnect must observe the retained operation rather than submit a
replacement check. Cancellation and abandonment must retain saved source and
remain terminal after late check completion.

After `npm run build:core`, run the automated drill:

```sh
node --import ./tests/check-runtime.mjs --test --test-concurrency=2 \
  tests/hosted-machine-lifecycle.test.mjs \
  tests/phase5-hosted-lifecycle-script.test.mjs
```

The tests use production hosted queue, check, source-save, lifecycle, acceptance
and recovery handlers with synthetic provider/storage IO. Virtual time models
client disconnection while hosted execution continues. A separate injected
acceptance-driver crash exercises durable repair. The scale case has 2,538 source
files, 32,000 unrelated objects and twice the dogfood acceptance history. It
reports function transactions, document reads/writes, peak process RSS and wall
time, with executable budgets. Harness RSS includes its snapshot transaction fake;
it does not measure Convex memory. The clean recovery case uses the actual hosted
receipt from the existing cutover drill and verifies no native acceptance owner.
The scale fixture runs in an isolated process with a 384 MiB JavaScript heap;
its unchanged 1 GiB RSS budget includes native snapshot-copy allocations. The
transaction fake clones its baseline once and shares immutable rows with its
local map, while reads and writes retain their independent copies.

For the dev deployment, the live script defaults to one read-only authenticated
listing and prints its call estimate:

```sh
node scripts/phase5-hosted-lifecycle-drill.mjs
```

The live form creates a new private project from a one-file synthetic native
fixture, seeds accepted main, switches that project to hosted authority, starts
and saves a Lane, then opens the saved bytes from a fresh root after renaming
the first root out of reach. It configures one harmless check and an independent
self-hosted collector, submits a durable finish, observes acceptance, clones main,
cancels and abandons disposable work, and recovers a runner/cache from hosted.
Only the scratch fixture permits automatic agent acceptance; the full check gate
and existing protected paths remain selected. No repository mirror or paid
provider is configured.

```sh
node scripts/phase5-hosted-lifecycle-drill.mjs --live .forge/q4-live-UNIQUE
```

Use the existing CLI sign-in and existing fixed collector credential supported
by `nforge worker`. The script never reads deployment environment listings or
generates collector secrets. Missing configuration is a failed live step, not
synthetic success. The live script accepts no existing project ID and rejects the
dogfood project before IO. It attempts ordinary `host --delete-project` cleanup
on success or failure, retaining the project ID and cleanup result in its private
`report.json`. A failed deletion leaves the scratch project listed for follow-up.
Keep operation journals and reports after unknown replies; do not replay creation
in another root to reconcile the original project.

The estimate is 400 client calls plus an allowance of 1,000 internal function
calls, below the brief's 2,000-call stop threshold. Client calls are counted and
stopped with the internal allowance still reserved. Server actions, scheduler
invocations and billing totals are not exposed by the client and remain unknown
in the report. This is an estimate and an observed client count, not a measured
Convex bill. The drill operates on selected records and bounded pages; it never
downloads dogfood Work or scans the account's complete project list in preflight.
Normal deletion uses the CLI's existing paged project lookup.

The live root transition runs on one physical machine. It does not establish a
real thirty-minute sleep, ten-minute Wi-Fi outage, off-machine recovery time,
production reuse rate or operator-intervention rate. Record those separately in
the private handoff, along with every passed/failed step, remaining scratch
project, exact receipt and observed call coverage. Q4 moves metrics 5.5 and 5.6;
metric 5.3 (dropped landings) must remain zero. Automated zero reruns and zero
stranded entries are qualification evidence, not a production before/after rate.
