### Run process boundary

`nforge run [--root ROOT] [--set development|checks] [--only A,B] [--show] -- COMMAND [ARGS...]`
resolves the containing clone or Lane root. The CLI reference is generated from
its help at site build time. There is no plaintext stub-input flag or alternate
secret store. Development uses the same verification entry point for network and
cached records. Checks delivery remains outside this slice.

The process boundary enforces these rules:

- Only names in the root `.env.example` can be injected; `--only` can narrow them.
  The file must be a regular file with exactly that spelling. A symbolic link or
  directory fails with `SECRETS_ENV_EXAMPLE_NOT_FILE` before reading the provider
  or starting a child. A case-only spelling such as `.ENV.example` is reported by
  name and contributes no names. It accepts `NAME`, `NAME=value`, `export NAME=value`, blank lines and
  comments, including inline comments. Example values are ignored; duplicate
  names are used once. Refusals and missing-value/not-yet-listed notices name the
  variable and never its value. A missing file supplies no names.
- Names match `[A-Z][A-Z0-9_]{0,63}`. Release-owned deny, routing and credential
  exception lists live in `src/secret-names.ts`; they are not complete. The order
  is exact deny, exact exception, exact routing, the single Cargo token exception
  pattern, deny patterns, routing patterns, then plain names. Thus
  `CARGO_REGISTRIES_X_TOKEN` passes while its `_INDEX` and `_CREDENTIAL_PROVIDER`
  neighbours do not; `NPM_CONFIG_PROXY` is denied, and `PIP_INDEX_URL` and
  `NODE_EXTRA_CA_CERTS` are routing. Routing writes require a person in the
  shared name validator. Its value-free write boundary prints one line for each
  exempt publish-token name written to Development: it is a publish token and
  belongs in Checks. `NODE_ENV`, ordinary names and writes to Checks produce no
  such notice; using a token through `run` produces none. Set uses this boundary; import and proposal apply remain pending.
- The inherited environment wins, including case-insensitive comparison on
  Windows. Before injection the child loses Forge credentials and session
  material: every `FORGE_*` and `NFORGE_*` name and known agent session id, except
  `FORGE_GIT_TIMEOUT_MS`, `FORGE_CHECK_FULL`, `FORGE_CHECK_SCOPED`,
  `FORGE_MAX_CONCURRENT_CHECKS`, `FORGE_CHECK_QUEUE_DIR`, `FORGE_DISK_WARN_GB` and
  `FORGE_DISK_BLOCK_GB`. These are runtime controls, not credentials.
- Checks machine delivery requires `--only` or a supervisor declaration. This
  limits what is handed over. A same-user child can still read its parent's
  startup environment; this process boundary is not OS isolation.
- Piped stdout and stderr mask injected values of at least eight characters as
  `[secret:NAME]`: raw, URL-encoded, JSON-escaped, hex, base64 and base64url at all
  three alignments. A value under eight characters is masked raw where it stands
  as its own word (no letter, digit or underscore touching it); its encoded forms
  pass. Multiline values are masked whole and line by line (lines shorter than
  eight characters pass). Each stream keeps at most the longest encoded form
  minus one byte across chunks, plus one byte for a short value's right edge. An
  agent marker, agent entry point or MCP keeps masking enabled even with a
  terminal, and a Checks machine run always masks. A person can use `--show` on
  Development; an agent cannot, and nobody can on Checks. Masking stops
  accidents, can test a guess, and cannot prevent code deliberately disclosing a
  value.
- File values use a private folder outside the tree and declared kept-output
  paths, under `/dev/shm` on Linux or the private temporary area elsewhere.
  Folders are `0700`, files `0600`. Normal exit, startup failure and handled
  signals remove the folder; the next run also sweeps folders whose owner
  process is gone, including after SIGKILL. Live or unknown owners are retained.
  No value file is written into source, caches or archives. Buffers supplied by
  the provider are cleared after delivery.

New policy presets and projects without a stored policy protect root
`.env.example` by default, through the existing protected-path approval rules.
The match includes case variants; other protected globs retain their existing
case sensitivity. An owner's explicit `acceptance.protectedPaths` list wins and
can opt out. No existing stored policy is rewritten. Per-added-name owner alerts
are still part of the later import/landing slice, including when approval is off.

These helpers add no hosted calls, database I/O, retained records or idle work.
Masking memory scales with value encodings and one carry per stream; file bytes
are temporary only. The scriptable test backend records synthetic replies and
conditional writes. The hostile-server harness exercises the real verifier with signed synthetic
fixtures; this does not replace Gate B. The per-added-name owner-alert acceptance case is separately deferred
to slice 3, including alerts when protected-path approval is off.
