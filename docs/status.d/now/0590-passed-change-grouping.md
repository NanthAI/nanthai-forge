With pre-queue Lane checks, only changes whose own check passed share a cohort check; an unadmitted change
checks alone. A refused change waits for its cohort only while no check slot is free (a peer still deciding
its own Lane run fills one), at most five minutes, and a main-race recheck that starts then runs full
instead of scoped. See [passed-change grouping](../../pre-queue-checks.md#decision).
