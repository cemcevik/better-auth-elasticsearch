import type { MigratedIndex } from "./index-layout";

/** What migrate() did to one model whose mapping had changed. */
export interface MigratedModel extends MigratedIndex {
  /** The model's name in the better-auth schema, such as "user". */
  model: string;
}

export interface MigrateOptions {
  /**
   * Deletes each model's previous index once its alias points at the new one.
   * Off by default, so the old index stays as a rollback.
   *
   * Only turn it on when the app is idle. A conditional write (an update or
   * an atomic consume or increment) that read a row just before the swap is
   * aimed at the old index; while that index exists the write meets its
   * write block and tries again on the new one. Once it is deleted,
   * Elasticsearch instead creates an empty index of the same name for that
   * write, which then fails: an update throws a version conflict, and
   * updateMany skips the row as if it had been deleted. The empty index is
   * left behind.
   */
  deleteOldIndices?: boolean;
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
      "migrate() needs a better-auth instance whose database is elasticsearchAdapter() from @cemcevik/better-auth-elasticsearch.",
    );
  }
  return migrator({ deleteOldIndices: options.deleteOldIndices ?? false });
};
