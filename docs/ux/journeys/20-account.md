# Journey 20: the account

Signing up, signing in on the web and in the terminal, the planned move to passkeys, signed-in devices and tokens, the profile, and deleting an account. [Journey 1](01-first-value.md) covers the first terminal sign-in as a step; this file covers the account over its life.

Walked: `nforge auth status`, `help auth`, the sign-in, device approval, device list, handle, account menu and account data sources, the agents doc, the readable-URLs doc, the operations doc (account data) and the open Issues de67c77d and 30ce7f72. **Not walked:** a sign-up, a sign-in, a handle change, a device revoke and any removal.

## Steps today

| # | Step | What the person sees | Evidence |
| --- | --- | --- | --- |
| 1 | Sign up | No sign-up page of Forge's own. **Sign in** opens the sign-in vendor's modal, which also creates accounts. The beta will open "through a gate, not open sign-up" (open Issue 30ce7f72: waitlist, batches, invite links); not built. | source, docs |
| 2 | Sign in on the web | **Sign in** (a secondary button; the vendor "opens its own modal"). | source |
| 3 | Pick a handle | "Pick your handle. Collaborators and agents see you by this handle. You can change it later in settings." Handles come "from the username the person chose, else their GitHub login, else a random `user-…` placeholder. Real names and email addresses are never naming inputs." 2 to 39 characters. | source, docs |
| 4 | Sign in from a terminal | `nforge login [DEPLOYMENT_URL] [--name NAME] [--scope cli or coordination]`. Browser page "Approve a terminal sign-in": "Type the code your terminal printed", "Approve this terminal? Only approve if you just ran nforge login yourself.", Access, Lasts, Code, Name. Outcomes: "This code has expired. Run nforge login again for a new one.", "This code was already approved. Return to your terminal; it signs in on its own.", "This code was denied." Codes last ten minutes; the credential 30 days. | source, docs |
| 5 | Check the sign-in | `nforge auth status` prints JSON: `deployment`, `host`, `authenticated`, `state:"saved"`, `nextStep:"Nothing to do."`, `account`, `tokenSource`, `hosts`, the device `name`, `scope`, `expiresAt` (epoch milliseconds), `identity.handle`, `identity.credentialId`. | ran |
| 6 | See and revoke devices | Account → "Signed-in devices": each terminal with "until DATE", "expired DATE" or "revoked"; "Coordination only" for the narrow scope; **Revoke** in two steps, "Stops working now."; "N revoked or expired" folded. `nforge logout` revokes the saved device. | source, docs |
| 7 | Tokens | No personal access tokens. A terminal credential is the token; plain Git over HTTPS takes it "as the HTTP password". `FORGE_AUTH_TOKEN` is "a private environment override for CI". Scoped agent read tokens exist for private imports ([journey 14](14-setting-up-agents.md)). | docs |
| 8 | Profile | Settings → You: the handle with "live availability validation and a URL preview"; "Handle changed. Old links still work." Account: "@handle", the email address and **Manage account**, which opens the vendor's profile window (email, password, connected accounts). | source, docs |
| 9 | Export account data | Account → "Your Forge data" → "Refresh inventory", **Download metadata** ("Metadata downloaded · SHA-256 …"). "It holds no source, raw Work, secret values or credentials." | source, docs |
| 10 | Delete things, or everything | "Select resources to remove": "Projects, private imports, SecretObjects and teams are deleted. Agent access is revoked; personal saved views and interests are removed. Other people's resources remain." "Leave incoming access (optional)". "Your sign-in identity, provider credentials, downloaded copies, other people's work and minimal operation receipts remain. You can create new Forge resources afterward." | source |
| 11 | Sign out | Account menu → **Sign out**. | source |
| 12 | The planned move | Open Issue de67c77d: replace the vendor with Convex Auth "before the public beta … while Forge has no outside users, so there is no account migration"; "Passkeys as a first-class sign-in (register, list, rename, revoke per user), plus GitHub OAuth; email/password only if the redesign wants it." | docs |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J20-1 | S1 | **An account cannot be deleted.** "Your Forge data" removes what the account owns, selected item by item, and says the identity remains. No control closes the account, and nothing tells a person how to ask. Settings pattern: deletion is self-serve, states what is removed and when, and offers an export first. | source, docs |
| J20-2 | S2 | **`nforge auth status` answered for a different service than the project in the folder.** Run in a clone of the Forge project, with no address, it reported the deployment of the last login on the machine, which was another deployment. "authenticated: true" was true for that one. A person with two deployments (a company one and the public one) gets an answer about the wrong one, with nothing in the reply saying which project it applies to. | ran |
| J20-3 | S2 | **Sign-in screens are the vendor's.** The modal, the profile window and the session list for browsers are not Forge's, so their words and look differ from the product, and a vendor name appeared in product text (journey 11, J11-8). de67c77d replaced them with Forge's own sign-in screens. | source |
| J20-4 | S2 | **Two kinds of session in two places.** Terminals are under "Signed-in devices" in Forge. Browser sessions are inside the vendor's **Manage account** window. A person who lost a laptop has to revoke in both. | source |
| J20-5 | S2 | **A terminal credential is all-or-nothing and lasts 30 days.** One scope choice (`cli` or `coordination`). No per-project limit, no read-only, no shorter life, no "expires in 3 days" warning: the next command simply fails with `AUTH_EXPIRED` in the middle of an agent's work. | docs, ran: help |
| J20-6 | S2 | **The terminal credential doubles as a Git password.** There is no separate token to give a CI job or a script, and no way to see where a credential was used. The docs' advice for CI is an environment variable holding the same credential. | docs |
| J20-7 | S2 | **"Device" is a terminal, and each agent is a device.** The page title says "terminal sign-in", the list says "devices", the CLI says `login`, the code path says "credential". One laptop running three agents shows one row; a person cannot revoke one agent (journey 14, J14-6). | source, docs |
| J20-8 | S2 | **The account data page speaks operations** ("Reconcile original operation", "Retained original requests", "Metadata and pin"; journey 11, J11-9). The first paragraph a person reads when they want to leave is the hardest in the product. | source |
| J20-9 | S2 | **Email is shown and cannot be changed in Forge.** The account page prints the address; changing it, adding a second factor or linking GitHub happens in the vendor window. After the move, each needs a Forge screen. | source |
| J20-10 | S3 | **`auth status` is JSON for a person's question.** "Am I signed in, as whom, until when?" needs one line. `expiresAt` is epoch milliseconds (journey 2, J2-8). | ran |
| J20-11 | S3 | **A waiting-list account has no journey yet.** The gate (30ce7f72) will add a state between signed up and usable. No screen says "you are on the list". | docs |

