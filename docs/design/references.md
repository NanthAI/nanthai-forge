# Visual and design references

Status: a **catalog of outside inspiration for the landing page and launch visuals, plus Forge's own translation of each idea.** It is not a design decision, not an approved direction and not a licence review. Nothing here ships. [DESIGN.md](../../DESIGN.md) stays the visual authority, and the [tentative landing study](landing-study/README.md) and the [roadmap](../roadmap.md) ("Landing page redesign (tentative)") say how this feeds the Phase 7 page.

Rules for using this page:

- **Links only.** No third-party screenshot, image, font file or code is vendored in this repository. Where the owner kept a screenshot privately, it stays private; the link below is the primary source.
- **Licences are as originally noted and unchecked.** "MIT", "Apache 2.0" and "no licence" below come from notes taken in late October 2026. Re-read the repository's licence file before reusing anything, and add the required notice to `THIRD_PARTY_NOTICES.txt` if code or a font is adopted.
- **Credit the author** of anything adopted. Where a primary post URL was not recorded, credit is marked *pending* rather than guessed.
- **Constraints for any animated element** (from [principles](../principles.md) and DESIGN.md): client-only, paused when the tab is hidden or offscreen, honours reduced motion, loaded after first paint, and costs **zero** Convex calls, including at idle.
- **Claims on the page come from published results**, not from these references. Use measured figures such as the [B1.5d report](../research/b15d-report.md) (time to main per task 24–35% lower than Git and GitHub at N = 1, 3, 5 and 10, with wall time mixed at higher N) and [why-forge](../why-forge.md). Do not write "never red" or "zero rebases" copy; neither is established.

## Landing style references

