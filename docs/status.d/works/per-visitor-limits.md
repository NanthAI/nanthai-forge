Signed-out code reads and device sign-in have a per-visitor limit (60 uncached reads an hour; 10 sign-ins a minute and
30 an hour), keyed by a hash of the network address that only the site can compute, before the project and
deployment budgets. One noisy client is refused while others are served. See
[per-visitor limits](../../security.d/sections/0810-per-visitor-limits.md).
