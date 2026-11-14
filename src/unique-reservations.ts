import { createHash } from "node:crypto";

import type { Client, estypes } from "@elastic/elasticsearch";
import type { BetterAuthDBSchema } from "better-auth/db";

import {
  isNotFound,
  isVersionConflict,
  isWriteBlocked,
  statusCodeOf,
} from "./elasticsearch-client.js";
import type { IndexSettings } from "./index-layout.js";

/**
 * How long a reservation whose row does not hold its value counts as a write
 * still in flight. Older, it is left over from a crash and may be taken over,
 * so a crash blocks a value for at most this long.
 */
export const GRACE_MS = 120_000;

/** How often a claim of one value goes again after losing a race for it. */
const MAX_CLAIM_ATTEMPTS = 10;

/** How many rows a backfill reads and reserves per request. */
const BACKFILL_PAGE_SIZE = 1000;

// Re-stamps a reservation the claiming row already owns. One another row owns
// is left untouched, and the claimant decides what to do from its contents.
const CLAIM_SCRIPT = `
if (ctx._source.owner == params.owner) {
  ctx._source.claimedAt = params.now;
} else {
  ctx.op = 'noop';
}`;

// Deletes a reservation only while the deleted row still owns it.
const RELEASE_SCRIPT = `
if (ctx._source.owner == params.owner) {
  ctx.op = 'delete';
} else {
  ctx.op = 'noop';
}`;

type Source = Record<string, unknown>;

/**
 * What a reservation document stores: the constraint's database field names
 * joined with "+", the owning row, and when it was last claimed. Never the
 * value itself.
 */
interface Reservation {
  field: string;
  owner: string;
  claimedAt: number;
}

/**
 * A set of fields whose values together must be unique: a field declared
 * `unique`, or a unique index of the table, which may span several fields.
 */
export interface UniqueConstraint {
  /** The schema field names in index order, joined with "+". */
  name: string;
  /** The fields' schema and database names, in index order. */
  fields: { name: string; dbName: string }[];
}

/** The values a row holds in a constraint's fields, in its field order. */
export interface HeldValues {
  constraint: UniqueConstraint;
  values: unknown[];
}

/** The unique values one row's write takes and gives up. */
export interface RowChange {
  id: string;
  claim: HeldValues[];
  drop?: HeldValues[];
}

/** Rows that already hold the same value of a unique field or index. */
export interface DuplicateValues {
  /** The model's name in the better-auth schema, such as "user". */
  model: string;
  /**
   * The field's name in the better-auth schema, such as "email", or for an
   * index over several fields their names joined with "+".
   */
  field: string;
  /** The ids of the rows holding the value. */
  ids: string[];
}

/** The sequence number and primary term a conditional write needs. */
interface Version {
  if_seq_no: number;
  if_primary_term: number;
}

interface Entry extends HeldValues {
  row: string;
  /** The reservation document's `_id`. */
  id: string;
  /** Whether this write created the reservation rather than inheriting it. */
  created: boolean;
  /** The reservation as this write last left it. */
  version?: Version;
}

/** A row's values of one constraint, as migrate() reserves them. */
interface BackfillEntry extends HeldValues {
  row: string;
  /** The row's stored values of every enforced field. */
  source: Source | undefined;
  /** The reservation document's `_id`. */
  id: string;
}

const isValue = (value: unknown) => value !== null && value !== undefined;

const dbFieldsOf = (constraint: UniqueConstraint) =>
  constraint.fields.map((field) => field.dbName);

/**
 * The values a stored row holds in a constraint's fields, or undefined if
 * any is null or missing: such a row holds no reservation.
 */
const valuesIn = (
  constraint: UniqueConstraint,
  source: Source | undefined,
): unknown[] | undefined => {
  const values = dbFieldsOf(constraint).map((dbName) => source?.[dbName]);
  return values.every(isValue) ? values : undefined;
};

/** Whether a stored row holds `held`, compared as stored. */
const holds = (source: Source | undefined, held: HeldValues) =>
  JSON.stringify(valuesIn(held.constraint, source)) ===
  JSON.stringify(held.values);

/**
 * A reservation's `_id`: a hash, so the value itself is never stored. One
 * field hashes as `[field, value]` however its uniqueness is declared;
 * several hash as `[fields, values]`, which no single field can collide with.
 */
export const reservationId = (
  dbFields: readonly string[],
  values: readonly unknown[],
) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        dbFields.length === 1 ? [dbFields[0], values[0]] : [dbFields, values],
      ),
    )
    .digest("base64url");

