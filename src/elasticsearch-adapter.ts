import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { Client, estypes } from "@elastic/elasticsearch";
import {
  type CleanedWhere,
  type DBAdapterDebugLogOption,
  createAdapterFactory,
} from "better-auth/adapters";
import type { BetterAuthDBSchema } from "better-auth/db";

import {
  isNotFound,
  isVersionConflict,
  isWriteBlocked,
  retryOnContention,
  wait,
  waitOutWriteBlock,
  withElasticsearchRetry,
  writeBlockWaiter,
} from "./elasticsearch-client.js";
import {
  ensureAliasedIndex,
  expectedMappings,
  expectedProperties,
  migrateAliasedIndex,
} from "./index-layout.js";
import { MIGRATOR, type MigratedModel, type Migrator } from "./migrate.js";
import {
  type DuplicateValues,
  createReservations,
  duplicateError,
} from "./unique-reservations.js";
import { whereToQuery } from "./where-to-query.js";

type Primitive = string | number | boolean | Date | null;
type SourceDoc = Record<
  string,
  Primitive | Primitive[] | Record<string, unknown>
>;

export interface ElasticsearchAdapterConfig {
  /** A client from `@elastic/elasticsearch` whose major matches the server. */
  client: Client;
  /** better-auth's adapter debug logging. Off by default. */
  debugLogs?: DBAdapterDebugLogOption;
  /**
   * Prepended to every alias and index name, as `<prefix>_<model>`. Lets
   * several apps or environments share one cluster.
   */
  indexPrefix?: string;
  /**
   * How often a request that failed for a transient reason (a timeout, a
   * dropped connection, a 429 or 5xx response) is retried, with exponential
   * backoff (default 3).
   */
  maxRetries?: number;
  /**
   * When a write becomes searchable. "immediate" (the default) refreshes the
   * index on every write, so the next request finds the row. "wait_for" waits
   * for Elasticsearch's next scheduled refresh instead: slower writes, less
   * load on the cluster. `deleteMany` is a by-query write and always
   * refreshes immediately, as Elasticsearch cannot make those wait.
   */
  refresh?: "immediate" | "wait_for";
  /**
   * How long, in milliseconds, a write waits while migrate() moves its model
   * to a new index (default 30000). Writes meeting the old index's write block
   * try again until the move is done; after this long they fail.
   */
  writeBlockTimeoutMs?: number;
  /** Primary shards of each index the adapter creates (default 1). */
  numberOfShards?: number;
  /** Replicas of each index the adapter creates (default 0). */
  numberOfReplicas?: number;
  /**
   * Unique fields left unenforced, as `"model.field"` in better-auth schema
   * names, or `"model.fieldA+fieldB"` for a unique index over several fields,
   * in index order (default `["session.token"]`: the token is random, and
   * reserving it would slow every sign-in). A list given here replaces the
   * default, so include `"session.token"` to keep skipping it. Every other
   * field the schema declares unique, and every unique index, gets a
   * reservation per value, which costs an extra request per write that sets
   * or frees one.
   */
  skipUniqueFor?: string[];
}

/**
 * How often a single-row atomic write searches again after losing a race.
 * Each lost race means another request's write went through, so this bounds
 * the number of simultaneous writers to one row the adapter rides out.
 */
const MAX_ATOMIC_ATTEMPTS = 50;

/**
 * How often `updateMany` and `deleteMany` go again while rows change under
 * them. Each pass writes every row that did not change mid-pass, so the next
 * one only has the few rows that did left to write.
 */
const MAX_MANY_PASSES = 5;

// Applies `params.increment` as deltas (a missing counter counts as 0), then
// assigns `params.set`.
const INCREMENT_SCRIPT = `
for (entry in params.increment.entrySet()) {
  def current = ctx._source[entry.getKey()];
  ctx._source[entry.getKey()] = (current == null ? 0 : current) + entry.getValue();
}
for (entry in params.set.entrySet()) {
  ctx._source[entry.getKey()] = entry.getValue();
}`;

