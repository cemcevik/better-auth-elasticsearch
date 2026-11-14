export {
  elasticsearchAdapter,
  type ElasticsearchAdapterConfig,
} from "./elasticsearch-adapter.js";
export {
  migrate,
  type MigrateOptions,
  type MigratedModel,
  type MigrationResult,
} from "./migrate.js";
export { purgeExpired, type PurgeResult } from "./purge.js";
