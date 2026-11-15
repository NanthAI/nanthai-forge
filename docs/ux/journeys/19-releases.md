# Journey 19: releases, tags, versions and deploys

Marking a version of a project, publishing it, writing down what changed, and running something after a landing (a deploy). Most of this journey is absent today; this file maps what exists and what a person from GitHub will look for.

Walked: `nforge --help`, `policy`, `history` status, the workflows doc (Channels and releases), the concepts doc, the GitHub App doc (what the mirror writes), the repository's own deploy workflows and the open Issues 954340ea, 29fbe61c and f65d8024. **Not walked:** anything that writes; no release or tag command exists to walk.

## Steps today

| # | Goal | What exists | Evidence |
| --- | --- | --- | --- |
| 1 | Name a version (a tag) | Nothing in Forge. The import can start **from** a tag ("Branch, tag or commit (optional)"). The mirror writes `main` only: "other branches, tags and deletions are never written." Imported Git history is kept, and the docs do not say whether its tags are. | docs |
| 2 | A release with notes | Nothing. No release object, page or command. A `releases` block for a repository Home page (`.nforge/home.md`) exists and on hosted projects shows "their original text", because it describes "local Work records, which hosted source snapshots do not include". | docs, source |
| 3 | A changelog | Nothing generates one. Each landing has a message (at most 1,024 bytes) that becomes the mirror's commit message. The Phase 5 plan noted that files such as `CHANGELOG.md` should be "generated from accepted Intents instead of hand-edited, so they never serialise landings". | docs |
| 4 | More than one line of development (a release branch) | A Channel is "a named pointer to accepted source, such as main (protected branch)". Only `main` is used on hosted projects; no command creates another Channel. | docs |
| 5 | Roll back a release | "A person can explicitly select an earlier accepted Candidate to roll back" (local projects). On hosted projects the route is **Revert…**, which lands the reverse change; "Main is never rewound." ([journey 10](10-mistakes-recovery.md)) | docs |
| 6 | Deploy after a landing | Nothing in Forge. In practice the mirror does it: this repository's GitHub workflows "Deploy dev Convex" and "Deploy dev web" run `on: push: branches: [main]` of the mirror. Open Issue 954340ea: "A standalone Forge project can run its declared deploy step after landing, on its chosen runner, with secrets held by Forge, without requiring GitHub." | source, docs |
| 7 | Be told a landing happened (a webhook) | Nothing outbound. Open Issue f65d8024 plans an event feed and `nforge watch ROOT --on-landing CMD`. | docs |
| 8 | Know which version is deployed | Nothing. `status` reports the mirror ("synced") and main's head. | ran |
| 9 | Forge's own CLI versions | "The CLI updates itself to main"; releases are signed by `nforge cli release-sign` or a GitHub job; `nforge cli rollback` returns to the one previous build. This is Forge's own delivery, not a feature for projects. Open Issue 29fbe61c adds a stable channel. | ran: help, docs |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J19-1 | S1 | **A project cannot mark a version.** No tag, no release, no version field. Libraries, apps with store builds and anything with a changelog need "this landing is 1.4.0". Today the only place to do it is the GitHub mirror, by hand, and Forge does not know. | docs, ran |
| J19-2 | S1 | **Deploy depends on GitHub.** A project that turns the mirror off loses its deploy trigger. The owner's stated direction is a GitHub replacement; the open Issue for a Forge-native deploy step has no design yet. | source, docs |
| J19-3 | S2 | **Tags on the mirror and tags in Forge can drift.** A person tags on GitHub; Forge does not read tags back (two-way covers pushes to `main` and pull requests). A later Forge release feature would have to adopt or ignore them. Nothing states the rule. | docs |
| J19-4 | S2 | **Landing messages are the only record of what changed, and they are written by agents for a commit log.** Forge holds the Item, its done-when lines, the check and the diff for every landing. A changelog from landings (the journeys Issue asks for "cut a release with a changelog from landings") would be assembled, not written. Nothing assembles it. | docs |
| J19-5 | S2 | **"Channel" is a concept with one instance.** Concepts and the README teach Channel as one of the first ideas; hosted projects have `main` and nothing else. A newcomer learns a word they cannot use (journey 1, J1-3). | docs |
| J19-6 | S2 | **"Release" already means four things.** Forge's CLI builds (`cli release-sign`, "release-numbered"), the `releases` Home block, "release ordering" for mixed installs in the roadmap, and what a user means (a published version). | ran: help, docs |
| J19-7 | S2 | **Nothing links a landing to what ran after it.** When the mirror's deploy workflow fails, Forge shows the landing as landed and the mirror as synced. The failure lives in GitHub Actions. | source, ran |
| J19-8 | S3 | **A deploy path is protected, and the reason is not visible.** `netlify.toml`, `netlify/**`, `scripts/deploy*` are on the default owner-approval list. An agent that edits one is held. The reply names the paths, not that they are held because they deploy. | docs |

## Dead ends

- "Tag this landing."
- "What changed since the last release?"
- "Deploy when this lands", without GitHub.
- "Which landing is in production?"

## Naming and tone

- Channel, release, version, tag, State and checkpoint need a decision as a set (see [journey 18](18-browsing-code.md), question 3).
- The mirror's rule is stated well: "Forge still owns main".

## What each persona needs

- **Agent, not person:** to know whether its landing triggered a deploy and whether that deploy passed; to be refused clearly if it may not cut a release.
- **Person, not agent:** to mark a landing as a version, see what changed since the last one in plain words, and know what is live. An owner approves a release; an agent may propose one.

## Questions for the owner

1. Does Forge have releases (a named, immutable version of main with generated notes) in the beta, or is the mirror's tag the answer until Phase 9?
2. If releases exist: are notes assembled from Item titles and done-when lines, and may an agent cut a release or only propose one?
3. Is deploy after landing (954340ea) a Phase 7 design item as the 2026-11-09 review asked, and is its unit "a command on the project's runner"?
4. Are tags mirrored to GitHub, read from GitHub, both, or neither?
5. Does "Channel" stay a word people see, given only `main` exists, or does it wait for release branches?
6. Should a failed post-landing deploy appear in Needs you?
