# Forge Convex backend

This is Forge's own Convex project, separate from Edge's. Setup, environment variables, the GitHub webhook, Clerk and the Netlify worker are documented in [development](../docs/development.md). To run the same schema on your own machine, see [operations](../docs/operations.md).

## Layout

- `schema.ts` defines the tables. Source and graph artifacts are gzip JSON files in Convex file storage, not database rows.
- `access.ts`, `projectAuthority.ts` and the grant and lifecycle modules decide who may read or write now.
- `projectWork*.ts` hold hosted Work events and the derived indexed generation.
- `projectBackup*.ts`, `projectObjects.ts` and `projectExchange*.ts` hold checkpoints and shared content.
- `projectCoordination.ts` holds sessions and messages.
- The GitHub webhook (`POST /github/webhook`) verifies its signature over the original bytes. It records diagnostics only and never changes an import or a ref.

## Rules for changes

- Functions never run target repository code.
- Check current access on every read and write, never on stored history.
- Keep schema changes additive. Deploy compatible readers before clients that use new fields.
- Browser code gets only `VITE_` variables. Backend secrets live in the Convex dashboard.
- Rollback keeps stored data. Do not drop ownership or lifecycle tables.
