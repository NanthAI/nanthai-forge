- Queue health alarm: every landing is judged on the time from its first passed check to its
  commit (p90 of the last 20 landings, budget 20 min), inside the mutation that lands, with no
  new call. A break sends one message on the project's alert channels, opens one P0 Issue and
  names the lead rule: no new builders until it recovers
  ([speed budgets](../../agents/speed-budgets.md), [queue health alarm](../../agents/lead.md#queue-health-alarm)).
