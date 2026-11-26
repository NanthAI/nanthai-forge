On a receipt, **Read the code here** opens that landing's own diff: the files it changed, each folded open to its
hunks, unified or side by side, with **Browse the repo at this landing** as the next step. The first file opens at
once and each later file costs one signed describe and a storage download only when opened. A signed-out visitor of a
public project sees the file list and a link to each file at that landing; the diff itself needs a member.

Code in the Code reader, in landing diffs and on Lane pages is coloured by Pierre's `@pierre/highlights` (the engine
behind `@pierre/diffs`), loaded in the highlight worker the first time a file is coloured, with one design-system
palette in both themes. The language comes from the file name: TypeScript, JavaScript, JSX, TSX, JSON, JSONC, Markdown,
YAML, TOML, HTML, CSS, SCSS, shell, Python, Go, Rust, Java, Kotlin, Swift, C, C++, C#, Ruby, PHP, SQL, Dockerfile and
every other language Pierre's tables name. An unknown name, or a file over 1,000,000 characters, stays plain text.

A Markdown file opens as a document with a Source toggle. Raw HTML is dropped, links open only to http(s), mailto or
another file of the same State, and fenced code is coloured. Raster images from the same State load from storage
for a signed-in member as they scroll into view. SVGs and other unsupported images stay as text placeholders,
as do all images for signed-out visitors.