const idOf = (held: HeldValues) =>
  reservationId(dbFieldsOf(held.constraint), held.values);

/** The reservation document `held` claimed for `owner`. */
const reservationFor = (
  held: HeldValues,
  owner: string,
  claimedAt: number,
): Reservation => ({
  field: dbFieldsOf(held.constraint).join("+"),
  owner,
  claimedAt,
});

const versionOf = (item: {
  _seq_no?: number;
  _primary_term?: number;
}): Version | undefined =>
  item._seq_no === undefined || item._primary_term === undefined
    ? undefined
    : { if_seq_no: item._seq_no, if_primary_term: item._primary_term };

/** A write that failed in a way that leaves open whether it landed. */
const mayHaveLanded = (error: unknown) => {
  const status = statusCodeOf(error);
  return (
    status === undefined || status === 408 || status === 429 || status >= 500
  );
};

const isAlreadyExists = (error: unknown) =>
  (error as { meta?: { body?: { error?: { type?: string } } } }).meta?.body
    ?.error?.type === "resource_already_exists_exception";

export const duplicateError = (model: string, field: string) =>
  new Error(
    `duplicate key: a "${model}" row with this ${field} already exists`,
  );

export interface ReservationsOptions {
  client: Client;
  schema: BetterAuthDBSchema;
  /** The schema's name for a database model name. */
  getDefaultModelName: (model: string) => string;
  /**
   * Constraints left unenforced, as `model.field`, or `model.fieldA+fieldB`
   * for an index over several fields, in schema names and index order.
   */
  skipUniqueFor: string[];
  settings: IndexSettings;
  withRetry: <T>(operation: () => Promise<T>) => Promise<T>;
}

/**
 * Enforces the fields the better-auth schema declares unique and its tables'
 * unique indexes. Every value of such a field, or combination of values of
 * such an index, is backed by a reservation document in `<alias>_unique`
 * whose `_id` derives from the fields and the values, so Elasticsearch refuses a
 * second one the way it refuses a second row with the same id. Reservations
 * are only read and written by `_id`, which is real-time, so none of their
 * writes refresh.
 */
