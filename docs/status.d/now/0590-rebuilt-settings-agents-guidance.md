Rebuilt Settings → Agents reads and edits agent guidance at `/:handle/:project/settings/agents`.
One read of `agentGuidance.read` per page open; each save is one retry-safe `agentGuidance.set` that keeps its
operation id until it succeeds. The project text is editable by the owner or an assigned guidance maintainer
(the server decides, as before) and read-only for everyone else; the "just for me" text is the viewer's own.
Source Zones, the old submodule pointer list, contributions, the code map and interests are not rebuilt.
