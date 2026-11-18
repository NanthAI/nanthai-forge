Hosted Lane opens admit FIFO workers across I/O phases without a global phase gate.
Opens below both the 4,096-file and 16 MiB logical-byte boundaries
reuse workers across phases after cache verification, retaining the editing
write-pass lease and
the shared per-volume worker ceiling, digest checks, independent inodes and
publication barriers. Cancelled or missing materialization tickets fail explicitly
instead of waiting indefinitely. Synthetic open qualification is local-only; it
does not establish a universal latency gain on other filesystems or under load.
