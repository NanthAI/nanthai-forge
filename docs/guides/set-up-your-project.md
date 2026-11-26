# Set up your project

Start with a local folder or a GitHub repository. Forge keeps the accepted copy
of your files in **main**. Each change starts in a separate working folder
called a [Lane](#forge-words). The steps below show what you need and what you
can leave for later.

## 1. Sign in and approve a device

**Who can do this?** You approve in the browser. You or your agent can start terminal sign-in.

Sign in to your Forge site in a browser. If you do not have the `nforge`
command yet, [install it first](../quickstart.md#install-the-cli). Run this
in the terminal you or your agent will use.

```sh
nforge auth status
```

If it says signed out, start a device sign-in.

```sh
nforge login --name "My laptop" --no-browser
```

Open the link Forge prints, check the code and approve the device. Keep the
command running until it says you are signed in. Use **Account → Sign-in and
devices** to see the device and change what it can reach.

If you skip this, you can browse public projects in the browser. Terminal
commands that read or change a hosted project need a signed-in device.

## 2. Bring your files to Forge

**Who can do this?** You in the browser or terminal, or an agent in a signed-in terminal
with access to the source.

- **A folder on your computer.** Put the files you want to start with in it.
  A single `README.md` is enough to try Forge. Hosting a folder starts a private
  project. Replace `FOLDER` with the path to your folder.

  ```sh
  nforge host "FOLDER"
  ```

  If Forge says the upload is pending, use this to continue it.

  ```sh
  nforge host "FOLDER" --resume
  ```

- **A GitHub repository.** In Forge, open **Projects → New project → Import
  from GitHub**. Enter the repository URL and choose **Import from GitHub**.
  For a private repository, a GitHub administrator may need to allow the Forge
  app to reach it. This brings in committed files and Git history. GitHub
  issues, pull requests and memberships stay on GitHub.

  In a terminal, replace `OWNER/REPO` with the GitHub repository name. The
  following command creates a private Forge project, even from a public
  repository. Leave off `--private` to keep the source repository's visibility.

  ```sh
  nforge import OWNER/REPO --private
  ```

  If the import is interrupted, use the ID it printed in place of `OPERATION_ID`.

  ```sh
  nforge import --resume OPERATION_ID
  ```

Wait until Forge says main is ready. Use the clone command it prints and
replace `DIR` with the folder you want to work in. If you start from the
website, fill in the Forge project name and choose a new folder.

```sh
nforge clone OWNER/PROJECT "PROJECT_FOLDER"
cd "PROJECT_FOLDER"
```

Run the commands below from this folder. Keep it next to the matching
`.forge-client` folder. If you skip bringing in files, there is no copy on
Forge to work on. If you only skip cloning, you can still browse it on the web.

## 3. Choose how changes are checked

**Who can do this?** The project owner chooses. An agent can read the setting or prepare
the setup. See [how the agent hands over](#what-an-agent-can-and-cant-do).

A check runs a test or build on the files about to reach main. CI is the
service or computer that runs it. This command shows the check and runner Forge has.

```sh
nforge agent . check-settings '{}'
```

- **Use a GitHub Actions workflow you already have.** Open **Settings →
  Landing and checks → The check that decides a landing**. Choose **GitHub
  Actions**, select your workflow and choose **Use this file** (or **Use**
  followed by the workflow filename). If it runs on pushes, first
  [connect the GitHub mirror](#8-connect-a-github-mirror). For other systems,
  see [which check reports Forge can use](../operations/ci-status-checks.md).
  GitLab CI cannot currently decide a Forge landing.
- **Pick one command that should pass.** This example checks that the README
  exists and has text. Replace it with the command your project should run.
  A runner is the place that runs it. Choose
  [your own machine](../operations/self-hosted-runner.md#registration) or
  [Forge's workflow on your GitHub Actions](../operations/github-actions-checks.md).
  For the GitHub option, replace `OWNER/RUNNER_REPOSITORY` with the prepared
  runner repository from that guide. It can be different from your project's
  GitHub mirror.

  ```sh
  nforge x . configure-check '{"command":{"name":"verify","executable":"bash","args":["-c","test -s README.md"],"environmentLabel":"README smoke"}}'
  nforge x . configure-runner '{"provider":"github-actions","repository":"OWNER/RUNNER_REPOSITORY","runsOn":"ubuntu-latest"}'
  ```

  A check with no runner cannot run. The check settings command tells you
  what is missing.

- **Leave it for later.** Forge can accept a change without a check. The
  landing record calls it **unchecked**. The project can still ask the owner
  to approve. If Forge says to select a configured check, use the
  check settings command above to see what's missing.

## 4. Choose who approves landings

**Who can do this?** The project owner in the browser. An agent can propose the setting.

A landing puts a change on main. Open **Settings → Landing and checks →
Who approves landings**. Pick **Ask me before each landing** to read changes
yourself, or **Land on its own when the check passes** to let ordinary changes
through automatically. The second choice still pauses changes that touch a
path [you have set aside for review](#5-choose-paths-that-need-a-person).

New solo projects start Trusted. When another member joins, Forge offers
earned trust to the owner. A project set to ask the owner can still hold its
first change without a check.

To review a held change, open the agent's link or find it in **Needs me**.
Read the changes and any check result, then choose **Approve and land** or
**Decline**. When the project has no check set up, **Approve and land** is a
single action. Follow any confirmation Forge displays for a configured check.
If Forge has not printed the link, use the original landing operation ID in
the command below.

```sh
nforge agent . approve-link '{"operationId":"LANDING_OPERATION_ID"}'
```

## 5. Choose paths that need a person

**Who can do this?** The project owner. An agent can propose the change.

A protected path is a file or group of files whose changes ask the owner to
approve. For example, you might want to review files that control how your app
goes live. Open **Settings → Landing and checks → Paths that need owner
approval**. Enter one pattern per line under **Repository path patterns**.
Choose **Save paths**.

To set the list from a terminal, replace the example with your complete
list. `deploy/**` means every file inside the `deploy` folder.

```sh
nforge x . set-policy '{"governanceVersion":1,"acceptance":{"ownerApprovalPaths":["deploy/**"]}}'
```

If you skip this, Forge uses the list it shows. The starting list includes
common files that control checks, like `.github/**`. Files your project runs
to check or prepare a change still need the owner's approval after you edit
the list. See [the full review rules](../operations/governance.md#protected-paths).

## 6. Add secrets in this order

**Who can do this?** You in a regular terminal on the project owner's approved device, and
in your CI provider's browser settings for a machine key.

Secrets are private values your app or a check needs, such as an API key.
Skip this step if your app and checks run without private values. Otherwise,
the commands that need missing values may fail.

1. **Development.** Add the name, such as `SERVICE_API_KEY=`, to the project's
   `.env.example` and [land that change](../quickstart.md#work-on-a-hosted-project).
   Leave the value blank in the file.
   Use an owner device with **Every project you can reach** and **May write
   and land with a check**. Run the following in your Forge clone. Type the
   real value only at the hidden prompt. Development values are for people
   and agents working on approved devices.

   ```sh
   nforge secret set SERVICE_API_KEY
   nforge secret list
   ```

2. **Checks.** If an automatic check needs a value, put a testing value under
   the same name in the Checks set first. This is a separate set of values for
   the check runner.

   ```sh
   nforge secret set SERVICE_API_KEY --set checks
   ```

3. **Machine key.** After the Checks values are in place, make a key for the
   runner. The key opens that project's Checks set. Forge shows it once.
   Copy it from your own terminal to the provider's masked secret field as
   `FORGE_SECRETS_KEY`.
   Give it only to the check step that needs it. If that step runs from a
   GitHub mirror, also set `FORGE_PROJECT_ID` to the ID printed by Forge's clone
   command.

   ```sh
   nforge secret machine add "Verification CI" --set checks
   ```

   If Forge lists a name with no Checks value, it prints the exact command
   to set that name. The **Open Secrets** page and check output can show the
   same command.

   With the Forge CLI installed in that check, wrap your test command as
   follows. The example just checks that a value arrived without printing it.

   ```sh
   nforge run --set checks --only SERVICE_API_KEY -- node -e "process.exit(process.env.SERVICE_API_KEY ? 0 : 1)"
   ```

For device access, changing values and secret proposals, see
[Set up sealed team secrets](secrets.md).

## 7. Tell Forge where you deploy

**Who can do this?** The owner chooses the destinations. An agent can prepare the file and
submit the setting for approval.

A deploy sends accepted files to somewhere people can use them, like a test
website. A deploy target is Forge's name for that destination. To declare a
target means to tell Forge what to call it and which files should count as
changes for it. Your existing deploy job still sends the files.

Create a file called `deploy-policy.json` beside your clone folder. Change the
names and folders below to match your project. Remove `triggerPaths` to match
every change. Run the command from inside your clone.

```json
{
  "deploys": {
    "targets": [
      {
        "name": "website",
        "label": "Website",
        "environment": "test",
        "triggerPaths": ["site/**"]
      }
    ]
  }
}
```

```sh
nforge x . set-policy --command-file ../deploy-policy.json
```

If the command asks for approval and you own the project, open the link
yourself in a signed-in browser. A terminal can ask for approval. The
browser is where you decide. Then use the
[deploy reporting setup](../operations/ci-status-checks.md#deploy-status) to
connect your existing deploy job. If you skip this, your existing deploy
job can still run. Forge has no named destination to show on **Now**.

## 8. Connect a GitHub mirror

**Who can do this?** The project owner in Forge and a person allowed to grant the Forge
app access to the GitHub repository. An agent can start the connection.

A mirror keeps GitHub's main up to date with accepted Forge changes. It can
also send the branches used by some GitHub Actions checks. If you skip it,
the project stays in Forge and landings do not update GitHub.

Open **Settings → GitHub mirror**. Enter the GitHub repository and choose
**Allow on GitHub**. Choose **One-way only** instead if you only want accepted
main on GitHub. Finish the authorization on GitHub. You can also start the
connection from a terminal.

```sh
nforge github connect . --repo OWNER/REPO --no-browser
nforge github status .
```

Open the printed link. If Forge asks for the owner's approval first, approve
there, then allow access on GitHub. Keep the connect command running until it
reports the result. The status shows whether GitHub has caught up to Forge.

## 9. Invite people

**Who can do this?** The project owner in the browser. The invited person accepts on
their own account.

Open **Settings → People and access → Invite**. Enter a Forge handle or
email. Pick **Read** for someone who should see the project or **Write** for
someone who should also work on changes. Choose **Invite**. Ask them to sign
in and accept the invitation. An agent using your approved device already
acts for your account.

If you skip this, nobody new joins the project. Public projects can still
have visitors.

## 10. Make the project public if you want visitors

**Who can do this?** The project owner in the browser.

Open **Settings → Project → Visibility** and choose **Make public**. Type the
project's name and choose **Make public** in the confirmation. Visitors can
browse source, history and Lanes. They need an invitation to work on changes.
Under **Settings → Project → Plan**, choose **Members only** if you want to
keep the Plan and its discussions within the project.

If you skip this, visibility stays as it was when you hosted or imported
the project. A folder hosted with the defaults starts private.

## What an agent can and can't do

The agent can host, import and clone with working access. It can read the
current settings and prepare changes. If Forge prints an approval link,
send that exact link in the conversation with your user. Tell them what it
will do and which account to use. Keep the original command or operation ID
so Forge can find the same request after approval.

| Step | What the agent hands over | How the agent waits |
| --- | --- | --- |
| [Approve a device](#1-sign-in-and-approve-a-device) | “Open this Forge link, check the code and approve the terminal named My laptop.” Use the link from login and the actual device name. | Keep the original login running. Continue when it reports sign-in. |
| [Allow GitHub import](#2-bring-your-files-to-forge) | If Forge says the GitHub app cannot see the repo, send the installation link it prints. “In GitHub, allow Forge to access this repository.” | Wait for the person to confirm access. Follow the import receipt's retry or resume command. |
| [Choose a check](#3-choose-how-changes-are-checked), [change landing approvals](#4-choose-who-approves-landings), or [edit review paths](#5-choose-paths-that-need-a-person) in the browser | Send the project's **Settings → Landing and checks** link. “Open this as the project owner.” Name the step they need. They can choose **Use this file** for a workflow, **Ask me before each landing** for review each time, or **Save paths** after editing the review list. | Wait for the owner to tell you they saved it. Run the check settings command above for the check and runner. Use the following policy command to read the approval rule and paths. |
| [Submit a check or runner](#3-choose-how-changes-are-checked), [change review settings](#5-choose-paths-that-need-a-person), or [declare a deploy target](#7-tell-forge-where-you-deploy) in the terminal | If Forge holds the setting, send its approval link. “Open this link signed in as the project owner. Read the change and approve or decline it.” The request also appears in **Needs me**. If the command says it applied during first-time setup, continue. | Run the printed wait command for the setting request. Repeat it if the wait times out. After approval, follow the receipt's retry with the original operation ID. |
| [Approve a held landing](#4-choose-who-approves-landings) | Send the approval link from the landing receipt. “Open this link as the project owner, read the change and its check result, and choose **Approve and land** or decline.” | Keep running the receipt's wait command until it says `LANDED` or returns a final result. Repeat the wait on timeout. |
| [Set private values or add a machine key](#6-add-secrets-in-this-order) | There is no approval link for entering values. Give the exact terminal commands and point to the CI provider's masked secret field. “Enter the value in your own terminal and paste the machine key into CI only.” | Wait for the person to say it is done. Check by name or run the check without printing a value. |
| [Connect the mirror](#8-connect-a-github-mirror) | Send the link from the connect command. “Open this link. If Forge asks for the project owner, approve there, then allow Forge to use the selected repository in GitHub.” | Keep the connect command running. After it finishes, check the mirror status. |
| [Invite someone](#9-invite-people) or [change visibility](#10-make-the-project-public-if-you-want-visitors) | Link to the project's settings if there is no approval link. Give the matching button steps. For an invitation, tell the owner which access the recipient needs. For visibility, say that visitors will be able to browse the source. | Wait for the owner to confirm the setting. The recipient accepts any invitation in their own account. |

If you need the setting wait command again, replace `APPROVAL_ID` with
the ID under `approval` in the reply.

```sh
nforge agent . wait '{"approval":"APPROVAL_ID"}'
```

This command reads the current approval rules and protected paths.

```sh
nforge agent . policy '{}'
```

## Forge words

| Word | Meaning |
| --- | --- |
| Item | A piece of planned work on the project's Plan. |
| Intent | The outcome a person or agent is working toward. |
| Lane | A separate working folder for one change. |
| Candidate | The exact set of files Forge is about to check or show for review. |
| Main | The accepted copy of your project's files. |
| Channel | A name for a copy of accepted source, such as main. |
| Check | A test or build that Forge can use to decide whether a change can land. |
| Landing | A change that reached main. Its receipt records what happened. |
| Held | Forge is waiting for a person to decide. |
| Protected path | A file or folder pattern whose changes need a person to review them. |
| Checks set | Private values kept together for checks. |
| Machine key | A private key that lets a check runner open a project's Checks set. |
| Deploy target | A named destination for a deploy, such as a test website. |
| Needs me | The project page that shows what is waiting for your attention. |

You can open this list from **Needs me → Forge words**. Ready to try a change?
Follow [First landing](../quickstart.md#first-landing).