export const createReservations = ({
  client,
  schema,
  getDefaultModelName,
  skipUniqueFor,
  settings,
  withRetry,
}: ReservationsOptions) => {
  const skipped = new Set(skipUniqueFor);
  const constraintsByModel = new Map<string, UniqueConstraint[]>();

  /**
   * The enforced constraints of a model, by its schema name. A field
   * declared unique both ways is one constraint, with one reservation.
   */
  const constraintsOfDefault = (defaultModel: string) => {
    let constraints = constraintsByModel.get(defaultModel);
    if (!constraints) {
      const table = schema[defaultModel];
      const fields = table?.fields ?? {};
      const declared = [
        ...Object.entries(fields)
          .filter(([, field]) => field.unique === true)
          .map(([name]) => [name]),
        ...(table?.indexes ?? [])
          .filter((index) => index.unique === true)
          .map((index) => [...index.fields]),
      ];
      const byName = new Map<string, UniqueConstraint>();
      for (const names of declared) {
        const name = names.join("+");
        if (byName.has(name) || skipped.has(`${defaultModel}.${name}`)) {
          continue;
        }
        byName.set(name, {
          name,
          fields: names.map((field) => ({
            name: field,
            dbName: fields[field]?.fieldName ?? field,
          })),
        });
      }
      constraints = [...byName.values()];
      constraintsByModel.set(defaultModel, constraints);
    }
    return constraints;
  };

  /** The enforced constraints of a model, by its database name. */
  const constraintsOf = (model: string) =>
    constraintsOfDefault(getDefaultModelName(model));

  /**
   * The database names of the fields of a model's enforced constraints
   * that `data` sets any field of, or of all of them without `data`. A
   * write needs the row's current values of all of these.
   */
  const fieldsOf = (model: string, data?: Source) => [
    ...new Set(
      constraintsOf(model)
        .filter(
          (constraint) =>
            !data || dbFieldsOf(constraint).some((dbName) => dbName in data),
        )
        .flatMap(dbFieldsOf),
    ),
  ];

  /** The schema name of a field `data` sets that a constraint covers. */
  const constrainedFieldIn = (model: string, data: Source) =>
    constraintsOf(model)
      .flatMap((constraint) => constraint.fields)
      .find((field) => field.dbName in data)?.name;

  const indexFor = (alias: string) => `${alias}_unique`;

  // One creation check per reservation index and process. A failed check is
  // forgotten so the next call tries again.
  const ready = new Map<string, Promise<void>>();

  /**
   * Creates the reservation index on first use. Without it, the first
   * reservation write would have Elasticsearch create it with a dynamic
   * mapping.
   */
  const ensureIndex = async (alias: string) => {
    const index = indexFor(alias);
    let check = ready.get(index);
    if (!check) {
      check = withRetry(async () => {
        try {
          await client.indices.create({
            index,
            settings: {
              number_of_shards: settings.numberOfShards,
              number_of_replicas: settings.numberOfReplicas,
            },
            mappings: {
              dynamic: "strict",
              properties: {
                field: { type: "keyword" },
                owner: { type: "keyword" },
                claimedAt: { type: "date", format: "epoch_millis" },
              },
            },
          });
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
        }
      });
      ready.set(index, check);
      check.catch(() => ready.delete(index));
    }
    await check;
    return index;
  };

  /** Rows of `alias` by id, real-time, with only `fields` of their source. */
  const rowsById = async (alias: string, ids: string[], fields: string[]) => {
    const rows = new Map<string, Source>();
    if (ids.length === 0) return rows;
    const response = await withRetry(() =>
      client.mget<Source>({ index: alias, ids, _source: fields }),
    );
    for (const doc of response.docs) {
      if ("found" in doc && doc.found) rows.set(doc._id, doc._source ?? {});
    }
    return rows;
  };

  /** A row of `alias` by id, real-time, with only `fields` of its source. */
  const rowById = async (alias: string, id: string, ...fields: string[]) => {
    try {
      const doc = await withRetry(() =>
        client.get<Source>({ index: alias, id, _source_includes: fields }),
      );
      return doc.found ? (doc._source ?? {}) : undefined;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  };

  /**
   * Deletes reservations only if each is still as `version` says. Conditional
   * deletes are safe to repeat. A failure only leaves orphans behind, which
   * are taken over once the grace period has passed, so it is not reported.
   */
  const deleteUnchanged = async (index: string, entries: Entry[]) => {
    const operations = entries.flatMap((entry) =>
      entry.version ? [{ delete: { _id: entry.id, ...entry.version } }] : [],
    );
    if (operations.length === 0) return;
    await withRetry(() => client.bulk({ index, operations })).catch(() => {});
  };

  /** The enforced values a stored row holds. */
  const valuesOf = (model: string, source: Source | undefined) =>
    constraintsOf(model).flatMap((constraint): HeldValues[] => {
      const values = valuesIn(constraint, source);
      return values ? [{ constraint, values }] : [];
    });

  /**
   * What a write of `changes` to a row stored as `before` takes and gives up.
   * Undefined when it changes no enforced value. `before` must hold every
   * field of each constraint `changes` touches (see `fieldsOf`).
   */
  const changeOf = (
    model: string,
    id: string,
    before: Source | undefined,
    changes: Source,
  ): RowChange | undefined => {
    const after = { ...before, ...changes };
    const claim: HeldValues[] = [];
    const drop: HeldValues[] = [];
    for (const constraint of constraintsOf(model)) {
      if (!dbFieldsOf(constraint).some((dbName) => dbName in changes)) {
        continue;
      }
      const next = valuesIn(constraint, after);
      const previous = valuesIn(constraint, before);
      if (JSON.stringify(next) === JSON.stringify(previous)) continue;
      if (next) claim.push({ constraint, values: next });
      if (previous) drop.push({ constraint, values: previous });
    }
    if (claim.length === 0 && drop.length === 0) return undefined;
    return { id, claim, drop };
  };

  /**
   * The claims of one write, of one row or a page of rows: taken before the
   * rows are written, then either kept, with the dropped values released, or
   * given back.
   */
  const claims = (model: string, alias: string) => {
    let claimed: Entry[] = [];
    let dropped: Entry[] = [];
    let stampedAt = 0;

    const entriesOf = (row: string, held: HeldValues[] = []) =>
      held.map(
        (values): Entry => ({
          ...values,
          row,
          id: idOf(values),
          created: false,
        }),
      );

    /** The reservation document as stored now, or null. */
    const current = async (index: string, id: string) => {
      try {
        const doc = await withRetry(() =>
          client.get<Reservation>({ index, id }),
        );
        return doc._source
          ? { source: doc._source, version: versionOf(doc) }
          : null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    };

    /**
     * Claims one value the bulk claim could not: creates it if it is gone,
     * re-stamps it if the row owns it, and takes it over if it is an orphan,
     * each conditional on what was read. Returns false for a duplicate.
     *
     * These writes are not retried, like the adapter's other conditional
     * writes: one that timed out may have landed and would then lose to
     * itself.
     */
    const claimContested = async (
      index: string,
      entry: Entry,
      seen?: { source: Reservation; version?: Version } | null,
    ) => {
      let reservation = seen;
      for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
        reservation ??= await current(index, entry.id);
        const now = Date.now();
        const document = reservationFor(entry, entry.row, now);
        try {
          if (!reservation) {
            const result = await client.index({
              index,
              id: entry.id,
              op_type: "create",
              document,
            });
            entry.created = true;
            entry.version = versionOf(result);
            return true;
          }
          const owned = reservation.source.owner === entry.row;
          if (!owned) {
            // A reservation whose row does not hold the value is a write in
            // flight until the grace period has passed, an orphan after.
            if (now - Number(reservation.source.claimedAt) < GRACE_MS) {
              return false;
            }
            const owner = await rowById(
              alias,
              reservation.source.owner,
              ...dbFieldsOf(entry.constraint),
            );
            if (holds(owner, entry)) return false;
          }
          if (!reservation.version) {
            reservation = null;
            continue;
          }
          const result = await client.index({
            index,
            id: entry.id,
            document,
            ...reservation.version,
          });
          // Taken over from an orphan, it is not this write's to give back.
          if (!owned) entry.created = false;
          entry.version = versionOf(result);
          return true;
        } catch (error) {
          if (!isVersionConflict(error)) throw error;
          reservation = null;
        }
      }
      throw new Error(
        `Claiming a unique value for a "${model}" row did not complete after ${MAX_CLAIM_ATTEMPTS} attempts because other requests kept changing it`,
      );
    };

    return {
      /**
       * Claims the values `changes` take, in one bulk request, and re-stamps
       * the values they give up so their release can tell whether a later
       * write re-claimed them. Throws a duplicate key error, having given back
       * what it created, if another row holds or is writing a value. Called
       * again when a write reruns, it re-stamps its own claims.
       */
      async claim(changes: RowChange[]) {
        const createdBefore = new Set(
          claimed
            .filter((entry) => entry.created)
            .map((entry) => `${entry.row}\n${entry.id}`),
        );
        claimed = changes.flatMap((change) =>
          entriesOf(change.id, change.claim),
        );
        dropped = changes.flatMap((change) =>
          entriesOf(change.id, change.drop),
        );
        if (claimed.length === 0 && dropped.length === 0) return;

        const index = await ensureIndex(alias);
        stampedAt = Date.now();
        const params = (entry: Entry) => ({
          lang: "painless",
          source: CLAIM_SCRIPT,
          params: { owner: entry.row, now: stampedAt },
        });
        const response = await withRetry(() =>
          client.bulk({
            index,
            operations: [
              ...claimed.flatMap((entry) => [
                { update: { _id: entry.id, retry_on_conflict: 3 } },
                {
                  script: params(entry),
                  upsert: reservationFor(entry, entry.row, stampedAt),
                  _source: true,
                },
              ]),
              ...dropped.flatMap((entry) => [
                { update: { _id: entry.id } },
                { script: params(entry) },
              ]),
            ],
          }),
        );

        const contested: Promise<boolean>[] = [];
        const duplicates: Entry[] = [];
        let failure: estypes.ErrorCause | undefined;
        response.items.forEach((item, position) => {
          const outcome = item.update;
          const entry =
            position < claimed.length
              ? claimed[position]
              : dropped[position - claimed.length];
          if (!outcome || !entry) return;
          if (position >= claimed.length) {
            // Only a value this write re-stamped is its own to release; one
            // another row owns, or none at all, is left alone.
            if (outcome.result === "updated")
              entry.version = versionOf(outcome);
            return;
          }
          if (outcome.result === "created") {
            entry.created = true;
            entry.version = versionOf(outcome);
          } else if (outcome.result === "updated") {
            // Created by an earlier run of this write, it still is its own.
            entry.created = createdBefore.has(`${entry.row}\n${entry.id}`);
            entry.version = versionOf(outcome);
          } else if (outcome.result === "noop") {
            const seen = outcome.get?._source
              ? {
                  source: outcome.get._source as Reservation,
                  version: versionOf(outcome.get),
                }
              : null;
            contested.push(
              claimContested(index, entry, seen).then((claimedIt) => {
                if (!claimedIt) duplicates.push(entry);
                return claimedIt;
              }),
            );
          } else if (outcome.status === 409 || outcome.status === 429) {
            contested.push(
              claimContested(index, entry).then((claimedIt) => {
                if (!claimedIt) duplicates.push(entry);
                return claimedIt;
              }),
            );
          } else {
            failure ??= outcome.error ?? { type: "unexpected bulk response" };
          }
        });
        const settled = await Promise.allSettled(contested);
        const rejected = settled.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failure || rejected || duplicates.length > 0) {
          await deleteUnchanged(
            index,
            claimed.filter((entry) => entry.created),
          );
          if (rejected) throw rejected.reason;
          if (failure) {
            throw new Error(
              `Claiming the unique values of a "${model}" row failed: ${failure.reason ?? failure.type}`,
            );
          }
          const [first] = duplicates;
          throw duplicateError(model, first?.constraint.name ?? "value");
        }
      },

      /**
       * After a write of the rows `ids`: releases the values they gave up,
       * unless a later write re-claimed them since this one re-stamped them.
       */
      async written(ids: Iterable<string>) {
        const rows = new Set(ids);
        await deleteUnchanged(
          indexFor(alias),
          dropped.filter((entry) => rows.has(entry.row)),
        );
      },

      /**
       * After the rows `ids` were certainly not written: gives back the
       * reservations this write created for them, unless re-claimed since.
       */
      async unwritten(ids: Iterable<string>) {
        const rows = new Set(ids);
        await deleteUnchanged(
          indexFor(alias),
          claimed.filter((entry) => entry.created && rows.has(entry.row)),
        );
      },

      /**
       * After the single row `id` failed to be written with `error`: gives
       * back the reservations this write created, unless the write may have
       * landed after all or the row holds the value. A write refused by a
       * migration's write block keeps them for its rerun.
       */
      async failed(id: string, error: unknown) {
        if (isWriteBlocked(error) || mayHaveLanded(error)) return;
        const created = claimed.filter((entry) => entry.created);
        if (created.length === 0) return;
        let row: Source | undefined;
        try {
          row = await rowById(
            alias,
            id,
            ...created.flatMap((entry) => dbFieldsOf(entry.constraint)),
          );
        } catch {
          return;
        }
        await deleteUnchanged(
          indexFor(alias),
          created.filter((entry) => !holds(row, entry)),
        );
      },

      /**
       * The schema name of a value the row no longer owns, if any. A write
       * landing later than half the grace period after its claim may have
       * had one taken over meanwhile; one landing sooner cannot, so it is
       * not asked.
       */
      async lost(): Promise<string | undefined> {
        if (claimed.length === 0 || Date.now() - stampedAt <= GRACE_MS / 2) {
          return undefined;
        }
        const response = await withRetry(() =>
          client.mget<Reservation>({
            index: indexFor(alias),
            ids: claimed.map((entry) => entry.id),
          }),
        );
        const entry = claimed.find((claim, position) => {
          const doc = response.docs[position];
          return !(
            doc &&
            "found" in doc &&
            doc.found &&
            doc._source?.owner === claim.row
          );
        });
        return entry?.constraint.name;
      },
    };
  };

  /**
   * After the rows were deleted: releases the values they held, unless
   * another row has taken one over since.
   */
  const release = async (
    model: string,
    alias: string,
    rows: { id: string; source: Source | undefined }[],
  ) => {
    const operations = rows.flatMap(({ id, source }) =>
      valuesOf(model, source).flatMap((held) => [
        { update: { _id: idOf(held) } },
        {
          script: {
            lang: "painless",
            source: RELEASE_SCRIPT,
            params: { owner: id },
          },
        },
      ]),
    );
    if (operations.length === 0) return;
    const index = await ensureIndex(alias);
    // Repeating it is safe, and a failure only leaves orphans behind.
    await withRetry(() => client.bulk({ index, operations })).catch(() => {});
  };

  /**
   * Reserves the values of rows that hold none, as rows written before
   * reservations existed do, and reports values more than one row holds.
   * Changes nothing for rows already reserved, so it can run every time.
   */
  const backfill = async (
    defaultModel: string,
    alias: string,
  ): Promise<DuplicateValues[]> => {
    const constraints = constraintsOfDefault(defaultModel);
    if (constraints.length === 0) return [];
    if (!(await withRetry(() => client.indices.exists({ index: alias })))) {
      return [];
    }
    const index = await ensureIndex(alias);
    const dbNames = [...new Set(constraints.flatMap(dbFieldsOf))];
    const duplicates = new Map<string, { field: string; ids: Set<string> }>();

    let searchAfter: estypes.SortResults | undefined;
    while (true) {
      const page = await withRetry(() =>
        client.search<Source>({
          index: alias,
          size: BACKFILL_PAGE_SIZE,
          sort: [{ id: "asc" }],
          search_after: searchAfter,
          _source: dbNames,
          track_total_hits: false,
        }),
      );
      const hits = page.hits.hits;
      if (hits.length === 0) break;
      searchAfter = hits[hits.length - 1]?.sort;

      const entries = hits.flatMap((hit): BackfillEntry[] =>
        constraints.flatMap((constraint) => {
          const values = valuesIn(constraint, hit._source);
          if (!hit._id || !values) return [];
          const held = { constraint, values };
          return [
            { ...held, row: hit._id, source: hit._source, id: idOf(held) },
          ];
        }),
      );
      if (entries.length > 0) {
        const claimedAt = Date.now();
        const response = await withRetry(() =>
          client.bulk({
            index,
            operations: entries.flatMap((entry) => [
              { create: { _id: entry.id } },
              reservationFor(entry, entry.row, claimedAt),
            ]),
          }),
        );
        const taken = entries.filter((entry, position) => {
          const outcome = response.items[position]?.create;
          if (outcome?.status === 409) return true;
          if (!outcome || outcome.error) {
            throw new Error(
              `Reserving the unique values of "${alias}" failed: ${outcome?.error?.reason ?? outcome?.error?.type ?? "unexpected bulk response"}`,
            );
          }
          return false;
        });
        if (taken.length > 0) {
          await resolveTaken(index, alias, taken, dbNames, (entry, owner) => {
            const group = duplicates.get(entry.id) ?? {
              field: entry.constraint.name,
              ids: new Set<string>(),
            };
            group.ids.add(owner).add(entry.row);
            duplicates.set(entry.id, group);
          });
        }
      }
      if (hits.length < BACKFILL_PAGE_SIZE) break;
    }

    return [...duplicates.values()].map(({ field, ids }) => ({
      model: defaultModel,
      field,
      ids: [...ids].sort(),
    }));
  };

  /**
   * For backfilled values that already had a reservation: reports those whose
   * owner holds the value too, and takes over orphans past the grace period.
   * A reservation still in flight is left to its write.
   */
  const resolveTaken = async (
    index: string,
    alias: string,
    taken: BackfillEntry[],
    dbNames: string[],
    onDuplicate: (entry: BackfillEntry, owner: string) => void,
  ) => {
    const ids = [...new Set(taken.map((entry) => entry.id))];
    const response = await withRetry(() =>
      client.mget<Reservation>({ index, ids }),
    );
    const reservations = new Map<
      string,
      { source: Reservation; version?: Version }
    >();
    for (const doc of response.docs) {
      if ("found" in doc && doc.found && doc._source) {
        reservations.set(doc._id, {
          source: doc._source,
          version: versionOf(doc),
        });
      }
    }
    // Only rows other than the backfilled one can be duplicates.
    const owners = await rowsById(
      alias,
      [
        ...new Set(
          taken.flatMap((entry) => {
            const owner = reservations.get(entry.id)?.source.owner;
            return owner && owner !== entry.row ? [owner] : [];
          }),
        ),
      ],
      dbNames,
    );
    for (const entry of taken) {
      const reservation = reservations.get(entry.id);
      // Released since the bulk ran; the next run reserves it.
      if (!reservation || reservation.source.owner === entry.row) continue;
      const owner = reservation.source.owner;
      if (holds(owners.get(owner), entry)) {
        onDuplicate(entry, owner);
        continue;
      }
      const now = Date.now();
      if (
        !reservation.version ||
        now - Number(reservation.source.claimedAt) < GRACE_MS
      ) {
        continue;
      }
      try {
        const document = reservationFor(entry, entry.row, now);
        const result = await client.index({
          index,
          id: entry.id,
          document,
          ...reservation.version,
        });
        reservation.source = document;
        reservation.version = versionOf(result);
        // A later row of this page with the same value is then a duplicate
        // of this one.
        owners.set(entry.row, entry.source ?? {});
      } catch (error) {
        if (!isVersionConflict(error)) throw error;
      }
    }
  };

  return {
    constraintsOf,
    fieldsOf,
    constrainedFieldIn,
    valuesOf,
    changeOf,
    claims,
    release,
    backfill,
  };
};
