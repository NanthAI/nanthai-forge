const checkLogModules = Object.fromEntries(
  await Promise.all(
    [
      'projectCheckLogRetentionActions',
      'projectCheckLogRetention',
      'projectCheckLogCleanup',
      'projectCheckLogCleanupStore',
      'projectHostedLogCleanupStore',
    ].map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))]),
  ),
);
const projectR2Backfill = await import(moduleUrl('../convex/projectR2Backfill.ts'));
const inventoryAccess = await import(moduleUrl('../convex/inventoryAccess.ts'));
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { checkDocument, insertedDocument, updatedDocument } from './convex-args.mjs';
import { validateContext } from './convex-context.mjs';
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const artifactStorage = await import(moduleUrl('../convex/artifactStorage.ts'));
const projectExchangeCache = await import(moduleUrl('../convex/projectExchangeCache.ts'));
const derivedArtifacts = await import(moduleUrl('../convex/derivedArtifacts.ts'));
const imports = await import(moduleUrl('../convex/imports.ts'));
const lifecycle = await import(moduleUrl('../convex/lifecycle.ts'));
const sync = await import(moduleUrl('../convex/sync.ts'));
const sharing = await import(moduleUrl('../convex/sharing.ts'));
const savedViews = await import(moduleUrl('../convex/savedViews.ts'));
const teams = await import(moduleUrl('../convex/teams.ts'));
const secretLifecycle = await import(moduleUrl('../convex/secretLifecycle.ts'));
const secrets = await import(moduleUrl('../convex/secrets.ts'));
const agentGrants = await import(moduleUrl('../convex/agentGrants.ts'));
const interests = await import(moduleUrl('../convex/interests.ts'));
const sourceZones = await import(moduleUrl('../convex/sourceZones.ts'));
const accountActions = await import(moduleUrl('../convex/accountActions.ts'));
const accountResources = await import(moduleUrl('../convex/accountResources.ts'));
const accountPlan = await import(moduleUrl('../convex/accountPlan.ts'));
const accountExecute = await import(moduleUrl('../convex/accountExecute.ts'));
const teamLifecycle = await import(moduleUrl('../convex/teamLifecycle.ts'));
const projectPublicationStore = await import(moduleUrl('../convex/projectPublicationStore.ts'));
const projectLifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
const r2ArchiveSource = await import(moduleUrl('../convex/r2ArchiveSource.ts'));
const projectActorNames = await import(moduleUrl('../convex/projectActorNames.ts'));
const projectWorkIndexStore = await import(moduleUrl('../convex/projectWorkIndexStore.ts'));
const projectWorkIndex = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const projectWorkAncestry = await import(moduleUrl('../convex/projectWorkAncestry.ts'));
const projectWorkIndexBuildFailure = await import(moduleUrl('../convex/projectWorkIndexBuildFailure.ts'));
const projectWorkIndexBuildStore = await import(moduleUrl('../convex/projectWorkIndexBuildStore.ts'));
const projectWorkIndexActions = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
export const job = (id = 'own') => ({
  _id: id,
  _creationTime: 1,
  scope: 'owner',
  owner: 'owner',
  repository: 'example/project',
  ref: 'main',
  visibility: 'private',
  phase: 'ready',
  processed: 2,
  total: 2,
  generation: 1,
  head: 'a'.repeat(40),
  artifactKey: 'saved',
});

const field = (row, key) =>
  key.includes('.') ? key.split('.').reduce((value, part) => value?.[part], row) : row?.[key];
const indexes = new Map();
/** Index fields come from convex/schema.ts, so a query on a missing index fails here too. */
function indexFields(table, index) {
  if (index === 'by_creation_time') return ['_creationTime', '_id'];
  if (index === 'by_id') return ['_id'];
  if (!indexes.has(table)) indexes.set(table, schema.tables[table]?.export().indexes ?? []);
  const found = indexes.get(table).find(item => item.indexDescriptor === index);
  if (!found) throw new Error(`Index ${table}.${index} is not defined in convex/schema.ts.`);
  // Every provider index key ends with implicit _creationTime and _id.
  return [...found.fields, '_creationTime', '_id'];
}

