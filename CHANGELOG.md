# Changelog

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
