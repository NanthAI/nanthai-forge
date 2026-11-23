# Convex Auth v2 sign-in: spike

Status: **prototype run on a throwaway local Convex deployment** (anonymous local backend, no account, no shared or production deployment touched). It answers the owner's eight-case gate on Item de67c77d: can Convex Auth v2 (passkeys and GitHub sign-in) replace the current sign-in provider? Versions: `@convex-dev/auth` 2.0.0 (released 2026-11-12) on `convex` 1.50.0. The spike code is saved, not landed, in Lane 220894c4 under `spikes/convex-auth/`. Labels: **M** = measured on the spike, **R** = read from package source, **E** = estimated, **U** = unrun.

## Verdict

**No blocking failure.** Cases 1, 2 and 4 pass without patching the library, so the move goes ahead. Cases 5 and 6 meet the budget with app-level code only: a refresh hold for dormant tabs, passkey autofill only while visible, and session-resolving guards. Two checks still need the owner: case 3 (real phones) and the live GitHub leg of case 1 (a GitHub OAuth callback on a cloud dev deployment). The implementation starts in a fresh slice. Its first landing should be the parts these two checks cannot change: the identity resolver, account keys and the GitHub token store.

| Case | Result | Evidence |
| --- | --- | --- |
| 1. Verified numeric GitHub id and verified email reach our code | **Pass (fixture path); live leg open** | M: `createUser`/`onSignIn` receive `profile.id` (numeric id as a string) and `emailVerified`. `emailVerified` is true only when a `/user/emails` entry is verified (R: the library's mapping); our callback stores no email for an account with only an unverified one (M). M: the real GitHub start leg sends the browser to `github.com/login/oauth/authorize` with PKCE S256, `state` and scopes `read:user user:email`. U: the code exchange against GitHub itself (needs an OAuth callback URL on a cloud dev deployment). |
| 2. A GitHub-signed-in person adds a passkey and signs in with it | **Pass, with app-level glue** | M: the stock add-passkey flow throws for an account with no passkey (library TODO: it re-authenticates with an existing passkey). An app mutation that composes the passkey component's own functions adds the first passkey from a session minted in the last 10 minutes. The stock handle-first passkey sign-in then returns the same Forge account. After that the stock add-passkey flow works. |
| 3. Real iPhone (Safari), Android (Chrome, Google Password Manager), one cross-device QR sign-in | **Open (owner)** | M on a virtual authenticator only (Chromium WebAuthn, CTAP2, resident key, user verification). Owner script below. |
| 4. Forge's CLI token issuer beside Convex Auth | **Pass** | M: Forge's real token module (`src/device-token.ts`) runs beside the Convex Auth provider in one `auth.config.ts`. A device approval from a Convex Auth browser session issues a normal `forge-cli` credential: RS256, `iss` = Forge's issuer, `sub` = the Forge account key. A query using that credential resolves to the same account as the browser. A `forge-cli` identity cannot approve devices. |
| 5. Idle cost | **Pass, with a Forge-side hold; one fix needed** | M: an idle signed-in tab makes 1 refresh per hour at a 1 h token lifetime. A dormant tab with the hold makes 0 calls, then 1 refresh on wake. Landing cost is unchanged. R/M: the signed-out sign-in screen renews a passkey autofill challenge every ~8 minutes, so it must run only while the tab is visible and active. Details in [Idle and refresh](#idle-and-refresh) and [Cost per sign-in](#cost-per-sign-in). |
| 6. Revocation on a second open tab | **Measured** | M: in a tab with its own session, reads that resolve the session return signed-out 33–66 ms after revocation, and the tab is fully signed out in 51–83 ms. A mutation from it is refused. A copied access token still passes any check that reads only the token, for the rest of its lifetime (3,599 s left at a 1 h TTL). |
| 7. Dry-run id mapping on a read-only copy | **Pass** | M: 7 accounts. Every owner in projects (312), CLI credentials and handles has an account row. Planned writes: 7 user rows, 0 owner rewrites. Details below. |
| 8. Native note | **Done (desk)** | R, below. |

## What the move changes in Forge

1. **The token subject is a session, not an account.** R/M: a Convex Auth access token's `sub` is the session id. Forge uses `identity.subject` as the account key in about 400 places (`convex/`, `src/`, `web/src`). The implementation needs one resolver: forge-cli credential → `subject` (unchanged; its row check stays); Convex Auth token → session → Forge `users` row → `accountKey`. That costs 2 small reads per browser-facing call (component `getSession` plus the user row) and nothing on the CLI path, where landings run.
2. **Every browser guard must read the session.** Revocation is instant only for functions that resolve the session (case 6). A guard that trusts the signed token alone accepts a revoked session's token until it expires.
3. **Account keys keep their shape.** The public-identity rule (`convex/publicPeople.ts`, `tests/account-id-scan.mjs`) finds account ids by the `user_` + alphanumeric shape. A raw Convex id would slip past it. New accounts get `user_<users row id>`. Migrated accounts keep their current key on a pre-seeded `users` row, and `createUser` returns that row on the first GitHub sign-in with the same verified numeric id (M: a seeded synthetic account kept its key).
4. **GitHub tokens need their own Forge store.** Today Forge asks the sign-in provider for (a) the verified GitHub account ids linked to an account (`linkedGithubAccounts` in `convex/githubBindingOAuth.ts`) and (b) the person's GitHub App user token for private-repository checks (`githubUserToken` in `src/github-access.ts`). Convex Auth uses the OAuth access token only to read `/user` and `/user/emails`, then drops it (R). (a) moves to the `users` row, written at sign-in. (b) needs a Forge user-token exchange and an encrypted token row. `githubBindingOAuth.ts` already does its own exchange, so the implementation extends it. Expect a short consent step the first time a person opens a private repository.
5. **Dependencies.** Convex Auth 2.0.0 needs `convex` ≥ 1.48 (Forge pins 1.46.0). The bump is its own slice with a CLI cold-start and installed-size measurement, because the CLI ships `convex`. `@convex-dev/auth` belongs in devDependencies: the Convex bundle and Vite pull it in, the CLI never does.
6. **Removal list once proven (done in de67c77d):** the old provider's web package and its Convex binding, its provider entry and HTTPS-distinctness check in `convex/auth.config.ts`, its env and setup docs, the provider calls above, and its wording in the identity-shape comments.

## Passkeys

- R: the passkey method is identifier-first. The person types a handle; a known handle gets a challenge bound to that account, and a free handle starts a **new passkey-only account** (no GitHub id, no verified email). Whether Forge allows passkey-only sign-up is a product decision. If it does not, an app wrapper refuses the register step.
- R/M: the first passkey of a GitHub account needs the glue from case 2, and it calls `_internal_dangerous_*` component functions. The library may change these between releases, so pin the version and keep a regression test on this flow. The 10-minute freshness rule is ours; the security review should confirm it.
- M: mounting the passkey hook starts a conditional-mediation (autofill) challenge on every view of that screen: 1 mutation and 1 challenge row. That wakes the component's challenge-cleanup worker (see [Idle and refresh](#idle-and-refresh)). Mount it only on the sign-in screen.
- R: options fix `extensions: {}` and responses must carry `clientExtensionResults: {}`. A sign-in passkey therefore cannot carry PRF, which keeps the sealed-secret envelope passkey separate (Item 41a0df87).
- R: relying party: `rpId` is the registrable web domain; `origin` takes a list, so one deployment can accept the web origin, an iOS app (`https://<rpId>`) and an Android app (`android:apk-key-hash:<hash>`).

## Idle and refresh

The budget is 0 calls for a hidden tab, and 0 calls for an idle open tab beyond token refresh. The spike sets the access token lifetime to 1 hour (the library default is 60 s; the maximum is 1 hour).

- **Idle open tab, signed in (M, one hour):** 1 refresh per hour. The tab sent one `refreshSession` HTTP mutation and one websocket re-authentication about 3,590 s after sign-in, and stayed signed in. Each refresh also re-runs the tab's subscribed queries once, because the token changes (3 in the spike). Apart from the refresh, the server ran nothing for that tab. At the 60 s default it would be 60 refreshes an hour.
- **Hidden tab (R):** neither the Convex client nor Convex Auth looks at page visibility. Without app code, a hidden tab refreshes exactly like a visible one: 1 per hour.
- **Dormant tab with a Forge-side hold (M):** the spike wraps the client's token fetch so a due refresh waits while the tab is dormant. That is app code, not a library patch, and it matches the dormancy rule `web/src/live-reads.ts` already applies to subscriptions. Over 6 minutes at a 120 s lifetime, an awake control tab made 3 refreshes. The dormant tab made 0 function calls; the server log shows none for it. On wake it made 1 refresh and was signed in again within a second. So a hidden or idle tab costs **0 calls**, and a returning tab costs 1 refresh.
- **Session watcher (R):** the library keeps one `isAuthenticated` subscription per tab. That is what signs a tab out within ~100 ms after revocation (case 6). It sends nothing while idle and re-runs only when the token or the session changes. Forge's dormancy closes it with the other subscriptions.
- **Signed-out sign-in screen (R/M): fix before shipping.** The passkey autofill hook starts a challenge when it mounts, then a fresh one about every 8 minutes for as long as the screen stays open, hidden or not. The challenge lives 10 minutes. Each challenge is 1 mutation plus 1 row, and it wakes the component's cleanup worker. In the spike that was 10–20 short cleanup runs when the challenge was created and more when it expired, then nothing once no challenges were left (M: fully idle for 50 minutes after the last one). An idle sign-in tab would cost about 8 challenges an hour. Forge must pass the hook's `enabled` option only while the tab is visible and active, or start autofill only when the handle field gets focus. Both are app-level.

## Cost per sign-in

Sign-ins are rare: a handful per person per month. Function runs per flow (M), from the spike deployment's function log, with the spike page's three subscriptions (the session watcher plus two identity queries):

| Flow | Function runs | Of which |
| --- | --- | --- |
| Open the sign-in screen (signed out) | 3 + cleanup | 2 query runs, 1 autofill challenge, ~11 cleanup runs |
| GitHub sign-in, new account | 8 | 1 sign-in mutation, 1 refresh, 6 query re-runs |
| GitHub sign-in, existing account | 9 | the same |
| Add the first passkey | 2 + cleanup | start and finish, ~11 cleanup runs |
| Passkey sign-in (handle first) | 12 + cleanup | start, finish, 1 refresh, 1 new autofill challenge, query re-runs, ~15 cleanup runs |
| Sign out | 8 | sign-out, token delete, query re-runs |

- **Live GitHub sign-in (R/E):** the spike replays GitHub's redemption step. A real sign-in adds the start mutation and one HTTP action for the callback (a token exchange plus `/user` and `/user/emails`, three outbound fetches), and finishes with the same sign-in mutation.
- **Rows written per sign-in (R):** 1 session, 1–2 refresh-token rows (one more at each refresh), the user row (insert or patch), the GitHub account row on the first GitHub sign-in, and an OAuth authorization request and ticket on the live leg. A passkey ceremony adds 1 challenge row, deleted when it is used or expires, plus the credential row on registration or a counter update on sign-in. DB I/O per sign-in is a few KB (E: small documents, single-row index reads). The library's own reads and writes run inside the component.
- **Every browser call afterwards (E):** 2 extra small reads to resolve the session to the Forge account (see [What the move changes](#what-the-move-changes-in-forge)).
- **Cost per 1,000 landings: unchanged (E).** Landings run on CLI credentials. That path keeps its current row check and gains no reads. The Phase 6 reference ($1.682603 per 1,000 landings) does not move. The new browser-side cost is 1 refresh mutation per awake signed-in tab per hour, and 0 for dormant tabs. Function calls are included in the current Convex plan. DB I/O stays at a few KB per sign-in.

## Id mapping dry run (case 7)

Read-only copy: `forgeAccounts`, `accountHandles`, `hostedProjects` and `cliCredentials` exported from the shared development deployment as JSON lines, processed locally, printing counts only. The copy was deleted afterwards.

- 7 accounts, 7 distinct keys, handles unique and valid as passkey usernames (1–100 characters, no edge spaces).
- 2 keys were issued by the current provider (`user_` + 27). 5 are non-provider keys (lowercase words with hyphens and colons, 1–3 projects each) that never sign in through the provider. They need no mapping and keep their keys. They also do not match the `user_` shape the identity scan uses: worth checking on the identity-rule owner, independent of this move.
- Every owner referenced by 312 projects, 5 CLI credentials and 8 handle rows has an account row; 0 orphans.
- New keys (`user_` + 32) cannot collide with current keys (tails of 27 and 50–61 characters).
- Plan: one `users` row per account with `accountKey` = current key and, for the 2 provider accounts, the verified GitHub id read once server-side from the current provider. No owner field is rewritten anywhere. A person who signs in with GitHub before the backfill gets a new account, so the backfill runs before sign-in switches over.

## Native clients (case 8, desk)

Answers the 2026-11-12 native-client comment:

1. **Tokens without the JS client:** yes (R). Sign-in, refresh (`refreshSession({refreshToken})`, rotating) and sign-out are ordinary public Convex functions. A Swift or Kotlin Convex client can call them and hand the access token to its auth-provider hook. Tokens go in the Keychain or Keystore. U: whether those SDKs' auth-provider hooks re-fetch before expiry; check this when the native app starts.
2. **Native passkeys:** yes, with setup (R). AuthenticationServices / Credential Manager against the same start/finish mutations. Needs the web-credentials association (`apple-app-site-association` webcredentials; Android `assetlinks.json`), plus the app origins in the passkey `origin` list. The JSON options map one to one onto the platform request types.
3. **Native GitHub sign-in:** partly (R). `redirectTo` must be an http(s) URL, and custom schemes are refused. A native app returns through a universal link / App Link to an https path (iOS `ASWebAuthenticationSession` supports https callbacks from iOS 17.4). The library notes that React Native support is not there yet.
4. **CLI and agents:** unchanged. They keep Forge's own device credentials (case 4) and never hold a Convex Auth session.

Nothing here needs unsupported internals beyond the passkey glue in case 2.

## Security-relevant decisions for the review

For the security review that comes before the current provider is removed:

- **Session lifetime:** access token TTL 1 h (the maximum `ctx.auth.signJwt` mints); session maximum 30 days; inactivity timeout set by Forge (spike: 14 days); at most 100 sessions per account (the oldest-refreshed is evicted).
- **Token storage:** the SPA keeps the access and refresh tokens in `localStorage`, readable by any script on the origin (an XSS steals a 30-day session). The httpOnly-cookie mode exists only for the library's SSR hosts. Forge needs a strict CSP or a storage decision.
- **Refresh tokens:** rotate on every use. Reusing a superseded token revokes the session (theft detection), with a 5 s grace and at most 3 outstanding tokens. Only hashes are stored.
- **CSRF / origin:** no cookies in SPA mode (bearer tokens; the refresh token travels in the mutation body), so no CSRF surface. OAuth uses `state` plus PKCE S256. `redirectTo` must be on an allow-listed origin, and the callback URL is fixed by the component's HTTP prefix. Token and userinfo fetches are https-only and follow no redirects. Passkeys check an exact origin list and `rpId`, with user verification required.
- **Revocation path:** delete the session (sign-out, "sign out other devices", or account action). Session-resolving reads see it at once; live tabs sign out within ~100 ms through the library's session watcher; refresh fails. Token-only checks are not allowed in Forge (see above).
- **CLI issuer trust:** Forge's RS256 issuer and Convex Auth's ES256 issuer stay distinct (different `iss`, `aud` and keys). Device approval accepts only a Convex Auth session, resolves the owner through the session, and refuses a forge-cli identity. A forge-cli `sub` is the Forge account key, never a session id.
- **Account linking:** there is no automatic linking by email. A GitHub identity maps to a user by its numeric id in the GitHub component, and a passkey maps by credential. Adding the first passkey to a GitHub account needs a fresh session (spike rule: 10 minutes).
- **Passkey-only sign-up** creates an account with no verified email (product decision above).

## How the spike ran

`spikes/convex-auth/` (not part of the product build): `convex/` holds the auth setup, user callbacks, passkey glue, the device-login copy and identity queries; `drive/` holds Playwright drivers (`e2e.mjs` for cases 1, 2 and 4, `revoke.mjs`, `idle.mjs`, `dormant.mjs`, `cost.mjs`, `mapping-dry-run.mjs`). Personas and GitHub responses are synthetic. The local backend refuses non-HTTPS OAuth token endpoints and does not trust a local CA, so case 1's exchange leg is replayed: the library's redemption step runs with recorded `/user` and `/user/emails` responses against the real GitHub component, behind a spike-only flag.
