The journal packer runs in the V8 runtime and continues in Node only for a page
over 1 MiB of captured text. Live journal wakes coalesce into one pending drain
per project, aligned to the hour; an idle project has nothing scheduled. Closed
Lanes keep one save-page drain each. See
[journal packer on the S1 pattern](../../operations/cost-to-serve.md#journal-packer-on-the-s1-pattern).
