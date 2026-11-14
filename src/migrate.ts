import type { MigratedIndex } from "./index-layout.js";

/** What migrate() did to one model whose mapping had changed. */
export interface MigratedModel extends MigratedIndex {
  /** The model's name in the better-auth schema, such as "user". */
  model: string;
  /** Whether `from` was deleted (see `deleteOldIndices`). */
  fromDeleted: boolean;
}

export interface MigrateOptions {
  /**
   * Deletes each model's previous index once every model has moved and
   * `oldIndexGraceMs` has passed. Off by default, so the old index stays as
   * a rollback.
   */
  deleteOldIndices?: boolean;
  /**
   * How long, in milliseconds, to keep the old indices after the last swap
   * before deleting them (default 60000). A write that read a row just
   * before a swap is still aimed at the old index; while that exists the
   * write meets its write block and tries again on the new one. Deleted too
   * soon, Elasticsearch would create an empty index of that name for the
   * write instead, and the write would fail. Keep it above the
   * Elasticsearch client's request timeout (30 seconds by default).
   */
  oldIndexGraceMs?: number;
}

export interface MigrationResult {
  /** The models that moved to a new index; models already matching are left out. */
  migrated: MigratedModel[];
}

/** Where the adapter hands migrate() the code that knows its indices. */
export const MIGRATOR = Symbol("better-auth-elasticsearch migrator");

export type Migrator = (
  options: Required<MigrateOptions>,
) => Promise<MigrationResult>;

/** The part of a better-auth instance migrate() uses. */
export interface AuthWithContext {
  $context: Promise<{ adapter: { options?: object | undefined } }>;
}

/**
 * Moves every model whose field types no longer match the better-auth schema
 * to a new index version behind the same alias, for an auth instance whose
 * database is `elasticsearchAdapter(...)`. Reads carry on throughout; writes
 * to a model being moved wait until it is done (see `writeBlockTimeoutMs`).
 * Models already matching are left alone, so running it again is safe.
 */
export const migrate = async (
  auth: AuthWithContext,
  options: MigrateOptions = {},
): Promise<MigrationResult> => {
  const { adapter } = await auth.$context;
  const migrator = (adapter.options as Record<symbol, unknown> | undefined)?.[
    MIGRATOR
  ] as Migrator | undefined;
  if (!migrator) {
    throw new Error(
      "migrate() needs a better-auth instance whose database is elasticsearchAdapter() from better-auth-elasticsearch.",
    );
  }
  return migrator({
    deleteOldIndices: options.deleteOldIndices ?? false,
    oldIndexGraceMs: options.oldIndexGraceMs ?? 60_000,
  });
};
