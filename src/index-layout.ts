import type { Client } from "@elastic/elasticsearch";
import type { MappingProperty } from "@elastic/elasticsearch/lib/api/types";
import type { BetterAuthDBSchema, DBFieldAttribute } from "better-auth/db";

import { isNotFound, wait } from "./elasticsearch-client.js";

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

/** The mappings a new versioned index is created with: dynamic mapping off. */
export const expectedMappings = (properties: MappingProperties) => ({
  dynamic: false as const,
  properties,
});

/** The type Elasticsearch reports for a property; objects may omit it. */
const typeOf = (property: MappingProperty): string => property.type ?? "object";

const isAlreadyExists = (error: unknown) =>
  (error as { meta?: { body?: { error?: { type?: string } } } }).meta?.body
    ?.error?.type === "resource_already_exists_exception";

export interface IndexSettings {
  numberOfShards: number;
  numberOfReplicas: number;
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
  settings: IndexSettings,
): Promise<void> => {
  let live = await liveMappings(client, alias);

  if (!live) {
    try {
      await createVersionedIndex(client, `${alias}_v1`, expected, settings, {
        [alias]: { is_write_index: true },
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

  if (alias in live) throw plainIndexError(alias);

  const missing: MappingProperties = {};
  for (const [index, properties] of Object.entries(live)) {
    const diff = mappingDiff(expected, properties);
    const [first] = diff.changed;
    if (first) {
      throw new Error(
        `Field "${first.name}" of Elasticsearch index "${index}" (alias "${alias}") has type "${first.from}", but the better-auth schema needs "${first.to}". Run migrate() from better-auth-elasticsearch to move the data to an index with the new mapping.`,
      );
    }
    Object.assign(missing, diff.missing);
  }

  if (Object.keys(missing).length > 0) {
    await client.indices.putMapping({ index: alias, properties: missing });
  }
};

const plainIndexError = (alias: string) =>
  new Error(
    `"${alias}" is a plain Elasticsearch index, but this adapter expects an alias over a versioned index. Delete or rename the index. Nothing was changed.`,
  );

/** Creates a versioned index with dynamic mapping off. */
const createVersionedIndex = async (
  client: Client,
  index: string,
  expected: MappingProperties,
  { numberOfShards, numberOfReplicas }: IndexSettings,
  aliases?: Record<string, { is_write_index: boolean }>,
) => {
  await client.indices.create({
    index,
    ...(aliases ? { aliases } : {}),
    settings: {
      number_of_shards: numberOfShards,
      number_of_replicas: numberOfReplicas,
    },
    mappings: expectedMappings(expected),
  });
};

/**
 * How a live mapping differs from the expected one: fields it is missing,
 * and fields whose type changed. Fields only the live mapping has are
 * ignored.
 */
const mappingDiff = (expected: MappingProperties, live: MappingProperties) => {
  const missing: MappingProperties = {};
  const changed: { name: string; from: string; to: string }[] = [];
  for (const [name, property] of Object.entries(expected)) {
    const current = live[name];
    if (!current) {
      missing[name] = property;
    } else if (typeOf(current) !== typeOf(property)) {
      changed.push({ name, from: typeOf(current), to: typeOf(property) });
    }
  }
  return { missing, changed };
};

/** What migrate() did to one model. */
export interface MigratedIndex {
  alias: string;
  /** The index the alias pointed at before. */
  from: string;
  /** The index the alias points at now. */
  to: string;
}

/**
 * Moves `alias` to the next versioned index when a field's type differs from
 * `expected`: creates the new index with the expected mapping, write-blocks
 * the old one, copies every row over and swaps the alias in one atomic
 * action. Writes that meet the block wait for the swap (see
 * `waitOutWriteBlock`). Returns undefined, changing nothing, when no index
 * exists yet or no type differs. On a failed copy the new index is deleted
 * and the old one unblocked.
 *
 * If the process dies mid-way the old index stays write-blocked and writes
 * to the model time out; running migrate() again finishes the move.
 */
export const migrateAliasedIndex = async (
  client: Client,
  alias: string,
  expected: MappingProperties,
  settings: IndexSettings,
): Promise<MigratedIndex | undefined> => {
  const live = await liveMappings(client, alias);
  if (!live) return undefined;
  if (alias in live) throw plainIndexError(alias);
  const entries = Object.entries(live);
  const [current] = entries;
  if (!current || entries.length > 1) {
    throw new Error(
      `Alias "${alias}" points at ${entries.length} indices; migrate() needs exactly one. Nothing was changed.`,
    );
  }
  const [from, properties] = current;
  const { changed } = mappingDiff(expected, properties);
  if (changed.length === 0) return undefined;

  const to = `${alias}_v${(await highestVersion(client, alias)) + 1}`;
  await createVersionedIndex(client, to, expected, settings);

  try {
    // Once the block is acknowledged no write is still in flight, so the
    // refreshed old index holds every row there is to copy.
    await client.indices.addBlock({ index: from, block: "write" });
    await client.indices.refresh({ index: from });
    await copyRows(
      client,
      from,
      to,
      Object.fromEntries(changed.map(({ name, to: type }) => [name, type])),
    );
    await client.indices.updateAliases({
      actions: [
        { add: { index: to, alias, is_write_index: true } },
        { remove: { index: from, alias } },
      ],
    });
  } catch (error) {
    // A swap that failed only on the way back may still have happened.
    if (!(await pointsAt(client, alias, to))) {
      throw await rollBack(client, alias, from, to, error);
    }
  }

  return { alias, from, to };
};

/** Whether `alias` points at `index`; false when that cannot be told. */
const pointsAt = async (client: Client, alias: string, index: string) => {
  try {
    return index in (await client.indices.getAlias({ name: alias }));
  } catch {
    return false;
  }
};

/**
 * Undoes a migration whose alias still points at `from`: unblocks `from` and
 * deletes `to`. Returns the error to throw, saying what was left behind.
 */
const rollBack = async (
  client: Client,
  alias: string,
  from: string,
  to: string,
  cause: unknown,
): Promise<Error> => {
  const leftovers: string[] = [];
  try {
    await client.indices.putSettings({
      index: from,
      settings: { "index.blocks.write": false },
    });
  } catch {
    leftovers.push(
      `"${from}" is still write-blocked; clear "index.blocks.write" on it or run migrate() again`,
    );
  }
  try {
    await client.indices.delete({ index: to });
  } catch {
    leftovers.push(`"${to}" could not be deleted`);
  }
  const outcome =
    leftovers.length === 0
      ? `"${from}" is unchanged and "${to}" was removed`
      : leftovers.join("; ");
  return new Error(
    `Migrating "${alias}" from "${from}" to "${to}" failed; ${outcome}: ${(cause as Error).message}`,
    { cause },
  );
};

/** The highest n of the `<alias>_v<n>` indices that exist, kept old ones included. */
const highestVersion = async (client: Client, alias: string) => {
  const indices = await client.indices.get({
    index: `${alias}_v*`,
    allow_no_indices: true,
    ignore_unavailable: true,
  });
  const pattern = new RegExp(`^${escapeRegExp(alias)}_v(\\d+)$`);
  let highest = 0;
  for (const name of Object.keys(indices)) {
    const version = Number(pattern.exec(name)?.[1] ?? 0);
    if (version > highest) highest = version;
  }
  return highest;
};

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Painless that rewrites each changed field's stored value to its new type,
 * so rows read back with the type the schema declares rather than the one
 * they were written with. A value that has no faithful conversion fails the
 * copy, naming the row, the field and the value. Missing and null values are
 * left alone. Types with no conversion listed (such as an `object`) keep
 * their value as is and leave Elasticsearch to accept or reject it.
 */
const CONVERT_SCRIPT = `
for (def entry : params.fields.entrySet()) {
  String field = entry.getKey();
  String type = entry.getValue();
  def value = ctx._source.get(field);
  if (value == null) { continue; }
  def converted = null;
  if (type == 'keyword') {
    if (value instanceof String) { converted = value; }
    else if (value instanceof Number || value instanceof Boolean) { converted = String.valueOf(value); }
  } else if (type == 'double') {
    if (value instanceof Number) { converted = ((Number) value).doubleValue(); }
    else if (value instanceof String) {
      try { converted = Double.parseDouble(((String) value).trim()); } catch (NumberFormatException e) {}
    }
  } else if (type == 'long') {
    if (value instanceof Integer || value instanceof Long) { converted = ((Number) value).longValue(); }
    else if (value instanceof Number) {
      double number = ((Number) value).doubleValue();
      if (number == Math.rint(number)) { converted = (long) number; }
    } else if (value instanceof String) {
      try { converted = Long.parseLong(((String) value).trim()); } catch (NumberFormatException e) {}
    }
  } else if (type == 'boolean') {
    if (value instanceof Boolean) { converted = value; }
    else if (value instanceof String) {
      String text = ((String) value).trim().toLowerCase();
      if (text == 'true') { converted = true; } else if (text == 'false') { converted = false; }
    }
  } else if (type == 'date') {
    if (value instanceof String) { converted = value; }
    else if (value instanceof Number) { converted = Instant.ofEpochMilli(((Number) value).longValue()).toString(); }
  } else {
    converted = value;
  }
  if (converted == null) {
    String shown = value instanceof String ? '"' + value + '"' : String.valueOf(value);
    throw new IllegalArgumentException('row "' + ctx._id + '": field "' + field + '" holds ' + shown + ', which cannot be converted to ' + type);
  }
  ctx._source.put(field, converted);
}
`;

/** The innermost reason of an Elasticsearch error cause chain. */
const innermostReason = (
  cause: { reason?: string | null; caused_by?: unknown } | undefined,
): string | undefined => {
  let reason: string | undefined;
  let current = cause;
  while (current) {
    reason = current.reason ?? reason;
    current = current.caused_by as typeof cause;
  }
  return reason;
};

/**
 * Reindexes `from` into `to` as a background task, so a large index does not
 * outlast the client's request timeout, converting the values of the fields
 * in `convert` (field name to new mapping type) on the way. Fails on any row
 * not copied.
 */
const copyRows = async (
  client: Client,
  from: string,
  to: string,
  convert: Record<string, string>,
) => {
  const started = await client.reindex({
    source: { index: from },
    dest: { index: to, op_type: "create" },
    script: {
      lang: "painless",
      source: CONVERT_SCRIPT,
      params: { fields: convert },
    },
    refresh: true,
    wait_for_completion: false,
  });
  const taskId = String(started.task);
  while (true) {
    const status = await client.tasks.get({ task_id: taskId });
    if (!status.completed) {
      await wait(100);
      continue;
    }
    const response = status.response as
      | { failures?: { id?: string; cause?: { reason?: string } }[] }
      | undefined;
    const reason =
      innermostReason(status.error) ??
      innermostReason(response?.failures?.[0]?.cause);
    if (status.error || (response?.failures?.length ?? 0) > 0) {
      throw new Error(`Copying the rows failed: ${reason ?? "unknown error"}`);
    }
    return;
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