## Dead ends

- Deleting the account (J20-1).
- A token for one project, or a read-only token.
- Signing in on a machine with no browser nearby, as a person: the code flow needs a second device, which works; nothing says so.

## Naming and tone

- Sign in (web), login (CLI), device, terminal, credential, session, token, grant: one act and its result under eight words.
- The approval page is the best-written screen in this journey. Each outcome says what happened and what to do in the terminal.

## What each persona needs

- **Agent, not person:** a credential that does not expire mid-task without warning; a refusal that names the address to open and the code to type (present); never to be asked for anything it cannot do itself.
- **Person, not agent:** sign-up that takes one step (a passkey); one list of everything signed in as them, browsers and terminals and agents together; a token they can scope; one button to export and one to delete the account.

## Questions for the owner

1. With Convex Auth: is sign-up passkey first with GitHub as the alternative, and is email and password offered at all?
2. Does deleting an account exist as one action, with a grace period like the 90 days a project has?
3. Are personal access tokens added (scoped to a project, read or write, with an expiry), separate from terminal sign-ins?
4. Is one list of sessions (browsers, terminals, agents) the target, and can a person revoke a single agent?
5. Should a terminal credential warn before it expires, and may it be renewed without the browser while it is still valid?
6. Should `nforge auth status` in a project folder answer for that project's service first?
7. What does a person on the waiting list see, and can they read public projects meanwhile?
