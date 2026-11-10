# State trees: dual-write and the reader flag

A finite TLA+ abstraction of [trees in packs](../../docs/architecture.md#storage): the flat State
manifest is the authority, dual-write records a tree pointer only after the segment bytes it wrote
reproduce the flat manifest and the store confirmed it holds exactly those bytes, and a reader
behind `stateTrees.read` may answer from the tree. It is not a refinement proof of the
TypeScript. Saves, the two project flags, segment loss and corruption interleave freely.

Checked properties:

- `ReadersAgree`: every answer a reader gives, from the tree or from the flat manifest, is the flat
  manifest of that State. A pointer whose stored bytes no longer verify falls back to flat.
- `PointerProven`: a recorded pointer names the content of its State's flat manifest.
- `FlatStable`: dual-write never changes a saved flat manifest.

| Configuration | Expected |
| --- | --- |
| `StateTrees.cfg` | no error (2 States, 2 contents) |
| `nogate.cfg` | `PointerProven` violated: a pointer recorded without the gate |
| `noverify.cfg` | `ReadersAgree` violated: a reader that does not check stored bytes |

The gate checks the bytes the writer put, while the PUT is in flight, not a read-back: the store
confirms a write by the SHA-256 checksum of what it stored (R2 does for every create-only PUT), so
those bytes are what the segment's digest stands for. An earlier gate compared read-back content
with the flat manifest and failed `PointerProven` here: a segment written wrong and then altered
to the right content passed. Checking the content the digest stands for has no such gap; a segment
lost or altered later is refused by every reader (`Verify`).

Run with the checksum-pinned `tla2tools.jar` that `models/landing-queue/run.mjs` caches:

```sh
java -cp tla2tools.jar tlc2.TLC -workers 1 -config StateTrees.cfg StateTrees.tla
```
