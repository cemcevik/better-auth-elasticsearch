# Changelog

## 0.3.2

### Fixed

- `update` no longer fails with a version conflict when another request
  changes the same row at the same time, as parallel requests refreshing one
  session do. It reads the row again and applies the update to it.
- `create` and `update` no longer report a failure when a write succeeded but
  its response was lost and the retry met the row it had just written.
  `create` reported that as a "duplicate key" error.
- `delete` no longer fails when the row is already gone by the time its
  write arrives: deleted by another request, or by its own earlier attempt
  whose response was lost.
- `findMany` returns rows in a fixed order, by `id` when no sort is given and
  by `id` among rows the sort ranks equal, so pages fetched with `offset` no
  longer repeat or skip rows.

### Changed

- The README says to set `numberOfReplicas` on clusters with several nodes,
  and that `findMany` cannot page past 10,000 rows.

## 0.3.1

### Changed

- The package no longer ships its TypeScript sources and source maps, which
  made up over half of its size. The compiled JavaScript and type
  declarations are unchanged.

## 0.3.0

### Added

- Unique fields other than `id`, such as `user.email`, are enforced. Each
  value is reserved in a `<alias>_unique` index, so two concurrent requests
  can no longer both create a row with it. The loser fails with a "duplicate
  key" error.
- Unique indexes declared on a table are enforced the same way, including
  indexes over several fields.
- The `skipUniqueFor` option lists unique fields to leave unenforced. It
  defaults to `["session.token"]`, a random value on every sign-in.
- `migrate(auth)` reserves the unique values of existing rows and returns
  `duplicates`, the values several rows already share.

### Changed

- `incrementOne` refuses to set a unique field; use `update` instead.
- `deleteMany` on a model with an enforced unique field deletes page by page
  instead of by query, to free each row's values.

After upgrading, run `migrate(auth)` once so rows written by 0.2.0 are
reserved.

## 0.2.0

Published as `better-auth-elasticsearch`. Earlier versions were published as
`@cemcevik/better-auth-elasticsearch`.

### Breaking changes

- Requires `better-auth` 1.7.23 or later; earlier lines are not supported.
- Each model is stored behind an alias, `<prefix>_<model>`, over a versioned
  index, `<prefix>_<model>_v1`, with explicit mappings and dynamic mapping
  off. Indices created by 0.1.x are not read; the adapter refuses to start on
  a plain index where it expects an alias.
- The `sessionRetentionDays` and `verificationRetentionDays` options and their
  lifecycle policies are removed. The policies deleted whole indices rather
  than expired rows. Use `purgeExpired()` instead.
- `number_of_shards` and `number_of_replicas` are renamed to `numberOfShards`
  and `numberOfReplicas`, and the `ElasticAdapterConfig` type to
  `ElasticsearchAdapterConfig`.
- Matching is case-sensitive by default, as on Better Auth's other adapters.

### Added

- Support for Elasticsearch 8.19 servers (with the 8.x client) next to 9.x.
- `migrate(auth)` moves models whose field types changed to a new index
  version, converting stored values, while writes wait instead of failing.
- `purgeExpired(auth)` deletes expired sessions and verification tokens.
- Native, race-free `consumeOne` and `incrementOne`.
- `createSchema`, so `npx auth generate` writes the expected mappings to a
  file for review.
- The `refresh` option: `"immediate"` (default) or `"wait_for"`.
- The `writeBlockTimeoutMs` option.
- A Next.js example app in `examples/nextjs`.

### Fixed

- Strings longer than 1024 characters, such as Microsoft ID and access
  tokens, are now indexed up to 8191 characters and always stored intact.
- Creating a row with an existing id fails at once with a "duplicate key"
  error, which Better Auth recognises, instead of being retried.
- Null comparisons match missing fields, mixed AND/OR clauses group as on
  Better Auth's first-party adapters, and `updateMany` and `deleteMany` return
  exact counts, including under concurrent writes.
- Dates are returned as `Date` objects.
- The built package loads in plain Node, not only through a bundler.

## 0.1.x

Initial releases, built against `better-auth` 1.4.
