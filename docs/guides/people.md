# Your first project

Start with a small change whose result you can recognise.

## Get the CLI and sign in

Follow the [first-landing checklist](../quickstart.md#first-landing) for installation, terminal approval and the first change.

## Bring your code

[Import a GitHub repository](../quickstart.md#import-from-github-in-the-app) or [host a local folder](../quickstart.md#host-a-local-folder). A GitHub import selects the committed snapshot for main and acquires Git history separately. When main is ready, follow the [clone steps](../quickstart.md#clone-the-project). Before the first checked landing, use an existing runner or have the project owner [configure a check and runner](../quickstart.md#configure-the-first-hosted-check).

## Give the change to an agent

For MCP, [connect your agent app](../agents.md#connect-over-mcp) from the hosted
clone and open a new agent session. An agent with a terminal can use the signed-in
CLI from the clone directly. Open the project Plan, add an Item with the outcome
and the evidence that would show it is done, and give the agent the Item and the
hosted clone path. The [agent guide](agents.md#land-it) explains how to start a
Lane, the agent's isolated copy for that change.

Read the saved files in the Lane before deciding. [Review and land](review.md) explains check evidence, held work and failures. A passed check alone does not mean the change has landed; look for the accepted receipt and main's State.

## Where to go next

Use [Plan](plan.md) to order work and [oversight](oversight.md) to find what needs you. If setup stops, retain its operation id and follow the receipt's next command rather than starting a second import. The [quickstart](../quickstart.md) includes setup and recovery steps.
