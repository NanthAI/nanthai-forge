### Sealed import from .env

`nforge secret import [FILE] [--keep]` moves a dotenv file into the Development set
(`src/secret-import.ts`, `src/secret-dotenv.ts`). FILE defaults to the root `.env`. It is
opened once without following a link; its type and size are checked on that handle,
and the read stops past 1 MiB even if the file grows meanwhile.

Parsing follows dotenv: `NAME=value` and `export NAME=value`; single quotes and
backticks are literal, double quotes turn `\n` and `\r` into line breaks, and any
quote may span lines. An unquoted value ends at `#` and is trimmed. Nothing is
expanded, so `${OTHER}` is stored as written. A repeated name keeps its last value.
A line whose bytes are not valid UTF-8 is not imported, since decoding it would
change its bytes. Names pass the same release name rules as `set`: an invalid or
denied name is not imported, and an agent cannot import a routing name. Notices name
a valid variable or a line number, never a value or any text of a malformed line, an
invalid name included. Parsing is linear in the file, at most 1 MiB.

Writing. Values go into Development in signed head writes of at most 90 names, one
read and one write each (the server's work cap is 100 units; a first write takes at
most 98 names, since its roster entry counts 2). For a person, a value already
stored with the same bytes and kind is left as it is, so running the import again
after an unknown outcome finishes it without a second copy. An agent adds new names
directly; every name that exists or existed in Development becomes a proposal, one
per name, with no comparison to the stored value, so the output, the outcome and
whether the file is removed never depend on whether the agent's value matches
([proposals](#sealed-proposals)). If those proposals would pass the server's waiting
limits (8 per device, 32 per set), the import stops before it proposes or writes
anything and names the limits. The release publish-token notice applies as for
`set`.

Unknown outcomes. A lost reply leaves the import write's request in the local
journal, and the error names its operation id and `nforge secret resolve
--operation-id ID`. The next import of those names settles it: a write whose records
the current head holds is confirmed, and one whose names this import has now stored
is cleared, since a later write replaced it and its request is never sent again.
Either way it no longer counts toward the journal's 64 entries.

The example. Every imported, unchanged or proposed name that the root `.env.example`
does not list is appended as `NAME=`, in one atomic replace; nothing else in the
file changes and no value is written. A case-variant spelling of the file is refused
instead of being overwritten on a case-insensitive disk.

Removing the plaintext (owner decision 4). After a full import the file is deleted,
but only if it still holds the exact bytes that were imported: it is first moved
aside in one rename and checked there, so the file checked is the file deleted. A
different regular file is put back where it was, never over one that appeared since;
anything else stays aside and the output names where. It is kept with the
reason when `--keep` is given, when any line or name was not imported, or when
proposals wait for a person. The output prints the undo:
`nforge secret import --restore [FILE]`, which only a person on a terminal can run.
It writes a new private file (`0600`; it refuses one that exists or a link in its
place) with the Development env values that `.env.example` lists, in its order,
quoted so dotenv reads back the same bytes: single quotes, then backticks, then
double quotes with `\r` and `\n` escaped (always for a value with a carriage return,
which is never written raw). File values are never written, and a value no form can
hold (a carriage return or both other quotes, with `"` or a backslash) is named and
left out.

Limits, stated: deletion removes the directory entry and does not overwrite the
disk blocks. Values already shared, committed or saved elsewhere still need rotating
at their provider. A partial import (an error after some writes) keeps the file;
running it again completes it.

Cost: one read for each batch, one write per 90 changed names, and for an agent one
proposal listing per batch with proposals (plus one read first when it spans
several batches) and one call per proposal; one more read only when an earlier
import's write is retained as unknown. No Convex call before the file is read and
parsed; idle 0.