export function state(jobs = [job()], { keysetPaging = false } = {}) {
  const tables = {
    ownerAcceptanceMachines: new Map(),
    forgeAccounts: new Map(),
    accountHandles: new Map(),
    projectSlugs: new Map(),
    handleOperations: new Map(),
    cliCredentials: new Map(),
    agentGuidanceMaintainerOperations: new Map(),
    agentUserSettings: new Map(),
    agentGuidanceOperations: new Map(),
    projectBriefingSources: new Map(),
    projectPolicyChanges: new Map(),
    projectCheckRunners: new Map(),
    projectCheckRequests: new Map(),
    projectWorkHeads: new Map(),
    projectHostedChannels: new Map(),
    projectSourceCutovers: new Map(),
    projectWorkDetailMigrations: new Map(),
    projectRecoveryConnections: new Map(),
    projectWorkGenerations: new Map(),
    projectWorkRecords: new Map(),
    projectObjects: new Map(),
    projectCheckLogSourcePins: new Map(),
    projectCheckLogRetentions: new Map(),
    projectCheckLogCleanups: new Map(),
    projectCheckLogCleanupPages: new Map(),
    projectHostedOutputSummaries: new Map(),
    projectPublications: new Map(),
    projectPublicationAttempts: new Map(),
    projectPublicationPages: new Map(),
    projectReturnPages: new Map(),
    projectReturnSupersessions: new Map(),
    projectGithubImports: new Map(),
    projectGithubImportInventory: new Map(),
    projectCoordinationSessions: new Map(),
    projectActorNames: new Map(),
    projectCoordinationEvents: new Map(),
    projectCoordinationReceipts: new Map(),
    projectCoordinationClaims: new Map(),
    derivedArtifacts: new Map(),
    artifactBlobs: new Map(),
    accountOperations: new Map(),
    accountItems: new Map(),
    hostedProjects: new Map(),
    projectBackups: new Map(),
    projectProposals: new Map(),
    projectContributors: new Map(),
    projectReaders: new Map(),
    projectReaderOperations: new Map(),
    projectWorkEvents: new Map(),
    projectUploadCleanup: new Map(),
    imports: new Map(jobs.map(row => [row._id, { ...row }])),
    importArtifacts: new Map(),
    importRemovalOperations: new Map(),
    importReaders: new Map(),
    savedViews: new Map(),
    teams: new Map(),
    teamMembers: new Map(),
    teamImports: new Map(),
    secretDeletions: new Map(),
    secretObjects: new Map(),
    secretVersions: new Map(),
    secretGrants: new Map(),
    secretEvents: new Map(),
    agentGrants: new Map(),
    agentEvents: new Map(),
    sourceZones: new Map(),
    zoneReaders: new Map(),
    zoneChanges: new Map(),
    projectInterests: new Map(),
    interestChanges: new Map(),
  };
  const files = new Map(),
    tasks = new Map(),
    scheduled = [],
    deleted = [];
  let caller = 'owner',
    reads = 0,
    count = 0,
    creationClock = Date.now();
  const find = id =>
    Object.values(tables)
      .map(table => table.get(id))
      .find(Boolean) ?? null;
  // A mutation's writes and scheduled work are undone when it throws, like a provider
  // transaction. Interleaved async mutations are not isolated from each other (no OCC).
  const transactions = new AsyncLocalStorage();
  const remember = undo => transactions.getStore()?.push(undo);
  const restorable = id => {
    for (const table of Object.values(tables))
      if (table.has(id)) {
        const before = structuredClone(table.get(id));
        remember(() => table.set(id, before));
        return;
      }
  };
  const transaction = async run => {
    const undo = [],
      parent = transactions.getStore();
    try {
      const result = await transactions.run(undo, run);
      parent?.push(...undo);
      return result;
    } catch (error) {
      for (const step of undo.reverse()) step();
      throw error;
    }
  };
  const schedule = task => {
    const entry = { ...task, id: `task-${scheduled.length}` };
    scheduled.push(entry);
    tasks.set(entry.id, { state: { kind: 'pending' } });
    remember(() => {
      scheduled.splice(scheduled.indexOf(entry), 1);
      tasks.delete(entry.id);
    });
    return entry.id;
  };
  const ctx = validateContext({
    auth: { getUserIdentity: async () => (caller ? { subject: caller } : null) },
    db: {
      normalizeId: (table, id) => (find(id) && !tables[table].has(id) ? null : id),
      get: async id => structuredClone(find(id)),
      system: {
        get: async id => structuredClone(tasks.get(id) ?? files.get(id)?.metadata ?? null),
        query: () => ({
          order: () => ({
            paginate: async ({ cursor, numItems }) => {
              const rows = [...files]
                .filter(([, f]) => f.metadata)
                .map(([id, f]) => ({ ...f.metadata, _id: id }))
                .sort((a, b) => b._id.localeCompare(a._id));
              const start = Number(cursor ?? 0);
              return {
                page: rows.slice(start, start + numItems),
                isDone: start + numItems >= rows.length,
                continueCursor: String(start + numItems),
              };
            },
          }),
        }),
      },
      insert: async (table, row) => {
        const id = `row-${count++}`;
        tables[table].set(
          id,
          insertedDocument(
            schema,
            table,
            row,
            id,
            (creationClock = Math.max(Date.now(), creationClock + 0.01)),
          ),
        );
        remember(() => tables[table].delete(id));
        return id;
      },
      replace: async (id, values) => {
        const table = Object.keys(tables).find(table => tables[table].has(id));
        const row = checkDocument(schema, table, updatedDocument(find(id), values, true));
        restorable(id);
        const current = find(id);
        for (const key of Object.keys(current)) delete current[key];
        Object.assign(current, row);
      },
      patch: async (id, values) => {
        const table = Object.keys(tables).find(table => tables[table].has(id));
        const row = checkDocument(schema, table, updatedDocument(find(id), values));
        restorable(id);
        const current = find(id);
        for (const [key, value] of Object.entries(values)) {
          if (value === undefined) delete current[key];
          else current[key] = row[key];
        }
      },
      delete: async id => {
        restorable(id);
        for (const table of Object.values(tables)) table.delete(id);
      },
      query: table => {
        const matches = new Map();
        let fields = [],
          direction = 1;
        const lower = new Map(),
          upper = new Map(),
          bounds = [];
        const rows = () => {
          const equal = [...matches].reverse(),
            low = [...lower],
            high = [...upper],
            keys = [...fields, '_creationTime', ...(table === 'projectCoordinationEvents' ? ['_id'] : [])];
          return [...tables[table].values()]
            .filter(
              row =>
                equal.every(([key, value]) => field(row, key) === value) &&
                low.every(([key, value]) => row[key] > value) &&
                high.every(([key, value]) => row[key] <= value) &&
                bounds.every(test => test(row)),
            )
            .sort((a, b) => {
              for (const key of keys) {
                const x = field(a, key),
                  y = field(b, key);
                if (x !== y) return direction * (x < y ? -1 : 1);
              }
              return 0;
            });
        };
        // Sort references, then copy only returned documents. Provider callers still
        // receive detached values; a one-row lookup need not clone the whole table.
        const copy = rows => rows.map(row => structuredClone(row));
        const query = {
          withIndex: (index, build) => {
            const indexed = indexFields(table, index);
            fields = indexed.filter(name => name !== '_creationTime' && name !== '_id');
            // Provider rule: equalities follow the index key, then at most one lower
            // and one upper bound on the next field.
            let next = 0,
              ranged = null;
            const sides = new Set(),
              step = (kind, key) => {
                const side = kind === 'eq' ? null : kind.startsWith('g') ? 'lower' : 'upper';
                const valid =
                  key === indexed[next] &&
                  (side ? !sides.has(side) && (ranged === null || ranged === key) : ranged === null);
                if (!valid)
                  throw new Error(`Invalid range on ${table}.${index}: ${kind}(${key}) after [${indexed}].`);
                if (side) {
                  sides.add(side);
                  ranged = key;
                } else next++;
              };
            const q = {
              eq: (key, value) => {
                step('eq', key);
                matches.set(key, value);
                return q;
              },
              gt: (key, value) => {
                step('gt', key);
                lower.set(key, value);
                return q;
              },
              lte: (key, value) => {
                step('lte', key);
                upper.set(key, value);
                return q;
              },
              gte: (key, value) => {
                step('gte', key);
                bounds.push(row => row[key] >= value);
                return q;
              },
              lt: (key, value) => {
                step('lt', key);
                bounds.push(row => row[key] < value);
                return q;
              },
            };
            build?.(q);
            return query;
          },
          order: value => {
            direction = value === 'desc' ? -1 : 1;
            return query;
          },
          take: async n => copy(rows().slice(0, n)),
          unique: async () => {
            const found = rows();
            if (found.length > 1) throw new Error(`unique() on ${table} matched ${found.length} documents.`);
            return structuredClone(found[0] ?? null);
          },
          paginate: async ({ cursor, numItems }) => {
            const all = rows();
            // Opt-in index-key cursor model for coordination pagination tests.
            // This models provider paging, not live OCC/subscription behavior.
            if (keysetPaging) {
              const after = cursor === null ? null : JSON.parse(cursor);
              const key = row => [...fields, '_creationTime', '_id'].map(field => row[field] ?? null);
              const compare = (left, right) =>
                left.map((value, i) => (value === right[i] ? 0 : value < right[i] ? -1 : 1)).find(Boolean) ??
                0;
              const remaining =
                after === null ? all : all.filter(row => direction * compare(key(row), after) > 0);
              const page = remaining.slice(0, numItems),
                last = page.at(-1);
              return {
                page: copy(page),
                isDone: remaining.length <= numItems,
                continueCursor: last ? JSON.stringify(key(last)) : (cursor ?? ''),
                pageStatus: null,
                splitCursor: null,
              };
            }
            const start = Number(cursor ?? 0);
            return {
              page: copy(all.slice(start, start + numItems)),
              isDone: start + numItems >= all.length,
              continueCursor: String(start + numItems),
              pageStatus: null,
              splitCursor: null,
            };
          },
        };
        query[Symbol.asyncIterator] = async function* () {
          yield* copy(rows());
        };
        return query;
      },
    },
    scheduler: {
      runAt: async (at, fn, args) => schedule({ fn, args, at }),
      runAfter: async (_, fn, args) => schedule({ fn, args }),
      cancel: async id => {
        const before = tasks.get(id);
        remember(() => (before ? tasks.set(id, before) : tasks.delete(id)));
        tasks.set(id, { state: { kind: 'canceled' } });
      },
    },
    storage: {
      store: async blob => {
        const id = `file-${count++}`;
        files.set(id, {
          blob,
          metadata: {
            _id: id,
            size: blob.size,
            sha256: createHash('sha256')
              .update(new Uint8Array(await blob.arrayBuffer()))
              .digest('hex'),
            contentType: blob.type,
          },
        });
        return id;
      },
      get: async id => {
        reads++;
        return files.get(id)?.blob ?? null;
      },
      getMetadata: async id => {
        const file = files.get(id);
        return (
          file?.metadata ??
          (file && {
            size: file.blob.size,
            sha256: createHash('sha256')
              .update(new Uint8Array(await file.blob.arrayBuffer()))
              .digest('hex'),
          })
        );
      },
      getUrl: async id => {
        reads++;
        const file = files.get(id);
        if (!file) return null; // Node 22/23 blob: Range responses omit the inclusive final byte. This
        // fixture uses a stable range-less data response; dedicated HTTP fixtures
        // cover exact 206 ranges, length/header failures and bounded 200 streams.
        return (file.url ??= `data:${file.blob.type};base64,${Buffer.from(await file.blob.arrayBuffer()).toString('base64')}`);
      },
      delete: async id => {
        deleted.push(id);
        const file = files.get(id);
        if (file?.url) URL.revokeObjectURL(file.url);
        files.delete(id);
      },
    },
  });
  const modules = {
    ...checkLogModules,
    projectR2Backfill,
    r2ArchiveSource,
    projectPublicationStore,
    inventoryAccess,
    projectWorkIndexStore,
    projectWorkIndexBuildStore,
    projectWorkIndexBuildFailure,
    projectWorkAncestry,
    projectActorNames,
    projectWorkIndex,
    projectWorkIndexActions,
    derivedArtifacts,
    artifactStorage,
    projectExchangeCache,
    imports,
    lifecycle,
    sync,
    sharing,
    savedViews,
    teams,
    secrets,
    secretLifecycle,
    agentGrants,
    sourceZones,
    interests,
    accountActions,
    accountResources,
    accountPlan,
    accountExecute,
    teamLifecycle,
    projectLifecycle,
  };
  ctx.runAction =
    ctx.runQuery =
    ctx.runMutation =
      (fn, args) => {
        const [module, name] = getFunctionName(fn).split(':'),
          handler = modules[module][name];
        return handler.isMutation
          ? transaction(() => handler._handler(ctx, args))
          : handler._handler(ctx, args);
      };
  return {
    ctx,
    transaction,
    tables,
    files,
    tasks,
    scheduled,
    deleted,
    caller: value => {
      caller = value;
    },
    reads: () => reads,
    file: (id, blob) =>
      files.set(id, {
        blob,
        metadata: {
          size: blob.size,
          sha256: createHash('sha256').update(Buffer.alloc(blob.size, 'x')).digest('hex'),
          contentType: blob.type,
        },
      }),
  };
}

