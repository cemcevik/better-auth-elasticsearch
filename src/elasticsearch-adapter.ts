import { randomUUID } from "node:crypto";

import type { Client, estypes } from "@elastic/elasticsearch";
import {
  type CleanedWhere,
  type DBAdapterDebugLogOption,
  createAdapterFactory,
} from "better-auth/adapters";

import {
  isNotFound,
  isVersionConflict,
  isWriteBlocked,
  retryOnContention,
  wait,
  waitOutWriteBlock,
  withElasticsearchRetry,
  writeBlockWaiter,
} from "./elasticsearch-client";
import {
  ensureAliasedIndex,
  expectedProperties,
  migrateAliasedIndex,
} from "./index-layout";
import { MIGRATOR, type MigratedModel, type Migrator } from "./migrate";
import { whereToQuery } from "./where-to-query";

type Primitive = string | number | boolean | Date | null;
type SourceDoc = Record<
  string,
  Primitive | Primitive[] | Record<string, unknown>
>;

export interface ElasticAdapterConfig {
  client: Client;
  debugLogs?: DBAdapterDebugLogOption;
  indexPrefix?: string;
  sessionRetentionDays?: number;
  verificationRetentionDays?: number;
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
  number_of_shards?: number;
  number_of_replicas?: number;
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

const normalizeHit = (hit: {
  _id?: string;
  _source?: SourceDoc;
}): SourceDoc => {
  const source = hit._source ?? {};
  const documentId = hit._id ?? randomUUID();
  return {
    ...source,
    id: (source.id as string | undefined) ?? documentId,
  };
};

export const elasticsearchAdapter = (
  config: ElasticAdapterConfig,
): ReturnType<typeof createAdapterFactory> => {
  const prefix = config.indexPrefix ?? "";
  const sessionRetentionDays = config.sessionRetentionDays ?? 30;
  const verificationRetentionDays = config.verificationRetentionDays ?? 7;
  const maxRetries = config.maxRetries ?? 3;
  const refresh = config.refresh === "wait_for" ? "wait_for" : true;
  const writeBlockTimeoutMs = config.writeBlockTimeoutMs ?? 30_000;
  const numberOfShards = config.number_of_shards ?? 1;
  const numberOfReplicas = config.number_of_replicas ?? 0;

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

      // Elasticsearch index and alias names must be lowercase.
      const indexForModel = (model: string) =>
        (prefix ? `${prefix}_${model}` : model).toLowerCase();

      const putLifecyclePolicyIfNeeded = async (
        model: string,
      ): Promise<string | undefined> => {
        const defaultModel = getDefaultModelName(model);
        if (defaultModel !== "session" && defaultModel !== "verification") {
          return undefined;
        }

        const deleteAfterDays =
          defaultModel === "session"
            ? sessionRetentionDays
            : verificationRetentionDays;

        const policyName = `${indexForModel(defaultModel)}_policy`;

        try {
          await withRetry(() =>
            client.ilm.putLifecycle({
              name: policyName,
              policy: {
                phases: {
                  hot: { actions: {} },
                  delete: {
                    min_age: `${deleteAfterDays}d`,
                    actions: { delete: {} },
                  },
                },
              },
            }),
          );
          return policyName;
        } catch {
          return undefined;
        }
      };

      const indexSettings = (model: string) => async () => ({
        numberOfShards,
        numberOfReplicas,
        lifecyclePolicy: await putLifecyclePolicyIfNeeded(model),
      });

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
              indexSettings(model),
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
            indexSettings(model),
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
        return { migrated };
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

      // Conditional writes below are not passed through `withRetry`: a write
      // that timed out may still have landed, and a retry would then see its
      // own write as a lost race and apply it twice.

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

      return {
        options: { [MIGRATOR]: migrator },
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

          try {
            await whileMigrating(index, () =>
              withRetry(() =>
                client.index({
                  index,
                  id,
                  op_type: "create",
                  refresh,
                  document: source,
                }),
              ),
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

          const result = await withRetry(() =>
            client.search<SourceDoc>({
              index,
              query,
              size: limit,
              ...(offset !== undefined ? { from: offset } : {}),
              ...sourceFor(model, select),
              ...(sortBy
                ? {
                    sort: [
                      {
                        [getFieldName({ model, field: sortBy.field })]: {
                          order: sortBy.direction,
                          unmapped_type: "keyword",
                        },
                      },
                    ],
                  }
                : {}),
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

          // Conditional on the row read, so a blocked write reads again.
          return whileMigrating(index, async () => {
            const row = await findVersioned(index, query);
            if (!row) return null;

            const mergedDocument: SourceDoc = {
              ...row.source,
              ...(update as SourceDoc),
              id: (row.source.id as string | undefined) ?? row.id,
            };

            await withRetry(() =>
              client.index({
                id: row.id,
                document: mergedDocument,
                ...row.ifUnchanged,
                refresh,
              }),
            );

            return mergedDocument as T;
          });
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

          // Not an update-by-query: it skips rows that change under it, and
          // since updated rows usually still match, a rerun cannot tell the
          // skipped rows from the ones it already updated. Instead each row
          // is updated only if unchanged since the search found it, and only
          // the rows that lost that race are searched for again, so every
          // row is updated and counted once. A row whose write Elasticsearch
          // rejected under load, or refused while migrate() moves the index,
          // was not written and goes again the same way.
          let updated = 0;
          let retryIds: string[] | undefined;
          // Passes that waited out a write block do not count towards
          // MAX_MANY_PASSES; the write block timeout bounds them instead.
          const pauseWhileBlocked = writeBlockWaiter(
            writeBlockTimeoutMs,
            index,
          );
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
                client.search({
                  index,
                  query: passQuery,
                  size: UPDATE_MANY_PAGE_SIZE,
                  sort: [{ id: "asc" }],
                  search_after: searchAfter,
                  _source: false,
                  seq_no_primary_term: true,
                  track_total_hits: false,
                }),
              );
              const hits = page.hits.hits;
              if (hits.length === 0) break;
              searchAfter = hits[hits.length - 1]?.sort;

              // Not retried, like the other conditional writes. Each row is
              // written to the index it was read from, as in `findVersioned`.
              const result = await client.bulk({
                index,
                refresh,
                operations: hits.flatMap((hit) => [
                  {
                    update: {
                      _index: hit._index,
                      _id: hit._id,
                      if_seq_no: hit._seq_no,
                      if_primary_term: hit._primary_term,
                    },
                  },
                  { script },
                ]),
              });
              for (const item of result.items) {
                const outcome = item.update;
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
                    `updateMany on "${model}" failed after updating ${updated} rows: ${outcome?.error?.reason ?? outcome?.error?.type ?? "unexpected bulk response"}`,
                  );
                } else {
                  updated++;
                }
              }
              if (hits.length < UPDATE_MANY_PAGE_SIZE) break;
            }

            if (unwrittenIds.length === 0) return updated;
            retryIds = unwrittenIds;
            // Make the writes that won searchable, so the next pass sees
            // whether those rows still match and what to condition on. Even
            // with "immediate" refresh a winner may not have refreshed yet.
            await withRetry(() => client.indices.refresh({ index }));
            if (blockedBy) {
              await pauseWhileBlocked(
                blockedBy,
                `updateMany on "${model}" had updated ${updated} rows.`,
              );
              continue;
            }
            // Give an overloaded cluster a growing, jittered while to drain.
            if (rejected) await wait((0.5 + Math.random()) * 50 * 2 ** pass);
            pass++;
          }
          throw new Error(
            `updateMany on "${model}" updated ${updated} rows, but the remaining matching rows could not be written in ${MAX_MANY_PASSES} passes: other requests kept changing them or Elasticsearch kept rejecting the writes`,
          );
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

          await whileMigrating(index, async () => {
            const searchResult = await withRetry(() =>
              client.search<SourceDoc>({ index, query, size: 1 }),
            );

            const hit = searchResult.hits.hits[0];
            const hitId = hit?._id;
            if (!hit || !hitId) return;

            await withRetry(() =>
              client.delete({
                index,
                id: hitId,
                refresh,
              }),
            );
          });
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
