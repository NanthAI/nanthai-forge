# Set up sealed team secrets

Store values from a signed-in terminal in your Forge clone or Lane. Forge holds the sealed values. Your device opens the values it can use.

| Set | Who uses it | How it reaches a command |
| --- | --- | --- |
| Development | You and agents working on an approved device | `nforge run` in the clone or Lane |
| Checks | Your CI step on a registered machine key | `nforge run --set checks --only NAME` |

Use separate values when a provider offers development and test credentials. A Checks key opens only that project's Checks set.

## Find the settings

| What you need | Where to look |
| --- | --- |
| Approve terminal sign-in or edit device reach | **Account → Sign-in and devices** (`/account/devices`). Select the terminal you named at login. |
| Give a teammate project write access | Project **Settings → People and access** (`/<owner>/<project>/settings`) |
| Find secret names, holders, proposals and rotation | Project **Settings → Landing and checks → Open Secrets** (`/<owner>/<project>/settings/secrets`) |
| Set or change a value, share to CI or remove a holder | Terminal in your Forge clone or Lane. The web Secrets page shows metadata. |
| Store a CI machine key | Your CI provider's secret settings for the job that runs the check |

## Sign in and check the device

1. In a regular terminal, run `nforge login --name "My laptop"`. Open the printed link in the signed-in browser and approve the terminal.
2. For the device that sets up and manages the sets, use the project owner's account. In the approval or the device's settings, choose **Every project you can reach** and **May write and land with a check**. A device limited to one project or folder cannot manage the sealed sets. This device setting uses your existing project access.
3. Run `nforge auth status` and check the account. Run the remaining commands from the hosted clone or its Lane. Use the person's terminal for owner operations, outside the agent session.

## Set, run, change and remove Development values

In the repository's root `.env.example`, list the name with an empty value:

```dotenv
SERVICE_API_KEY=
```

Include that file's names-only change in the project source so other Lanes can use the same names. The real value goes into the hidden prompt. Replace `SERVICE_API_KEY` with the name your app uses.

```sh
nforge secret set SERVICE_API_KEY
nforge secret list
nforge run --only SERVICE_API_KEY -- node -e "process.exit(process.env.SERVICE_API_KEY ? 0 : 1)"
```

The example exits successfully when the process gets a nonempty value. Replace the check after `--` with your program. If Forge says the value arrives when its change lands, check that the current checkout's `.env.example` lists the exact name.

To change a value, run `nforge secret set SERVICE_API_KEY` again from your own terminal. To remove it, use `nforge secret rm SERVICE_API_KEY`. If the project already has a local dotenv file, `nforge secret import --keep` reads its Development values and updates `.env.example` with names. With no `--keep`, Forge removes the original after a full import. See [import and restore](../security.md#sealed-import-from-env).

## Give a check its own value and machine key

Start with a working Development set. On the project owner's holding device, run this in a regular terminal:

```sh
nforge secret set SERVICE_API_KEY --set checks
nforge secret machine add "Verification CI" --set checks
```

Enter the Checks value at the hidden prompt. Keep the machine ID from the add result. The key appears once in the terminal. Select and copy it from that terminal into your CI provider's masked secret field as `FORGE_SECRETS_KEY`. Avoid pasting the key into a shell command or an agent conversation.

Give the key only to the trusted check step. If that step runs from a Git mirror, set `FORGE_PROJECT_ID` to the project's ID. Install the Forge CLI on the runner and keep the selected names in the checkout's `.env.example`. Run your command through:

```sh
nforge run --set checks --only SERVICE_API_KEY -- node -e "process.exit(process.env.SERVICE_API_KEY ? 0 : 1)"
```

Replace the example Node command with your check. The Forge runner's `credentials` field selects values already in its environment. Use the explicit `nforge run` wrapper for a sealed Checks value. A machine key can open every value in its Checks set. Use a check step you trust, without code from untrusted forks. [Checks and machine keys](../security.md#the-checks-set-and-machine-keys) gives the delivery and masking details.

If a name from `.env.example` has no Checks value, machine add and the **Secrets** page's Checks row show the command to set it. CI also shows that command when a name the check declares has no value in Checks.

Change a Checks value with `nforge secret set SERVICE_API_KEY --set checks` on the owner's terminal. To revoke a machine, run `nforge secret machine rm MACHINE_ID --set checks` there and remove its key from the CI provider. Forge re-keys the set. For any names listed for rotation, issue new credentials at their providers and set those new values in Checks. To replace a machine, add a new entry and give its key to the replacement. See the current rotation list with `nforge secret list --set checks`.

## Review an agent's proposal

An agent can set a new Development name. When it changes or removes an existing name, Forge records a proposal. A piped value is also treated as agent input. For a direct change, enter the value at the hidden prompt on a person's terminal.

Read the proposal by name and device in the **Secrets** page or run `nforge secret proposals`. On a holding write device, a person runs `nforge secret apply PROPOSAL_ID` to take the proposed change, or `nforge secret reject PROPOSAL_ID` to turn it down. See [sealed proposals](../security.md#sealed-proposals) for conflicting and stale proposals.

## Add a teammate or unshare a device

For a teammate with project write access and no device in an Automatic Development set, have them run their command with `nforge run` from their approved device. If it reports `SECRETS_WAITING`, they give you the fingerprint it shows. Run `nforge secret list` from an owner device that holds Development. That read can share the set with the waiting device and records the fingerprint. Compare it with the one your teammate saw, then have them rerun their command. A device added this way can run with Development values. Confirming it for secret writes and adding a second device for the same account are still in development.

For an owner who needs to remove a holder, use `nforge secret unshare FINGERPRINT` on a holding owner device for an automatically added device, or give the full device ID. When a teammate loses write access or someone removes their own device in the web app, Forge can mark that holder for removal. Run `nforge secret unshare --marked` on a holding owner device to finish the Development removal. Forge re-keys and prints the names to rotate. Rotate the credentials at their providers, then set their replacements. See [sealed removal and rotate list](../security.md#sealed-removal-and-rotate-list).

If a write loses its reply, keep the operation ID. Follow the printed retry, or inspect a retained value write with `nforge secret resolve --operation-id UUID`. For the full command and flag list, run `nforge secret --help`.