// Assigns `params.fields`, replacing each value whole. A partial-document
// update would merge JSON values into the stored ones instead.
const SET_FIELDS_SCRIPT = `
for (entry in params.fields.entrySet()) {
  ctx._source[entry.getKey()] = entry.getValue();
}`;

/** How many rows `updateMany` reads and writes per request. */
const UPDATE_MANY_PAGE_SIZE = 1000;

/** How many rows a by-query delete removed before Elasticsearch refused it. */
const deletedBefore = (error: unknown): number =>
  (error as { meta?: { body?: { deleted?: number } } }).meta?.body?.deleted ??
  0;

/** A row as better-auth expects it: the stored fields, with `id` set. */
const normalizeHit = (hit: {
  _id?: string;
  _source?: SourceDoc;
}): SourceDoc => {
  const source = hit._source ?? {};
  return { ...source, id: source.id ?? hit._id ?? null };
};

/**
 * A better-auth database adapter that stores each model in Elasticsearch,
 * behind an alias over a versioned index with mappings derived from the
 * better-auth schema. Pass the result as `database` to `betterAuth()`.
 */
export const elasticsearchAdapter = (
  config: ElasticsearchAdapterConfig,
): ReturnType<typeof createAdapterFactory> => {
  const prefix = config.indexPrefix ?? "";
  const maxRetries = config.maxRetries ?? 3;
  const refresh = config.refresh === "wait_for" ? "wait_for" : true;
  const writeBlockTimeoutMs = config.writeBlockTimeoutMs ?? 30_000;
  const indexSettings = {
    numberOfShards: config.numberOfShards ?? 1,
    numberOfReplicas: config.numberOfReplicas ?? 0,
  };

  const adapter = createAdapterFactory({
    config: {
      adapterId: "elasticsearch-adapter",
      adapterName: "Elasticsearch Adapter",
      usePlural: false,
      debugLogs: config.debugLogs ?? false,
      supportsJSON: true,
      // Elasticsearch returns dates as strings; the factory converts them back.
      supportsDates: false,
      supportsBooleans: true,
      supportsNumericIds: false,
      transaction: false,
    },
    adapter: ({ schema, getFieldName, getDefaultModelName }) => {
      const client = config.client;

      const withRetry = <T>(operation: () => Promise<T>) =>
        withElasticsearchRetry(operation, maxRetries);

      const whileMigrating = <T>(index: string, operation: () => Promise<T>) =>
        waitOutWriteBlock(writeBlockTimeoutMs, index, operation);

      const reservations = createReservations({
        client,
        schema,
        getDefaultModelName,
        skipUniqueFor: config.skipUniqueFor ?? ["session.token"],
        settings: indexSettings,
        withRetry,
      });

      // Elasticsearch index and alias names must be lowercase.
      const indexForModel = (model: string) =>
        (prefix ? `${prefix}_${model}` : model).toLowerCase();

      // One first-use check per model and process. A failed check is
      // forgotten so the next call tries again.
      const ready = new Map<string, Promise<void>>();

      /**
       * The alias for a model, after making sure it exists with the mapping
       * the schema needs. `model` is the database model name the factory
       * passes, so a custom `modelName` names the alias.
       */
      const ensureAlias = async (model: string) => {
        const alias = indexForModel(model);
        let check = ready.get(alias);
        if (!check) {
          check = withRetry(() =>
            ensureAliasedIndex(
              client,
              alias,
              expectedProperties(schema, getDefaultModelName(model)),
              indexSettings,
            ),
          );
          ready.set(alias, check);
          check.catch(() => ready.delete(alias));
        }
        await check;
        return alias;
      };

      // One model at a time, so a failure leaves the rest untouched.
      const migrator: Migrator = async ({
        deleteOldIndices,
        oldIndexGraceMs,
      }) => {
        const migrated: MigratedModel[] = [];
        for (const [model, table] of Object.entries(schema)) {
          const result = await migrateAliasedIndex(
            client,
            indexForModel(table.modelName),
            expectedProperties(schema, model),
            indexSettings,
          );
          if (result) migrated.push({ model, ...result, fromDeleted: false });
        }
        if (deleteOldIndices && migrated.length > 0) {
          // A write that read a row just before a swap is still aimed at the
          // old index. While that exists the write meets its block and reads
          // again; deleted, Elasticsearch would create it anew, empty.
          await wait(oldIndexGraceMs);
          for (const entry of migrated) {
            await withRetry(() => client.indices.delete({ index: entry.from }));
            entry.fromDeleted = true;
          }
        }
        // Every run, so rows written before their model had reservations, or
        // while a field was in `skipUniqueFor`, get them.
        const duplicates: DuplicateValues[] = [];
        for (const [model, table] of Object.entries(schema)) {
          duplicates.push(
            ...(await reservations.backfill(
              model,
              indexForModel(table.modelName),
            )),
          );
        }
        return { migrated, duplicates };
      };

      /**
       * For `npx auth generate`: the mappings each model's index is created
       * with, as JSON for review. Nothing reads the file back.
       */
      const createSchema = async ({
        file,
        tables,
      }: {
        file?: string;
        tables: BetterAuthDBSchema;
      }) => {
        const models = Object.fromEntries(
          Object.entries(tables).map(([model, table]) => [
            model,
            {
              alias: indexForModel(table.modelName),
              mappings: expectedMappings(expectedProperties(tables, model)),
            },
          ]),
        );
        return {
          code: `${JSON.stringify(models, null, 2)}\n`,
          path: file ?? "elasticsearch-mappings.json",
          overwrite: true,
        };
      };

      // The factory passes `select` with schema field names; the document
      // stores them under their database names.
      const sourceFor = (model: string, select?: string[]) =>
        select && select.length > 0
          ? {
              _source: select.map((field) => getFieldName({ model, field })),
            }
          : {};

      const queryFor = (model: string, where: CleanedWhere[] = []) =>
        whereToQuery(
          where.map((clause) => ({
            ...clause,
            field: getFieldName({ model, field: clause.field }),
          })),
        );

      /**
       * After losing a race to another write, makes that write searchable
       * before searching again. With "immediate" refresh it already is; with
       * "wait_for" it would otherwise stay hidden until the next scheduled
       * refresh, and every retry until then would lose again.
       */
      const afterLostRace = async (index: string) => {
        if (refresh === "wait_for") {
          await withRetry(() => client.indices.refresh({ index }));
        }
      };

      // The conditional writes of `consumeOne` and `incrementOne` are not
      // passed through `withRetry`: a write that timed out may still have
      // landed, and a retry would then see its own write as a lost race and
      // apply it twice. `create` and `update` write a whole row, so they
      // retry with `writeRow`, which can tell by the stored row.

      /**
       * Sends `write`, which stores `document` as row `id` unless the row
       * exists (create) or changed since it was read (update), retrying
       * transient failures. A retry that meets a version conflict may have
       * lost to an earlier attempt whose response never arrived; the write
       * counts as done if the row is stored exactly as `document`.
       */
      const writeRow = async (
        index: string,
        id: string,
        document: SourceDoc,
        write: () => Promise<unknown>,
      ) => {
        let attempts = 0;
        try {
          await withRetry(() => {
            attempts++;
            return write();
          });
        } catch (error) {
          if (attempts === 1 || !isVersionConflict(error)) throw error;
          const stored = await withRetry(() =>
            client.get<SourceDoc>({ index, id }),
          ).catch((getError) => {
            if (isNotFound(getError)) return undefined;
            throw getError;
          });
          // Compared as the JSON that was sent, which is what is stored.
          const sent = JSON.parse(JSON.stringify(document));
          if (!isDeepStrictEqual(stored?._source, sent)) throw error;
        }
      };

      /**
       * The first row matching `query`, with the sequence number and primary
       * term a conditional write needs to fail if the row changed since.
       *
       * `ifUnchanged` also names the concrete index the row was read from,
       * overriding the alias. Those numbers only mean something there: once
       * migrate() swaps the alias, the copy in the new index has numbers of
       * its own, which a stale pair could match by chance. Aimed at the old
       * index, the write meets its write block instead and reads again.
       */
      const findVersioned = async (index: string, query: object) => {
        const result = await withRetry(() =>
          client.search<SourceDoc>({
            index,
            query,
            size: 1,
            seq_no_primary_term: true,
          }),
        );
        const hit = result.hits.hits[0];
        if (
          !hit?._id ||
          hit._seq_no === undefined ||
          hit._primary_term === undefined
        ) {
          return null;
        }
        return {
          id: hit._id,
          source: hit._source ?? {},
          ifUnchanged: {
            index: hit._index,
            if_seq_no: hit._seq_no,
            if_primary_term: hit._primary_term,
          },
        };
      };

      /**
       * Writes every row matching `query` with `writePage`, a page of rows at
       * a time, and returns how many it wrote. `writePage` sends one bulk
       * request whose writes are conditional on each row being unchanged
       * since the search, and returns its items in the order of the rows.
       *
       * Not a by-query write: that skips rows that change under it, and since
       * updated rows usually still match, a rerun cannot tell the skipped
       * rows from the ones it already updated. Instead only the rows that lost
       * that race are searched for again, so every row is written and counted
       * once. A row whose write Elasticsearch rejected under load, or refused
       * while migrate() moves the index, was not written and goes again the
       * same way.
       */
      const writeMatchingRows = async ({
        model,
        index,
        query,
        operation,
        source,
        writePage,
      }: {
        model: string;
        index: string;
        query: object;
        operation: "updateMany" | "deleteMany";
        /** The stored fields `writePage` needs, or false for none. */
        source: string[] | false;
        writePage: (
          hits: estypes.SearchHit<SourceDoc>[],
        ) => Promise<(estypes.BulkResponseItem | undefined)[]>;
      }) => {
        const [writing, written] =
          operation === "updateMany"
            ? ["updating", "updated"]
            : ["deleting", "deleted"];
        let count = 0;
        let retryIds: string[] | undefined;
        // Passes that waited out a write block do not count towards
        // MAX_MANY_PASSES; the write block timeout bounds them instead.
        const pauseWhileBlocked = writeBlockWaiter(writeBlockTimeoutMs, index);
        let pass = 0;
        while (pass < MAX_MANY_PASSES) {
          const passQuery = retryIds
            ? { bool: { filter: [query, { ids: { values: retryIds } }] } }
            : query;
          const unwrittenIds: string[] = [];
          let rejected = false;
          let blockedBy: unknown;

          // Paging by id needs no point in time: ids are unique and never
          // change, so no row is read twice, and a row that changes on a
          // later page is read as changed.
          let searchAfter: estypes.SortResults | undefined;
          while (true) {
            const page = await withRetry(() =>
              client.search<SourceDoc>({
                index,
                query: passQuery,
                size: UPDATE_MANY_PAGE_SIZE,
                sort: [{ id: "asc" }],
                search_after: searchAfter,
                _source: source,
                seq_no_primary_term: true,
                track_total_hits: false,
              }),
            );
            const hits = page.hits.hits;
            if (hits.length === 0) break;
            searchAfter = hits[hits.length - 1]?.sort;

            // Not retried, like the other conditional writes. Each row is
            // written to the index it was read from, as in `findVersioned`.
            for (const outcome of await writePage(hits)) {
              if (isWriteBlocked(outcome) && outcome?._id) {
                unwrittenIds.push(outcome._id);
                blockedBy = outcome.error;
              } else if (
                (outcome?.status === 409 || outcome?.status === 429) &&
                outcome._id
              ) {
                unwrittenIds.push(outcome._id);
                rejected ||= outcome.status === 429;
              } else if (outcome?.status === 404) {
                // Another request deleted the row.
              } else if (!outcome || outcome.error) {
                throw new Error(
                  `${operation} on "${model}" failed after ${writing} ${count} rows: ${outcome?.error?.reason ?? outcome?.error?.type ?? "unexpected bulk response"}`,
                );
              } else {
                count++;
              }
            }
            if (hits.length < UPDATE_MANY_PAGE_SIZE) break;
          }

          if (unwrittenIds.length === 0) return count;
          retryIds = unwrittenIds;
          // Make the writes that won searchable, so the next pass sees
          // whether those rows still match and what to condition on. Even
          // with "immediate" refresh a winner may not have refreshed yet.
          await withRetry(() => client.indices.refresh({ index }));
          if (blockedBy) {
            await pauseWhileBlocked(
              blockedBy,
              `${operation} on "${model}" had ${written} ${count} rows.`,
            );
            continue;
          }
          // Give an overloaded cluster a growing, jittered while to drain.
          if (rejected) await wait((0.5 + Math.random()) * 50 * 2 ** pass);
          pass++;
        }
        throw new Error(
          `${operation} on "${model}" ${written} ${count} rows, but the remaining matching rows could not be written in ${MAX_MANY_PASSES} passes: other requests kept changing them or Elasticsearch kept rejecting the writes`,
        );
      };

      /** The conditional bulk action that writes `hit` where it was read. */
      const ifUnchanged = (hit: estypes.SearchHit<SourceDoc>) => ({
        _index: hit._index,
        _id: hit._id,
        if_seq_no: hit._seq_no,
        if_primary_term: hit._primary_term,
      });

      /** The ids of the rows whose bulk item says they were written. */
      const writtenIds = (outcomes: (estypes.BulkResponseItem | undefined)[]) =>
        outcomes.flatMap((outcome) =>
          outcome?._id && !outcome.error && outcome.status < 300
            ? [outcome._id]
            : [],
        );

      return {
        options: { [MIGRATOR]: migrator },
        createSchema,
        // Deletes the row only if it is unchanged since the search found it.
        // A lost race searches again, since the row may have been updated
        // rather than consumed; a row another caller deleted yields null.
        consumeOne: async <T>({
          model,
          where,
        }: {
          model: string;
          where: CleanedWhere[];
        }) => {
          const index = await ensureAlias(model);
          const query = queryFor(model, where);

          return whileMigrating(index, () =>
            retryOnContention<T | null>(
              `consumeOne on "${model}"`,
              MAX_ATOMIC_ATTEMPTS,
              async (retry) => {
                const row = await findVersioned(index, query);
                if (!row) return null;
                try {
                  await client.delete({
                    id: row.id,
                    ...row.ifUnchanged,
                    refresh,
                  });
                  await reservations.release(model, index, [
                    { id: row.id, source: row.source },
                  ]);
                  return normalizeHit({
                    _id: row.id,
                    _source: row.source,
                  }) as T;
                } catch (error) {
                  if (!isVersionConflict(error) && !isNotFound(error))
                    throw error;
                }
                // Searches lag behind writes; a realtime check tells whether
                // another caller deleted the row or only changed it.
                const stillThere = await withRetry(() =>
                  client.exists({ index, id: row.id }),
                );
                if (!stillThere) return null;
                await afterLostRace(index);
                return retry;
              },
            ),
          );
        },
        // The search applies the where guard; the scripted update applies only
        // if the row is unchanged since, so the guard held when it was written.
        // A lost race searches again, which re-checks the guard.
        incrementOne: async <T>({
          model,
          where,
          increment,
          set,
        }: {
          model: string;
          where: CleanedWhere[];
          increment: Record<string, number>;
          set?: Record<string, unknown>;
        }) => {
          // Claiming a value needs the row's current one, which the scripted
          // update never reads back before it writes.
          const unique = set && reservations.constrainedFieldIn(model, set);
          if (unique) {
            throw new Error(
              `incrementOne cannot set "${unique}" on "${model}", as it is a unique field; use update instead.`,
            );
          }
          const index = await ensureAlias(model);
          const query = queryFor(model, where);
          const params = { increment, set: set ?? {} };

          return whileMigrating(index, () =>
            retryOnContention<T | null>(
              `incrementOne on "${model}"`,
              MAX_ATOMIC_ATTEMPTS,
              async (retry) => {
                const row = await findVersioned(index, query);
                if (!row) return null;
                try {
                  const result = await client.update<
                    SourceDoc,
                    never,
                    SourceDoc
                  >({
                    id: row.id,
                    ...row.ifUnchanged,
                    refresh,
                    script: {
                      lang: "painless",
                      source: INCREMENT_SCRIPT,
                      params,
                    },
                    _source: true,
                  });
                  return normalizeHit({
                    _id: row.id,
                    _source: result.get?._source,
                  }) as T;
                } catch (error) {
                  // A conflict means the row changed; a missing row was deleted
                  // and the next search will not find it.
                  if (!isVersionConflict(error) && !isNotFound(error))
                    throw error;
                  await afterLostRace(index);
                  return retry;
                }
              },
            ),
          );
        },
        create: async <T extends Record<string, unknown>>({
          model,
          data,
        }: {
          model: string;
          data: T;
          select?: string[];
        }) => {
          const index = await ensureAlias(model);
          const id =
            typeof data.id === "string" && data.id.length > 0
              ? data.id
              : randomUUID();

          const source: SourceDoc = {
            ...(data as SourceDoc),
            id,
          };

          const write = () =>
            writeRow(index, id, source, () =>
              client.index({
                index,
                id,
                op_type: "create",
                refresh,
                document: source,
              }),
            );
          const values = reservations.valuesOf(model, source);
          const claims =
            values.length > 0 ? reservations.claims(model, index) : undefined;

          try {
            await whileMigrating<unknown>(
              index,
              claims
                ? async () => {
                    // Claimed again on a rerun, which re-stamps the claims.
                    await claims.claim([{ id, claim: values }]);
                    try {
                      await write();
                    } catch (error) {
                      await claims.failed(id, error);
                      throw error;
                    }
                    // A row written long after its claim may have lost a
                    // value to another write taking it for an orphan.
                    const lost = await claims.lost();
                    if (lost !== undefined) {
                      await whileMigrating(index, () =>
                        withRetry(() =>
                          client.delete({ index, id, refresh }),
                        ).catch((error) => {
                          if (!isNotFound(error)) throw error;
                        }),
                      );
                      await claims.unwritten([id]);
                      throw duplicateError(model, lost);
                    }
                  }
                : write,
            );
          } catch (error) {
            if (isVersionConflict(error)) {
              throw new Error(
                `duplicate key: a "${model}" row with id "${id}" already exists`,
                { cause: error },
              );
            }
            throw error;
          }

          return source as T;
        },
        findOne: async <T>({
          model,
          where,
          select,
        }: {
          model: string;
          where: CleanedWhere[];
          select?: string[];
          join?: Record<string, unknown>;
        }) => {
          const index = await ensureAlias(model);
          const query = queryFor(model, where);

          const result = await withRetry(() =>
            client.search<SourceDoc>({
              index,
              query,
              size: 1,
              ...sourceFor(model, select),
            }),
          );

          const hit = result.hits.hits[0];
          if (!hit) return null;
          return normalizeHit(hit) as T;
        },
        findMany: async <T>({
          model,
          where,
          limit,
          sortBy,
          offset,
          select,
        }: {
          model: string;
          where?: CleanedWhere[];
          limit: number;
          select?: string[];
          sortBy?: { field: string; direction: "asc" | "desc" };
          offset?: number;
          join?: Record<string, unknown>;
        }) => {
          const index = await ensureAlias(model);
          const query = queryFor(model, where);

          // Always ordered, by `id` last, so that pages fetched with `offset`
          // neither repeat nor skip rows.
          const sortField =
            sortBy && getFieldName({ model, field: sortBy.field });
          const sort: estypes.SortCombinations[] = [
            ...(sortBy && sortField && sortField !== "id"
              ? [
                  {
                    [sortField]: {
                      order: sortBy.direction,
                      unmapped_type: "keyword",
                    },
                  },
                ]
              : []),
            { id: sortField === "id" && sortBy ? sortBy.direction : "asc" },
          ];

          const result = await withRetry(() =>
            client.search<SourceDoc>({
              index,
              query,
              size: limit,
              ...(offset !== undefined ? { from: offset } : {}),
              ...sourceFor(model, select),
              sort,
            }),
          );

          return result.hits.hits.map(
            (hit: { _id?: string; _source?: SourceDoc }) =>
              normalizeHit(hit) as T,
          );
        },
        count: async ({
          model,
          where,
        }: {
          model: string;
          where?: CleanedWhere[];
        }) => {
          const index = await ensureAlias(model);
          const query = queryFor(model, where);

          const result = await withRetry(() => client.count({ index, query }));

          return result.count;
        },
        update: async <T>({
          model,
          where,
          update,
        }: {
          model: string;
          where: CleanedWhere[];
          update: T;
        }) => {
          const index = await ensureAlias(model);
          const query = queryFor(model, where);

          // Created once, so a rerun after a write block knows which of its
          // claims an earlier run created.
          const claims = reservations.claims(model, index);

          // Conditional on the row read, so a blocked write reads again, and
          // so does one that lost a race: the update then goes onto the row
          // as the other request left it, if it still matches `where`.
          return whileMigrating(index, () =>
            retryOnContention<T | null>(
              `update on "${model}"`,
              MAX_ATOMIC_ATTEMPTS,
              async (retry) => {
                const row = await findVersioned(index, query);
                if (!row) return null;

                const mergedDocument: SourceDoc = {
                  ...row.source,
                  ...(update as SourceDoc),
                  id: (row.source.id as string | undefined) ?? row.id,
                };

                const change = reservations.changeOf(
                  model,
                  row.id,
                  row.source,
                  update as SourceDoc,
                );
                if (change) await claims.claim([change]);

                try {
                  await writeRow(
                    row.ifUnchanged.index,
                    row.id,
                    mergedDocument,
                    () =>
                      client.index({
                        id: row.id,
                        document: mergedDocument,
                        ...row.ifUnchanged,
                        refresh,
                      }),
                  );
                } catch (error) {
                  if (change) await claims.failed(row.id, error);
                  if (!isVersionConflict(error)) throw error;
                  await afterLostRace(index);
                  return retry;
                }
                if (change) await claims.written([row.id]);

                return mergedDocument as T;
              },
            ),
          );
        },
        updateMany: async ({
          model,
          where,
          update,
        }: {
          model: string;
          where: CleanedWhere[];
          update: Record<string, unknown>;
        }) => {
          const index = await ensureAlias(model);
          const query = queryFor(model, where);

          const script = {
            lang: "painless",
            source: SET_FIELDS_SCRIPT,
            params: { fields: update },
          };
          const writeRows = async (hits: estypes.SearchHit<SourceDoc>[]) => {
            const result = await client.bulk({
              index,
              refresh,
              operations: hits.flatMap((hit) => [
                { update: ifUnchanged(hit) },
                { script },
              ]),
            });
            return result.items.map((item) => item.update);
          };

          // Every field of a unique index the update touches, since the new
          // combination includes the fields it leaves alone.
          const unique = reservations.fieldsOf(model, update);
          if (unique.length === 0) {
            return writeMatchingRows({
              model,
              index,
              query,
              operation: "updateMany",
              source: false,
              writePage: writeRows,
            });
          }

          // Each page's rows claim their new values in one request before
          // they are written, and release their old ones in one after.
          return writeMatchingRows({
            model,
            index,
            query,
            operation: "updateMany",
            source: unique,
            writePage: async (hits) => {
              const changes = hits.flatMap((hit) => {
                const change = hit._id
                  ? reservations.changeOf(model, hit._id, hit._source, update)
                  : undefined;
                return change ? [change] : [];
              });
              const claims = reservations.claims(model, index);
              await claims.claim(changes);
              const outcomes = await writeRows(hits);
              const written = new Set(writtenIds(outcomes));
              await claims.written(written);
              // Bulk items are not retried, so a row reported unwritten was
              // not written; a later pass claims its values again.
              await claims.unwritten(
                changes
                  .map((change) => change.id)
                  .filter((id) => !written.has(id)),
              );
              return outcomes;
            },
          });
        },
        delete: async ({
          model,
          where,
        }: {
          model: string;
          where: CleanedWhere[];
        }) => {
          // A singular delete needs something to pick the row by.
          if (where.length === 0) return;
          const index = await ensureAlias(model);
          const query = queryFor(model, where);

          const deleted = await whileMigrating(index, async () => {
            const searchResult = await withRetry(() =>
              client.search<SourceDoc>({ index, query, size: 1 }),
            );

            const hit = searchResult.hits.hits[0];
            const hitId = hit?._id;
            if (!hit || !hitId) return undefined;

            // A row already gone was deleted by another request, or by an
            // earlier attempt of this one whose response never arrived.
            await withRetry(() =>
              client.delete({
                index,
                id: hitId,
                refresh,
              }),
            ).catch((error) => {
              if (!isNotFound(error)) throw error;
            });
            return { id: hitId, source: hit._source };
          });
          if (deleted) await reservations.release(model, index, [deleted]);
        },
        deleteMany: async ({
          model,
          where,
        }: {
          model: string;
          where: CleanedWhere[];
        }) => {
          const index = await ensureAlias(model);
          const query = queryFor(model, where);

          // Releasing a row's values needs them, which a by-query delete does
          // not return, so these rows are deleted a page at a time.
          const unique = reservations.fieldsOf(model);
          if (unique.length > 0) {
            return writeMatchingRows({
              model,
              index,
              query,
              operation: "deleteMany",
              source: unique,
              writePage: async (hits) => {
                // Refreshed like the by-query delete, which cannot wait.
                const result = await client.bulk({
                  index,
                  refresh: true,
                  operations: hits.map((hit) => ({ delete: ifUnchanged(hit) })),
                });
                const outcomes = result.items.map((item) => item.delete);
                const written = new Set(writtenIds(outcomes));
                await reservations.release(
                  model,
                  index,
                  hits.flatMap((hit) =>
                    hit._id && written.has(hit._id)
                      ? [{ id: hit._id, source: hit._source }]
                      : [],
                  ),
                );
                return outcomes;
              },
            });
          }

          // A row that changes mid-pass is skipped as a version conflict, so
          // rerun until a pass meets none. Rows already deleted no longer
          // match, so a rerun never counts a row twice. A pass refused by a
          // migration's write block reruns too, without counting as a pass.
          let deleted = 0;
          const pauseWhileBlocked = writeBlockWaiter(
            writeBlockTimeoutMs,
            index,
          );
          let pass = 0;
          while (pass < MAX_MANY_PASSES) {
            let result: estypes.DeleteByQueryResponse;
            try {
              result = await withRetry(() =>
                client.deleteByQuery({
                  index,
                  query,
                  conflicts: "proceed",
                  refresh: true,
                }),
              );
            } catch (error) {
              if (!isWriteBlocked(error)) throw error;
              // Rows deleted before the block are gone and not copied over.
              deleted += deletedBefore(error);
              await pauseWhileBlocked(
                error,
                `deleteMany on "${model}" had deleted ${deleted} rows.`,
              );
              continue;
            }
            deleted += result.deleted ?? 0;
            if (!result.version_conflicts) return deleted;
            pass++;
          }
          throw new Error(
            `deleteMany on "${model}" deleted ${deleted} rows, but other requests kept changing matching rows; some may remain after ${MAX_MANY_PASSES} passes`,
          );
        },
      };
    },
  });

  return adapter;
};
