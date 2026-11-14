import type { Client } from "@elastic/elasticsearch";
import type { MappingProperty } from "@elastic/elasticsearch/lib/api/types";
import type { BetterAuthDBSchema, DBFieldAttribute } from "better-auth/db";

import { statusCodeOf } from "./elasticsearch-client";

/**
 * Strings are keywords. 8191 is the longest string, in characters, that is
 * always within Lucene's term limit of 32766 bytes (four UTF-8 bytes per
 * character at most). Longer values are stored and returned but cannot be
 * searched.
 */
const KEYWORD: MappingProperty = { type: "keyword", ignore_above: 8191 };

type MappingProperties = Record<string, MappingProperty>;

const propertyForField = (field: DBFieldAttribute): MappingProperty => {
  switch (field.type) {
    case "number":
      // A double holds every value a JavaScript number can, integer or not.
      return field.bigint ? { type: "long" } : { type: "double" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "date" };
    case "json":
      // Stored and returned as is, never searched.
      return { type: "object", enabled: false };
    default:
      // "string" and enum fields, plus "string[]" and "number[]": the factory
      // hands the adapter arrays as JSON strings, as the adapter does not
      // declare `supportsArrays`.
      return KEYWORD;
  }
};

/**
 * The mapping properties a model's index must have, keyed by the field names
 * stored in Elasticsearch (which honour a custom `fieldName`).
 */
export const expectedProperties = (
  schema: BetterAuthDBSchema,
  defaultModelName: string,
): MappingProperties => {
  const table = schema[defaultModelName];
  const properties: MappingProperties = { id: KEYWORD };
  for (const [key, field] of Object.entries(table?.fields ?? {})) {
    properties[field.fieldName ?? key] = propertyForField(field);
  }
  return properties;
};

/** The type Elasticsearch reports for a property; objects may omit it. */
const typeOf = (property: MappingProperty): string => property.type ?? "object";

const isNotFound = (error: unknown) => statusCodeOf(error) === 404;

const isAlreadyExists = (error: unknown) =>
  (error as { meta?: { body?: { error?: { type?: string } } } }).meta?.body
    ?.error?.type === "resource_already_exists_exception";

export interface IndexSettings {
  numberOfShards: number;
  numberOfReplicas: number;
  lifecyclePolicy?: string | undefined;
}

/**
 * Makes sure `alias` exists over a versioned index whose mapping matches
 * `expected`: creates `<alias>_v1` if nothing exists, adds fields the live
 * mapping lacks, and fails on a field whose type differs or on a plain index
 * where the alias should be. Fields only present in the live mapping are left
 * alone.
 */
export const ensureAliasedIndex = async (
  client: Client,
  alias: string,
  expected: MappingProperties,
  settings: () => Promise<IndexSettings>,
): Promise<void> => {
  let live = await liveMappings(client, alias);

  if (!live) {
    const { numberOfShards, numberOfReplicas, lifecyclePolicy } =
      await settings();
    try {
      await client.indices.create({
        index: `${alias}_v1`,
        aliases: { [alias]: { is_write_index: true } },
        settings: {
          number_of_shards: numberOfShards,
          number_of_replicas: numberOfReplicas,
          ...(lifecyclePolicy ? { lifecycle: { name: lifecyclePolicy } } : {}),
        },
        mappings: { dynamic: false, properties: expected },
      });
      return;
    } catch (error) {
      // Another process created it first; check what it created.
      if (!isAlreadyExists(error)) throw error;
      live = await liveMappings(client, alias);
      if (!live) {
        throw new Error(
          `Elasticsearch index "${alias}_v1" exists without the alias "${alias}". Add the alias or delete the index.`,
        );
      }
    }
  }

  if (alias in live) {
    throw new Error(
      `"${alias}" is a plain Elasticsearch index, but this adapter expects an alias over a versioned index. Delete or rename the index. Nothing was changed.`,
    );
  }

  const missing: MappingProperties = {};
  for (const [name, property] of Object.entries(expected)) {
    for (const [index, properties] of Object.entries(live)) {
      const current = properties[name];
      if (!current) {
        missing[name] = property;
      } else if (typeOf(current) !== typeOf(property)) {
        throw new Error(
          `Field "${name}" of Elasticsearch index "${index}" (alias "${alias}") has type "${typeOf(current)}", but the better-auth schema needs "${typeOf(property)}". Run migrate() from @cemcevik/better-auth-elasticsearch to move the data to an index with the new mapping.`,
        );
      }
    }
  }

  if (Object.keys(missing).length > 0) {
    await client.indices.putMapping({ index: alias, properties: missing });
  }
};

/** Live mapping properties per concrete index behind a name, or undefined. */
const liveMappings = async (
  client: Client,
  name: string,
): Promise<Record<string, MappingProperties> | undefined> => {
  try {
    const response = await client.indices.getMapping({ index: name });
    return Object.fromEntries(
      Object.entries(response).map(([index, { mappings }]) => [
        index,
        mappings.properties ?? {},
      ]),
    );
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
};
