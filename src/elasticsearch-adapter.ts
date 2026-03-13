import { randomUUID } from "node:crypto";

import type { Client } from "@elastic/elasticsearch";
import {
  type CleanedWhere,
  type DBAdapterDebugLogOption,
  createAdapterFactory,
} from "better-auth/adapters";

import { withElasticsearchRetry } from "./elasticsearch-client";

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

const CORE_MODELS = ["user", "session", "account", "verification"] as const;

const escapeWildcard = (value: string) =>
  value.replace(/[\\*?]/g, (token) => `\\${token}`);

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

function buildFilterClause(
  field: string,
  where: CleanedWhere,
): Record<string, unknown> {
  const operator = where.operator;
  const value = where.value;

  switch (operator) {
    case "eq":
      if (value === null) {
        return { bool: { must_not: [{ exists: { field } }] } };
      }
      return { term: { [field]: value } };
    case "ne":
      if (value === null) {
        return { exists: { field } };
      }
      return { bool: { must_not: [{ term: { [field]: value } }] } };
    case "gt":
      return { range: { [field]: { gt: value } } };
    case "gte":
      return { range: { [field]: { gte: value } } };
    case "lt":
      return { range: { [field]: { lt: value } } };
    case "lte":
      return { range: { [field]: { lte: value } } };
    case "in":
      return { terms: { [field]: Array.isArray(value) ? value : [value] } };
    case "not_in":
      return {
        bool: {
          must_not: [
            { terms: { [field]: Array.isArray(value) ? value : [value] } },
          ],
        },
      };
    case "contains":
      return {
        wildcard: {
          [field]: {
            value: `*${escapeWildcard(String(value))}*`,
            case_insensitive: true,
          },
        },
      };
    case "starts_with":
      return {
        wildcard: {
          [field]: {
            value: `${escapeWildcard(String(value))}*`,
            case_insensitive: true,
          },
        },
      };
    case "ends_with":
      return {
        wildcard: {
          [field]: {
            value: `*${escapeWildcard(String(value))}`,
            case_insensitive: true,
          },
        },
      };
    default:
      return { term: { [field]: value } };
  }
}

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
      supportsDates: true,
      supportsBooleans: true,
      supportsNumericIds: false,
      transaction: false,
    },
    adapter: ({ getFieldName, getDefaultModelName }) => {
      const client = config.client;
      let initialized = false;

      const withRetry = <T>(operation: () => Promise<T>) =>
        withElasticsearchRetry(operation, maxRetries);

      const indexForModel = (model: string) =>
        prefix ? `${prefix}_${model}` : model;
      const indexForAlias = (alias: string) => alias;

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

      const ensureIndex = async (model: string) => {
        const alias = indexForModel(model);
        const index = indexForAlias(alias);
        const aliasExistsResult = await withRetry(() =>
          client.indices.existsAlias({ name: alias }),
        );

        if (aliasExistsResult) return;

        const lifecyclePolicy = await putLifecyclePolicyIfNeeded(model);

        const indexExistsResult = await withRetry(() =>
          client.indices.exists({ index }),
        );

        if (!indexExistsResult) {
          await withRetry(() =>
            client.indices.create({
              index,
              settings: {
                number_of_shards: numberOfShards,
                number_of_replicas: numberOfReplicas,
                ...(lifecyclePolicy
                  ? { lifecycle: { name: lifecyclePolicy } }
                  : {}),
              },
              mappings: {
                dynamic: true,
                dynamic_templates: [
                  {
                    strings_as_keywords: {
                      match_mapping_type: "string",
                      mapping: {
                        type: "keyword",
                        ignore_above: 1024,
                      },
                    },
                  },
                ],
              },
            }),
          );
        }

        if (alias !== index) {
          await withRetry(() =>
            client.indices.putAlias({
              index,
              name: alias,
              is_write_index: true,
            }),
          );
        }
      };

      const ensureInitialized = async () => {
        if (initialized) return;
        await withRetry(() => client.ping());
        await Promise.all(CORE_MODELS.map((model) => ensureIndex(model)));
        initialized = true;
      };

      const getIndex = async (model: string) => {
        await ensureInitialized();
        const index = indexForModel(getDefaultModelName(model));
        await ensureIndex(getDefaultModelName(model));
        return index;
      };

      const whereToQuery = (model: string, where: CleanedWhere[] = []) => {
        if (!where.length) {
          return { match_all: {} };
        }

        const firstClause = where[0];
        if (!firstClause) {
          return { match_all: {} };
        }

        let expression = buildFilterClause(
          getFieldName({ model, field: firstClause.field }),
          firstClause,
        );

        for (let index = 1; index < where.length; index += 1) {
          const clause = where[index];
          if (!clause) continue;
          const nextExpression = buildFilterClause(
            getFieldName({ model, field: clause.field }),
            clause,
          );

          if (clause.connector === "OR") {
            expression = {
              bool: {
                should: [expression, nextExpression],
                minimum_should_match: 1,
              },
            };
            continue;
          }

          expression = {
            bool: {
              must: [expression, nextExpression],
            },
          };
        }

        return expression;
      };

      return {
        create: async <T extends Record<string, unknown>>({
          model,
          data,
        }: {
          model: string;
          data: T;
          select?: string[];
        }) => {
          const index = await getIndex(model);
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
          const index = await getIndex(model);
          const query = whereToQuery(model, where);

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
          const index = await getIndex(model);
          const query = whereToQuery(model, where);

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
          const index = await getIndex(model);
          const query = whereToQuery(model, where);

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
          const index = await getIndex(model);
          const query = whereToQuery(model, where);

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
          const index = await getIndex(model);
          const query = whereToQuery(model, where);

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
          const index = await getIndex(model);
          const query = whereToQuery(model, where);

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
          const index = await getIndex(model);
          const query = whereToQuery(model, where);

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
