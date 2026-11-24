## Secrets for checks

Check definitions declare environment variable names in `env` and sensitive
names in `credentials`. On the Forge runner both select values already present in
the runner process; they do not read the Checks set yet. Missing variables there
remain absent. Definition digests and receipts carry names, never values. See
[clean check environments](#clean-check-environments).

### The Checks set and machine keys

Checks is each project's second sealed set. Its holders are full owner devices
and CI machines only; a member device is never a Checks recipient. The owner
device creates Checks on its first `nforge secret set NAME --set checks` or
`nforge secret machine add LABEL --set checks`. Before the Checks genesis it
writes a signed Development roster step whose Checks pointer names the new set id
and genesis hash, and every owner-device Checks read is verified against that
pointer. Only a person on a terminal, on a confirmed full owner device, changes
Checks or adds a machine; an agent gets `PERSON_REQUIRED`.

`nforge secret machine add LABEL --set checks` makes a new X25519 key on the
owner device, derived one way from that device's own private key and the
command's operation id. One owner-signed roster step adds the machine entry
(owner-added, no signing key, no account) with its wrap of the set key. The device
checks that the new key opens that wrap before anything is sent, then prints the
bundle, `FORGE_SECRETS_KEY`, once. The bundle holds the project and set ids, the
machine id and private key, the roster it was added in and the head floor. A
machine key never signs, wraps or approves.

The exact request, without any key, is journalled before it is sent. If the
outcome is unknown, the error names the operation id; repeating the command with
`--operation-id UUID` re-sends the same request and rebuilds the same key, so it
reconciles and shows the key if the add went through, and never adds a second
machine. Repeating a finished operation shows the same key again from the current
roster.

A machine has no Forge sign-in. It derives a 32-byte read token one way from its
private key and machine id; the server keeps only a hash of that token, in one
small row per machine entry (`sealedMachineReaders`, at most 100 per set, one per
roster entry). The hash is registered only by the project owner, on Checks, in the
same write whose step adds that machine; any other write that offers one is
refused with `SECRETS_NOT_ALLOWED` before any row changes, and a Checks step that
removes the machine deletes its row. `sealedMachines:read` checks the token
against that row before it reads anything else, so a caller without a valid token
costs one indexed read of at most one small row. With a matching token it returns
the active Checks ciphertext row and its history. Every miss gets the same
`AUTH_REQUIRED` refusal, so a caller learns nothing about which projects or
machines exist. The token opens nothing: values open only with the machine's
private key, through its wrap.

Treat `FORGE_SECRETS_KEY` as a CI secret: whoever holds it can read and open
every Checks value, current and future, until the machine is removed. Give it only
to a step you trust, and never to a step that runs untrusted code, such as a pull
request from a fork or a `pull_request_target` workflow.

### Running a check with Checks

`nforge run --set checks --only NAMES -- COMMAND` runs on any CI that gives the
step `FORGE_SECRETS_KEY`. Outside a Forge checkout the step also gives
`FORGE_DEPLOYMENT_URL` and `FORGE_PROJECT_ID`, which are addresses, not secrets.
Each run makes one machine query: the reader row, the project row, the active set
and its history, with no writes and nothing when idle.

The machine verifies from its bundle alone. The roster in the bundle is its pin:
the server's roster must chain from it, and a head that names an older roster, or
a head below the bundle's floor, is refused with `SECRETS_ROLLBACK`. A history
that no longer reaches the bundle's roster gets `SECRETS_PIN_TOO_OLD`, which tells
the owner to add a new machine key. A bundle for another project gets
`SECRETS_ROSTER_REFUSED`; a malformed or altered bundle gets
`SECRETS_FORMAT_REFUSED`.

A machine remembers nothing between runs except its bundle. A server could
therefore serve any genuine owner-signed head at or above the bundle's floor, and
a check would then get a value that has since been changed. It cannot forge a
head or a value. A new machine key's floor is the head at the time it is added,
so replacing a machine key raises the floor.

`--only` is required for Checks. The command's environment holds exactly the
declared names, and no `FORGE_*` variable. A declared name with no value in
Checks, and no value already in the step's own environment, fails setup before
the command runs: `SECRETS_NOT_SET_UP` with "Check setup failed before the
command ran; missing: NAME (no value in Checks)" or "(not listed in
.env.example)". The message names names only.

`--only` gives an honest command least privilege; it is not a security boundary.
The command runs as the same operating-system user as `nforge` and the CI step's
shell, and both hold `FORGE_SECRETS_KEY` in their environment, so a malicious
command can take the key and, with it, every Checks value. That is why the key
never goes to a step that runs untrusted code.

A machine run always masks: in a terminal too, because some CI runners give steps
a terminal. `--show` is refused for Checks. Each delivered value in standard
output and standard error is replaced with `[secret:NAME]`, including its
encoded forms. A value under eight characters is masked where it stands as its
own word, not touching a letter, digit or underscore. Masking matches exact
values; a command that encodes, splits or partly prints a value can still reveal
it.

### Not built yet

The Forge runner does not yet resolve `credentials` from Checks, and there are no
per-check `allow` bindings, public-log rule, CI-provider mask registration or
push of a machine key into a CI provider's secrets. There is no command that
removes a machine entry yet (`nforge secret machine rm` is the next step of this
slice): until it lands, a leaked `FORGE_SECRETS_KEY` cannot be revoked, because
new values use the same set key. Outside contributors get no Checks values.

### Settings and the older store

The rebuilt **Settings → Secrets** page is value-free and currently shows that
sealed secrets are not connected. Its metadata-only interface covers names in
Development and Checks, holders, waiting computers, rotation state and recent
changes. It makes no secret reads or writes. There is no value field, reveal
control or public sample-data route. Proposed CLI commands are marked Proposed.

Sealed Development and Checks sets are tracked by Item `41a0df87`. Passkey
recovery, import and Secret Object retirement remain unimplemented. Gate A
passed; Gate B is a separate code review after sharing. No
database-wide confidentiality claim applies while legacy Secret Objects and their
server keyring remain.
