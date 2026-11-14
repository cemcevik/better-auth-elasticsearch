import { randomUUID } from "node:crypto";

import type { Client } from "@elastic/elasticsearch";
import {
  type CleanedWhere,
  type DBAdapterDebugLogOption,
  createAdapterFactory,
} from "better-auth/adapters";

import { withElasticsearchRetry } from "./elasticsearch-client";
import { ensureAliasedIndex, expectedProperties } from "./index-layout";
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
  number_of_shards?: number;
  number_of_replicas?: number;
}

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

      const indexForModel = (model: string) =>
        prefix ? `${prefix}_${model}` : model;

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
              async () => ({
                numberOfShards,
                numberOfReplicas,
                lifecyclePolicy: await putLifecyclePolicyIfNeeded(model),
              }),
            ),
          );
          ready.set(alias, check);
          check.catch(() => ready.delete(alias));
        }
        await check;
        return alias;
      };

      const queryFor = (model: string, where: CleanedWhere[] = []) =>
        whereToQuery(
          where.map((clause) => ({
            ...clause,
            field: getFieldName({ model, field: clause.field }),
          })),
        );

      return {
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

          await withRetry(() =>
            client.index({
              index,
              id,
              op_type: "create",
              refresh: "wait_for",
              document: source,
            }),
          );

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
              ...(select && select.length > 0 ? { _source: select } : {}),
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
              ...(select && select.length > 0 ? { _source: select } : {}),
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

          const searchResult = await withRetry(() =>
            client.search<SourceDoc>({
              index,
              query,
              size: 1,
              seq_no_primary_term: true,
            }),
          );

          const hit = searchResult.hits.hits[0];
          if (
            !hit?._source ||
            hit._seq_no === undefined ||
            hit._primary_term === undefined
          ) {
            return null;
          }

          const hitId = hit._id;
          if (!hitId) return null;

          const mergedDocument: SourceDoc = {
            ...hit._source,
            ...(update as SourceDoc),
            id: (hit._source.id as string | undefined) ?? hitId,
          };

          await withRetry(() =>
            client.index({
              index,
              id: hitId,
              document: mergedDocument,
              if_seq_no: hit._seq_no,
              if_primary_term: hit._primary_term,
              refresh: "wait_for",
            }),
          );

          return mergedDocument as T;
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

          const params = {
            fields: update,
          };

          const result = await withRetry(() =>
            client.updateByQuery({
              index,
              query,
              conflicts: "proceed",
              refresh: true,
              script: {
                lang: "painless",
                source:
                  "for (entry in params.fields.entrySet()) { ctx._source[entry.getKey()] = entry.getValue(); }",
                params,
              },
            }),
          );

          return result.updated ?? 0;
        },
        delete: async ({
          model,
          where,
        }: {
          model: string;
          where: CleanedWhere[];
        }) => {
          const index = await ensureAlias(model);
          const query = queryFor(model, where);

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
              refresh: "wait_for",
            }),
          );
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

          const result = await withRetry(() =>
            client.deleteByQuery({
              index,
              query,
              conflicts: "proceed",
              refresh: true,
            }),
          );

          return result.deleted ?? 0;
        },
      };
    },
  });

  return adapter;
};
