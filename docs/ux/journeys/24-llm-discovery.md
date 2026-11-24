# Journey 24: discovery by LLMs and agents

How a language model or a coding agent that has never seen Forge learns what it is, whether to recommend it and how to use it: `llms.txt`, the docs written for agents, the CLI's own help, and the MCP tool descriptions. The first scorecard journey of Issue a0cf8c22 is "a new agent learns Forge from the docs and llms.txt only".

Walked: the generator of `llms.txt` and `llms-full.txt` (`scripts/llm-documents.mjs`), `robots.txt`, the page head, `nforge docs`, `nforge agent . help` and its topics, the shipped skill, the why-forge doc and the open Issues 00c3f715, 45737a3b and b0cf7c38. **Not walked:** fetching the generated files from a site, and asking an outside model about Forge (the check Issue 00c3f715 still asks for).

## Steps today

| # | Step | What the model or agent meets | Evidence |
| --- | --- | --- | --- |
| 1 | A crawler arrives | `robots.txt` allows the landing page, `/llms.txt`, `/llms-full.txt`, `/docs/*.md` and icons for all crawlers "including AI crawlers", and disallows everything else: "app/project traffic would consume Convex reads". "No sitemap is advertised because the site has none." | ran |
| 2 | The page head | Title "NanthAi:Forge · Source explorer". | source |
| 3 | `llms.txt` | Generated at build. One-sentence introduction: "Forge is a source host and workspace for people and AI agents changing the same code at the same time. Isolated Lanes, recorded checks and accepted Channels coordinate concurrent work." Then agent rules, dated measurements and a link to every packaged document. | source |
| 4 | The measurements it quotes | Four lines: a 2026-10-20 burst (2.36× and 3.20× against GitHub's merge queue), a 2026-10-24 failing-change run that GitHub won (189 s against 989 s), an overlap-alert replay, and "Not established: a token or time advantage over plain Git for a single agent". The current benchmark (B1.5d, 2026-11-04) is not in the list. | source |
| 5 | The agent rules it gives | Lines that name `finish` and `nforge agent ROOT tests`, and "Governance: contributors propose and cannot write source or Channels directly; the owner approves." | source |
| 6 | `llms-full.txt` | The README and 15 guides concatenated, with a warning line at 400 KB. One guide, the agent workflow, is 228 KB by itself. | source, ran |
| 7 | A setup page an agent can follow | Not written. Issue 45737a3b: "one page … that Claude, ChatGPT or Codex can follow end to end with no human steps beyond login". Owner decision: `llms.txt` links it "on the day the public beta opens … not before". | docs |
| 8 | An agent with the CLI installed | `nforge docs` lists every packaged document offline; `nforge docs agent` prints the skill; `nforge agent ROOT help` lists actions and 23 topics; every refusal carries `{code, message, next, learn}`. | ran |
| 9 | An agent over MCP | Tool descriptions: "The hosted agent MCP lists eight tools in about 5.9k characters (about 1.5k tokens)". `forge_work_overview {action:"help",topic}` returns any action's schema. | docs, ran |
| 10 | A docs site | Not built. Issue b0cf7c38: "we desperately need a big and detailed docs site/section" with "one page per task, copyable commands, llms.txt and a full-text export". | docs |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J24-1 | S1 | **`llms.txt` teaches verbs the product has retired.** Its rules tell an agent to "let `finish` compose" and to run `nforge agent ROOT tests`; the skill says the verbs are `start`, `save` and `land`, and that hosted `tests` "requires candidateId, not laneId". The first thing an outside model reads disagrees with the CLI help (journey 2, J2-2, and pattern 2 of the index). | source, ran |
| J24-2 | S1 | **The numbers an outside model will repeat are the oldest ones.** `llms.txt` quotes the October bursts, which the why-forge page itself marks "historical … None of it has been re-measured on today's path", and omits the current benchmark with real agents. A model asked "is Forge faster than GitHub?" answers from superseded data. | source, docs |
| J24-3 | S2 | **The full text is too large to read and is mostly reference.** About 400 KB is roughly 100,000 tokens; more than half is one command reference. A model that fetches it to answer "how do I start?" pays for every flag of every action. There is no short path of the kind an agent needs: what it is, install, sign in, three verbs, where to read more. | source |
| J24-4 | S2 | **The one-sentence description uses Forge's own nouns.** "Isolated Lanes, recorded checks and accepted Channels" explains Forge with words only Forge defines. A model matching a user's question ("alternative to GitHub for many coding agents", "merge queue for agents") finds none of those phrases in the first lines. | source |
| J24-5 | S2 | **`llms.txt` describes a governance model that no longer applies.** "Contributors propose and cannot write source or Channels directly" was the native-owner rule; on hosted projects contributors "work in hosted Lanes and submit landings". | source, docs |
| J24-6 | S2 | **Nothing a model reads says how to get Forge.** No install command is public (the CLI is built from source and unpublished; journey 1, J1-1), and the setup page waits for the package by the owner's decision. Until then the honest line is "not yet open; here is what exists", and `llms.txt` does not carry it. | docs |
| J24-7 | S2 | **The page title says "Source explorer".** That names one old feature. Search engines and models use the title first. | source |
| J24-8 | S2 | **No check keeps the agent-facing texts in step with the CLI.** The CLI help is generated from the command schemas; `llms.txt` rules and the skill are written by hand in a script and a Markdown file. J24-1 and J24-5 are the result. | source |
| J24-9 | S3 | **No sitemap and no per-task pages.** Models and search engines find `llms.txt` and raw Markdown files. The docs are organised by Forge's internals (operations, agents, research), not by a person's or agent's task. Issue b0cf7c38 covers this. | ran, docs |
| J24-10 | S3 | **The planned outside check has not been run.** Issue 00c3f715 asks that "one external LLM asked what is NanthAI Forge answers from them". Until it is, nobody knows what models say. | docs |

## Dead ends

- A model asked how to install Forge.
- An agent that read `llms.txt` and typed `nforge agent . tests '{}'`.

## Naming and tone

- `llms.txt` is honest in a way marketing rarely is: it lists a loss and a "not established" line. Keep that; update the figures.
- "NanthAI Forge", "NanthAi:Forge", "NanthAi Forge" and "Forge" all appear as the product name.

## What each persona needs

- **Agent, not person:** a start page of a few hundred tokens with the three verbs and the help command; references fetched per action, not in bulk; the same text in `llms.txt`, the skill, the MCP descriptions and the CLI help, generated from one source.
- **Person, not agent:** to ask their own assistant "what is Forge and should I use it?" and get a correct, current answer with the real limits; a docs site with one page per task.

## Decisions

- The canonical name is **NanthAI Forge**, or **Forge** for short. Describe it as source control built for many AI agents working at once. The approved positioning is parallel landings without breaking main, faster and cheaper than doing the same work on the comparison host. Treat that comparison as positioning, not evidence; support any public speed or cost claim with measured results (Items 7f207066 and 00c3f715).
- Generate the agent rules in `llms.txt` and the skill from the CLI contract. Say plainly that Forge is in beta (Item 00c3f715).

## Questions for the owner

- Which measurements does `llms.txt` carry: only the current benchmark with its losses, or history too?
- Is there a short `llms.txt` path for “getting started” separate from the full reference, with a stated token budget?
