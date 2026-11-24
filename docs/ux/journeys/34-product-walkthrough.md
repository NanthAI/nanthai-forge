# Journey 34: the short product walkthrough on a first visit

What a newcomer is shown before they do anything: what Forge is, how work flows, and what they will be asked. Issue a0cf8c22 lists "a short product walkthrough on first visit" first under first run (spec in Phase 7, build with Phase 8 onboarding). [Journey 1](01-first-value.md) maps the steps from discovery to a first clone; this file maps the explaining.

Walked: the landing, public preview and first-run guide sources, the README, the concepts doc and the quickstart glossary. **Not walked:** a rendered landing page and a first sign-in.

## Steps today

| # | Moment | What explains the product | Evidence |
| --- | --- | --- | --- |
| 1 | Signed out, landing page | Headline "Hand it off. Watch it land." Sections: "What Forge shows you", "One screen that needs you", "Delegate as much as you like." Three statements: "Each person and each agent works in an isolated copy. Overlaps are shown early, as advice, never as locks."; "Every acceptance records the exact code it ran on. If the check fails, the Lane comes back to you with the failing test, not a red wall."; "Now shows who's working, what's changing, what overlaps and what needs a decision. Everything else is a click deeper." A line "Open development · Forge builds itself". Links: Docs, Status, GitHub, Security, Contact. Docs, Status and Security open files in a GitHub repository. | source |
| 2 | Signed out, try it | A field for a public GitHub repository and **Preview with Forge**: "Public repositories · no account needed". "Reading the repository…", "Drawing the graph…", then "Your code, as a map" ("Every point is a file; lines are imports.", "Most depended-on files"), "Who is doing what, now" (an example of Now, titled "Now · example for REPO") and "What your agent would get". | source |
| 3 | First sign-in | A handle prompt: "Pick your handle. Collaborators and agents see you by this handle. You can change it later in settings." Then the Projects page: "No projects yet." | source |
| 4 | First project, empty | "Your project is ready. main is empty. Add an agent to start work, or import an existing project archive." | source |
| 5 | First visit to Now | A three-step guide: "The outcome, in a sentence: "Fix tax rounding on gift cards." It gets its own Lane."; "Copy the prompt into Claude Code, Codex or any agent. It works in the Lane."; "When the check passes, Needs you asks for one decision."; and a link "How Forge works". | source |
| 6 | The ideas, in the docs | README: "Four ideas: Intent, Lane, Check, Channel". Concepts: "An agent needs three nouns: Issue, Lane, landing". Quickstart glossary. (Journey 1, J1-3.) | docs |
| 7 | In the terminal | `nforge --help`: one sentence, then "Start here: nforge docs quickstart (offline Git adoption)". | ran |
| 8 | A tour, a video, a sample project | None found. | source |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J34-1 | S2 | **The first-run prompt is the walkthrough.** The landing page, public preview and docs can introduce the terms, but the empty-page prompt is where a new user starts the loop. | Item a0cf8c22 |
| J34-2 | S2 | **The preview shows the least distinctive thing first.** "Your code, as a map" is a graph of imports. The claim in the headline is about many agents landing safely (journey 1, J1-11). The "Who is doing what, now" panel is the product, and it is an example with invented activity for a repository where nothing is happening. | source |
| J34-3 | S2 | **The first-run guide appears after the hard part.** It lives on Now, which needs a project. Sign-in, the handle, a project and, for real work, the CLI and a check ([journey 13](13-connecting-ci.md)) all come before it. Onboarding pattern: show value before asks. | source |
| J34-4 | S2 | **The guide's third step is wrong for most projects.** "When the check passes, Needs you asks for one decision." is true for a supervised project. On a project that lands automatically, nothing asks. The words need to follow the project's setting. | source, docs |
| J34-5 | S2 | **Nothing in the walkthrough mentions the agent's side.** "Copy the prompt into Claude Code, Codex or any agent" assumes an agent that is installed, signed in and in the right folder ([journey 14](14-setting-up-agents.md)). The step where most newcomers will stall has one clause. | source |
| J34-6 | S3 | **The vocabulary in the walkthrough is about to change.** "Acceptance", "Intent" and "accept" appear on the landing page and guide; the owner's decisions are Item, approve and land. Any walkthrough written now needs those words. | source |
| J34-7 | S2 | **The landing page's Docs, Status and Security links leave the site for a GitHub repository whose address differs from the project's mirror.** The links name `nanthai/forge`; `check-settings` and `history` name the mirror as `NanthAI/nanthai-forge`. Whether the first address redirects was not checked. A visitor who wants to read more leaves for GitHub at the first click. | source, ran |
| J34-8 | S3 | **"Status" opens the development status document**, not service status ([journey 30](30-provider-outage.md)). | source |
| J34-9 | S3 | **The empty project offers a retired route** ("import an existing project archive"; journey 1, J1-6). | source |

## Dead ends

- A newcomer who wants to see the product working before installing anything: the preview cannot show a landing.
- A newcomer on a phone: every next step needs a terminal.

## Naming and tone

- The landing sentences are in the product voice and are specific ("with the failing test, not a red wall"). They describe features; the walkthrough needs the sequence.
- "Hand it off. Watch it land." is the walkthrough in five words. The product does not yet show those two moments to a visitor.

## What each persona needs

- **Agent, not person:** its own walkthrough is the first-contact reply and the skill ([journey 14](14-setting-up-agents.md)); it needs none of this.
- **Person, not agent:** one prompt to give to an agent from the empty page. The walkthrough should lead into real work, not a tour or prefilled account.

## Decisions

- The empty-page agent prompt is the walkthrough. No sample project is created for a new account (Item a0cf8c22). Activation is sign-up plus create, import or clone, not a tutorial or landing (Item 8edd3157).
- The public project page leads with its README and recent landings, with the code map one click away (Item 8947a779).

## Questions for the owner

- Which terms does the prompt teach, and in what order?
