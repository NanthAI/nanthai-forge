# State trees: dual-write and the reader flag

A finite TLA+ abstraction of [trees in packs](../../docs/architecture.md#storage): the flat State
manifest is the authority, dual-write records a tree pointer only after a read-back check, and a
reader behind `stateTrees.read` may answer from the tree. It is not a refinement proof of the
TypeScript. Saves, the two project flags, segment loss and corruption interleave freely.

Checked properties:

- `ReadersAgree`: every answer a reader gives, from the tree or from the flat manifest, is the flat
  manifest of that State. A pointer whose stored bytes no longer verify falls back to flat.
- `PointerProven`: a recorded pointer names the content of its State's flat manifest.
- `FlatStable`: dual-write never changes a saved flat manifest.

| Configuration | Expected |
| --- | --- |
| `StateTrees.cfg` | no error (2 States, 2 contents) |
| `nogate.cfg` | `PointerProven` violated: a pointer recorded without the read-back check |
| `noverify.cfg` | `ReadersAgree` violated: a reader that does not check stored bytes |

The first run of this model also failed `PointerProven` with a gate that only compared the
read-back content with the flat manifest: a segment written wrong and then altered to the right
content passed. The gate must check the stored bytes against their digest as well, which
`TreeSession.finish` (`verifySegment`) and the strict reader in `verifyStateTreeSave` do.

Run with the checksum-pinned `tla2tools.jar` that `models/landing-queue/run.mjs` caches:

```sh
java -cp tla2tools.jar tlc2.TLC -workers 1 -config StateTrees.cfg StateTrees.tla
```
