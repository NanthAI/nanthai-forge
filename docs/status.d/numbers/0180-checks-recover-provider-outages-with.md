Checks recover provider outages with finite reads: an accepted but unacknowledged
dispatch gets one lookup at +5 minutes, and a held pass gets its existing early
reads plus at most three more at +1/+2/+4 hours. At +30 minutes, all signed shard
passes and a complete provider job list with every step completed without failure
can settle a pass despite lagging run status. Status and land wait retain the
provider-delay reason. See [provider outage recovery](../../pre-queue-checks.md#provider-outage-recovery);
live replay and billed usage remain unverified.
