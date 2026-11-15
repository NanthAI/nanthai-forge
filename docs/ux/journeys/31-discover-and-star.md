# Journey 31: discovering and starring projects

Finding public projects on Forge, judging whether one is alive, starring or liking it, and seeing what is popular or trending. Issue a0cf8c22 lists "discover projects; star or like a project" under community and open source. [Journey 16](16-outside-contributor.md) covers what an outsider can do once they have found a project.

Walked: the Home, project row, public imports and repository Home sources, `robots.txt`, the readable-URLs doc, the workflows doc (Home), the agents doc (public counts) and the open Issue b0ab4cd3. **Not walked:** a signed-out visit to a public project.

## Steps today

| # | Step | What exists | Evidence |
| --- | --- | --- | --- |
| 1 | Browse public projects | No explore, directory or trending page. Signed in, the Projects page lists only projects the account owns or was given, with filters "Yours, Shared with you, Starred and GitHub". | source, docs |
| 2 | "Recent public imports" | A list of read-only analyses of public GitHub repositories, each with "Source, license & access check" and "License not identified" where none was found. These are analyses, not Forge projects: "Read-only code analysis; no editable Forge project is created." | source |
| 3 | Search for a project | None across projects. ⌘K searches inside the current project. | docs |
| 4 | Arrive by link | `/HANDLE/PROJECT-SLUG`. Old names keep working: "Handle changed. Old links still work." A missing and a forbidden project "both return null and render Project not found". | docs |
| 5 | Arrive by search engine | `robots.txt` disallows every app and project URL "so crawler traffic does not trigger project reads". Public projects are not indexed. | ran |
| 6 | Judge whether it is alive | Public counts: five numbers (active agents, subagents, people, Lanes, unannounced Lanes) "never names, actors, credentials, paths, Lane or session ids". An optional repository Home page from `.nforge/home.md` ("Add .nforge/home.md to your repository to provide an optional Home page. README and source exploration remain available."). | docs, source |
| 7 | Star it | A star on the row: "Star in this browser". "Hosted-project stars are stored per account in the current browser." "Could not save this star in your browser." No count is shown to anyone. | source, docs |
| 8 | Follow or watch it | Nothing. An "interests" feature exists for analysis imports ("personal saved views and interests"). | source |
| 9 | A person's profile | The handle is the first part of the URL. No profile page listing a person's public projects was found. | docs |
| 10 | An agent discovering projects | No read lists public projects. | ran: help |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J31-1 | S1 | **A public project can be reached only by someone who already has its link.** No directory, no search, no profile, and search engines are told to stay out. For an open-source host this removes the reason to be public: nobody new arrives. | source, ran, docs |
| J31-2 | S2 | **A star is a private bookmark.** It lives in one browser, is not counted and tells the owner nothing. People from GitHub read a star as a public signal; here it is closer to a browser favourite, and it is lost with the browser's data. | source, docs |
| J31-3 | S2 | **Crawling is blocked for cost, with no cheap public surface in its place.** The rule exists so that crawlers do not cause backend reads. The planned answer is public reads served from storage through a cache (open Issue 6a60e89a). Until then a public project has no indexable page. | ran, docs |
| J31-4 | S2 | **The one public list shows the wrong thing.** "Recent public imports" lists analyses of GitHub repositories, which look like projects and are not editable Forge projects (journey 1, J1-10). A visitor's first impression of "what is on Forge" is other people's GitHub repositories. | source |
| J31-5 | S2 | **Forge's best public signal is unused.** A project page can honestly show live work: agents active now, landings this week, time to main, a green main. GitHub cannot show those. Today the public counts are five bare numbers, and landings per week or main's health are not public facts anywhere. | docs |
| J31-6 | S3 | **"Project not found" for both missing and private.** Correct for privacy. A person following a link to a private project they should have access to gets no hint to sign in or ask. | docs |
| J31-7 | S3 | **No trending is possible without a signal.** Trending needs counted stars, landings or visitors per project. None is collected publicly; [journey 23](23-stats-and-savings.md) covers what is and is not measured. | docs |

## Dead ends

- "Show me interesting projects on Forge."
- "Who starred my project?"
- Following a project for news.

## Naming and tone

- Project (editable), import and analysis (read-only), repository, source. The Projects page mixes them.
- "Star in this browser" is honest about what the star is.

## What each persona needs

- **Agent, not person:** a way to find a project by name when asked "contribute to X on Forge".
- **Person, not agent:** a public page per project that a search engine can read; a list to browse; a star that follows their account and that owners can see; a profile.

## Approved direction (group I)

These owner decisions guide the P7 spec; the steps and findings above describe the implementation observed.

- **I42:** Read state is kept per account so web, phone and CLI agree.

## Questions for the owner

1. Is there an explore page at the beta, and what orders it: recent landings, stars, or curated?
2. **Answered in group I:** Read state, including stars, is per account (I42); public counts and discovery remain open (question 73).
3. What does a signed-out visitor see on a public project page, and is it served so crawlers may index it?
4. Which live facts may a public project show: agents active, landings per week, time to main, main green?
5. Are profiles (a person's public projects) in the beta?
6. Does "Recent public imports" stay on the public surface?
