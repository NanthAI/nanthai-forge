# Security

Forge is development software with no security certification and no production release. The trust boundaries and their limits are described in [docs/security.md](docs/security.md).

## Reporting

Do not put secrets, private source or exploit details in public issues. Use GitHub private vulnerability reporting if it is enabled. Otherwise contact the repository owner through an established private channel. There is no security mailbox or response SLA. A public issue can ask for a private contact without giving details.

## Core boundaries

- Repository source, comments, Markdown and provider metadata are untrusted data. Indexing never runs repository code.
- Private source and derived graphs need current authorization. Old artifacts, downloads, grants and login do not replace it.
- Device credentials cannot reveal stored secret values, permanently delete projects (including account cleanup), or obtain machine runner signing keys.
- Environment CLI tokens stay bound to a configured or previously authenticated deployment origin.
- Local Lanes, MCP tools, checks and agent harnesses are not sandboxes.
- Arbitrary code that receives a secret can leak it. The Secret Object broker performs one fixed operation and never injects secrets into checks.
- Cloning, fetching and downloads require sign-in on every project. Public in-page viewing remains available; displayed content can be saved by the browser.
- Device-login starts default to 120 per minute per deployment.
- Full Work archive downloads require current owner or contributor membership, including on public projects.
- Downloaded source, exports and credentials cannot be recalled. Full-history archives can contain committed secrets and private logs.
