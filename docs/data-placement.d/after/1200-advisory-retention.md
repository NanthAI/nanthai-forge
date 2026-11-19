## Advisory retention

Client errors expire strictly after 30 days from creation, in pages of at most
eight rows in existing scheduled check-expiry transactions. There is no new cron,
idle call or diagnostics-only continuation; a backlog drains on later maintenance.
The receipt includes deleted row and logical byte totals and reconciles retries.
At two check-expiry phases per landing, the added budget per 1,000 landings is
zero function calls, at most 2,000 indexed page reads and 16,000 deletes; at the
observed one error/week it is approximately one delete/week. Billed I/O and wall
time remain unmeasured; memory is bounded to eight documents (8 MiB schema ceiling).
No R2 bytes are involved in diagnostic deletion.

Owner-selected coordination detail retention is 14 days hot then R2 archival by
S2 (27d4c1fd), with nothing deleted. Messages, handoffs, acknowledgements and agent
lifecycle audit stay indefinitely; agent access diagnostics have no window until
volume warrants one. See [decisions](../../decisions.md#advisory-windows).


CI supervisors negotiating `results.packed` retain one combined result/log object
per shard in R2's run/fence/execution inbox namespace. Output chunk metadata keeps
the original logical log pin and a verified physical envelope pin; the same
current-access download and output cleanup paths resolve that physical key.
Required supervisors discover other required slots with one finite HEAD pass and
elect a collector through a create-only marker. One completion notification collects
bounded metadata pages before optional pack/proof jobs finish; signed workflow
completion remains recovery. Packed mode removes LISTs and duplicate log PUTs. The legacy batch path remains for
older supervisors. See [the CI request guard](../../operations/github-actions-checks.md#ci-byte-guard-and-serving-estimate).
