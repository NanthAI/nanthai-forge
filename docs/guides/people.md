# Your first project

Start with a small change whose result you can recognise.

## Get the CLI and sign in

Use the [source installation steps](../quickstart.md#install-the-development-cli). Forge has not published an installable package or a public production login service. Use the deployment address supplied for your development project.

```sh
nforge login DEPLOYMENT_URL
nforge auth status DEPLOYMENT_URL
```

The terminal prints a browser link and code. Open that link, check the account and approve that terminal. Return to the terminal for the completed sign-in. An expired code names the command to request another.

## Bring your code

Follow [quickstart](../quickstart.md) to import a repository or host a folder. Import keeps the selected source revision and its history. Wait until the receipt says main is ready, then run the clone command it prints. Keep a [mirror](export.md) if you want a second copy of accepted main.

## Give the change to an agent

Open the project plan, add an Item with the outcome and the evidence that would show it is done, and give the agent the Item and the hosted clone path. The agent uses [this flow](agents.md). A Lane is its isolated copy of the project for that change.

Read the saved files in the Lane before deciding. [Review and land](review.md) explains check evidence, held work and failures. A passed check alone does not mean the change has landed; look for the accepted receipt and main's State.

## Where to go next

Use [Plan](plan.md) to order work and [oversight](oversight.md) to find what needs you. If setup stops, retain its operation id and follow the receipt's next command rather than starting a second import. The [quickstart](../quickstart.md) includes recovery paths and the current deployment prerequisites.