| Reference | What is distinctive | Forge translation |
|---|---|---|
| [daoho.dev](https://www.daoho.dev) | One signature generative element tied to a metaphor (a canvas pond with koi behind the page), a warm paper background with near-black ink, an editorial serif with Inter and a mono face, a poetic one-line epigraph, great restraint. | Do not copy the look. Find Forge's own signature: one living element that is the product's metaphor, for example Lanes flowing and joining `main` (the Now "river of work" canvas), or heat and sparks as changes land, plus a distinct type and colour voice. |
| [nusretuzman.com](https://nusretuzman.com/) | A personal, lowercase voice, a single stacked column with minimal navigation, work shown as real visuals instead of case-study text, a small logo mark as signature. | Show the product as real screens; keep the layout simple and stacked; avoid a feature grid of icon squares (DESIGN.md already warns against it). |
| Frosted walkers (demo video on nusretuzman.com; screenshots kept privately) | On a white page, people walk on a frosted-glass floor **seen from below**: each sole touching the glass is a sharp dark oval, and the legs above blur and fade into the frost. Small mono labels in corner-bracket reticles track some walkers. They circle a crisp, still profile card. The blur is grainy and dithered, a little pixel-art. | Agents as walkers on the glass: their steps (saves) sharp where they touch, their paths fading behind them, each tagged with a small reticle label (agent name or Lane), converging on `main`, with the product card or a terminal crisp in the middle. Client-only canvas or shader, reduced-motion fallback. |
| [traddmccorkle/claude-code-water](https://github.com/traddmccorkle/claude-code-water) | A WebGL recreation of a "digital water" effect: a fixed field of monospace characters with grey currents and blue ripples; click drops ripples. Plain `waves.js` and canvas, no build. Noted as MIT (code) with an OFL mono font. | A ripple when a change lands on `main`. Check the licence file first. |
| [stackedlol/ascii-sharks](https://github.com/stackedlol/ascii-sharks) | Fish and sharks drawn as ASCII on a canvas: TypeScript, no runtime dependencies, a world simulation, a renderer, a React wrapper. Noted as MIT. | A possible base for the walkers: the simulation moves them and the renderer gives the dithered texture. Lazy-load after first paint. Keep its copyright and licence notice if code is adapted. |
| [0kzh/glisse](https://github.com/0kzh/glisse) (docs: glisse.kelvinzhang.ca) | A web implementation of Apple's iOS 26 "Liquid Glass" as React components. Noted as MIT and very young. | Kept "just in case" for the frosted-glass surface or glass controls. Before use: check bundle size, browser support (backdrop filters and SVG filters are heavy on low-end devices) and fit with DESIGN.md. |
| ascii-magic.com and bencho.dev | ASCII and particle micro-interactions (for example an "ascii-wake" effect). | Part of one ASCII/terminal art-direction pack. No licence reviewed. |
| Obel Mono (Typographic Systems) | A mono/display typeface candidate for the same pack. Primary link not recorded. | Candidate only. **Do not add the font file** until its licence is checked and an owner decision adopts it. |

## Ember "Twenty ways to answer: what now?"

Source: posts by @NoemiTitarenco about the Ember agent-session app (primary URLs not recorded; credit pending). The reference screens are **ideas only, not to copy**, and third-party screenshots stay private.

The method is the part worth keeping: produce N variants of one screen, write for each *Good at / Weak at / Keep / Fold in*, then fold the best parts into one design. Use it for any Now redesign.

Forge translations:

- **Since you left**: a one-sentence headline assembled from the activity log, never written by a model, so it is accurate by construction and costs no model tokens. For example: "4 landed, 1 check failed (cause), 2 Lanes now overlap".
- **Swimlanes**: Lanes over time converging into `main`; hatching means waiting on you or waiting in the queue. This is Forge's natural picture of parallel work landing.
- **Blocked path**: a stuck landing traces to its cause (for example every check dying on one server error).
- **Inbox**: act in place (accept, answer an overlap, retry); done clears the row.
- **Colour only for state.**
- **Not for Forge users: a ledger or any money view.** Users' costs (their runners, agent spend) differ and Forge cannot see them. Forge's own hosting cost is tracked internally; the user interface shows no money.

## Hook and market signals (outside material, unverified)

- **Hook idea.** "Git is easy until two people have ideas at the same time." It reached the owner as a repost of someone else's LinkedIn meme; the primary post and author are not recorded, so credit is pending. Do not reuse the image: make an original version, or quote and credit the original.
- **"A frontier lab replaced Git" (Scion).** A second-hand LinkedIn post claimed a lab built its own version control and moved a monorepo off Git, citing growth in daily merges, history size and checkout volume. Treat every figure as **unverified**. Only the daily-merge growth has since been matched to a primary source (an Anthropic engineering post on code review, roughly 2,500 to more than 30,000 landed changes a day, May to September). Quote that source, not the LinkedIn post, and leave the other figures out until a primary source exists. The thesis matches Forge's: agents never go offline, so source control should not assume they do.
- **Ideas to relate to Forge's own results**: merge throughput per day and checkout cost, expressed through the published measurements only.

## Design tooling

| Tool | Use | Caution |
|---|---|---|
| [langchain-ai/design-agent](https://github.com/langchain-ai/design-agent) | An open-source design agent with about 35 skills for stills, decks, diagrams, charts and motion graphics. Noted as Apache 2.0. | Running it as a hosted agent costs model and hosting money. Prefer using its skills inside the coding agent already in use. Rendering needs a container sandbox that may not be available locally. |
| [heydamir/unslop](https://github.com/heydamir/unslop) | A skill that audits an AI-looking interface and runs passes on spacing, colour, icons, copy, type, layout, details, visuals and motion. | Noted as having **no licence**. Use it only as a reference or a local personal skill. **Never vendor its code or text into this repository.** |
| Landing-page-design skill trial | See the [landing study](landing-study/README.md). | Tentative only; the proposal to narrow its trigger is not a rule. |

## What was left out

Private screenshots and attachment identifiers, the owner's file locations, session and attachment ids, and any claim that Forge is "never red" or has "zero rebases". Third-party images are not published here and are not licensed for reuse by this catalog.
