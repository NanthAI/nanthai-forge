// SPDX-License-Identifier: Apache-2.0
// `history log` on a project with no imported Git history (Item 3968a655): one file's landings on main, the same
// bounded window the web's file history reads (projectCode:fileHistory). One query per page, no polling.
import { createHash } from 'node:crypto';
import { ForgeError, invariant } from './errors.js';
import { landedBy, type CodeFileHistoryPage } from './code-history.js';

type LogCommand = {
  path?: string | undefined;
  commit?: string | undefined;
  skip: number;
  cursor?: string | undefined;
};
type Reader = { query<T>(name: string, args: Record<string, unknown>): Promise<T> };

/** A cursor names the landing it resumes before and is bound to its project and path, so it cannot continue
 * another file's log or switch an imported project out of its Git log. */
const binding = (projectId: string, path: string) =>
  createHash('sha256').update(`${projectId}\0${path}`).digest('hex').slice(0, 8);

/** The server's refusal for a project that never imported Git history (projectHistoryRead:open). */
export function noImportedHistory(error: unknown) {
  const code =
    error instanceof ForgeError ? error.code : (error as { data?: { code?: unknown } } | null)?.data?.code;
  return code === 'HISTORY_UNAVAILABLE';
}

export async function landingHistory(transport: Reader, projectId: string, command: LogCommand) {
  if (!command.path)
    throw new ForgeError(
      'HISTORY_UNAVAILABLE',
      'This project has no imported Git history, so there is no commit log. For one file\'s landings use history {"op":"log","path":"FILE"}; for every landing use landings {"from":"…","to":"…"}.',
    );
  invariant(
    command.commit === undefined && command.skip === 0,
    'BAD_ARGUMENT',
    'This project has no imported Git history: its file log lists landings and continues with cursor (the previous nextCursor), not commit or skip.',
  );
  const bound = binding(projectId, command.path);
  const [before, cursorBinding] = command.cursor?.split('.') ?? [];
  invariant(
    command.cursor === undefined || cursorBinding === bound,
    'BAD_ARGUMENT',
    'This cursor continues another project or path; pass the nextCursor of this file log.',
  );
  const page = await transport.query<CodeFileHistoryPage>('projectCode:fileHistory', {
    path: command.path,
    before: before === undefined ? null : Number(before),
  });
  return {
    readMode: 'landings',
    path: command.path,
    entries: page.landings.map(row => ({
      at: row.at,
      title: row.title,
      by: landedBy(row),
      receiptId: row.receiptId,
      state: row.head,
    })),
    matched: page.landings.length,
    examined: page.scanned ?? null,
    unknown: page.missing,
    more: page.nextBefore !== null,
    nextCursor: page.nextBefore === null ? null : `${page.nextBefore}.${bound}`,
    note: 'No imported Git history: the landings on main that changed this file, newest first, at most 8 per page as the web shows them (limit applies to Git logs only). examined counts the receipts checked for this page (unknown: their changed paths were not kept). Continue with cursor:nextCursor; a page can be empty and still continue.',
  };
}
