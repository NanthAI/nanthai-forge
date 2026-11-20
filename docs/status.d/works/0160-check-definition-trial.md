- A Lane that changes Forge's own check definition (check entry and inputs, selection
  inputs, check contract, Actions workflow) is checked by main's full check plus one trial
  of its own definition beside it, so tests its new definition enables run before it lands.
  The trial only adds failures; main's check still judges the Lane
  ([definition trial](../../operations/github-actions-checks.md#definition-trial)).
