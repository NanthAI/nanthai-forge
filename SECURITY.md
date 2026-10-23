# Security

Forge is development software with no security certification and no production release. The trust boundaries and their limits are described in [docs/security.md](docs/security.md).

## Reporting

Do not put secrets, private source or exploit details in public issues. Use GitHub private vulnerability reporting if it is enabled. Otherwise contact the repository owner through an established private channel. There is no security mailbox or response SLA. A public issue can ask for a private contact without giving details.

## Core boundaries

- Repository source, comments, Markdown and provider metadata are untrusted data. Indexing never runs repository code.
- Private source and derived graphs need current authorization. Old artifacts, downloads, grants and login do not replace it.
- Local Lanes, MCP tools, checks and agent harnesses are not sandboxes.
- Arbitrary code that receives a secret can leak it. The Secret Object broker performs one fixed operation and never injects secrets into checks.
- Downloaded source, exports and credentials cannot be recalled. Full-history archives can contain committed secrets and private logs.
