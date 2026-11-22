Covered self-metrics windows use immutable lookup keys for requests, attempts,
compact runs and compose members. A tenfold increase in unrelated history left
the report at 79 document reads, 19,170 serialized bytes and 12 calls at both
scales in the d824900c fixture. Full reports and bill inputs matched canonical
reads, and reporting wrote zero rows. See [metrics operations](../../operations.md#project-health-report).