export function providers(revoked = () => false, privateRepository = true, head = 'a'.repeat(40)) {
  const previousFetch = globalThis.fetch,
    names = ['CLERK_SECRET_KEY', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET'],
    previous = names.map(name => process.env[name]);
  names.forEach(name => {
    process.env[name] = 'test';
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (
      url.protocol === 'blob:' ||
      url.protocol === 'data:' ||
      url.hostname.endsWith('.r2.cloudflarestorage.com')
    )
      return previousFetch(input, init);
    if (url.hostname === 'api.clerk.com') {
      const user = decodeURIComponent(url.pathname.split('/')[3]);
      return url.pathname.endsWith('/oauth_github')
        ? Response.json([{ token: `ghu_${user}` }])
        : Response.json({ id: user }, { status: user === 'missing' ? 404 : 200 });
    }
    if (url.pathname.startsWith('/applications/'))
      return Response.json({}, { status: revoked(JSON.parse(init.body).access_token.slice(4)) ? 404 : 200 });
    if (url.pathname.includes('/commits/')) return Response.json({ sha: head });
    return Response.json(
      {
        full_name: 'example/project',
        private: privateRepository,
        default_branch: 'main',
        html_url: 'https://github.com/example/project',
        license: null,
      },
      { status: !privateRepository || init.headers.Authorization ? 200 : 404 },
    );
  };
  return () => {
    globalThis.fetch = previousFetch;
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    });
  };
}
