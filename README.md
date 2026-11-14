# better-auth-elasticsearch

[![npm](https://img.shields.io/npm/v/better-auth-elasticsearch)](https://www.npmjs.com/package/better-auth-elasticsearch)
[![CI](https://github.com/cemcevik/better-auth-elasticsearch/actions/workflows/ci.yml/badge.svg)](https://github.com/cemcevik/better-auth-elasticsearch/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/better-auth-elasticsearch)](LICENSE.md)

Elasticsearch database adapter for [Better Auth](https://www.better-auth.com).

- Explicit mappings derived from your schema, including plugin fields
- Schema migrations without downtime
- Atomic one-time tokens and counters
- No background work, safe on serverless

## Installation

```bash
npm install better-auth-elasticsearch better-auth @elastic/elasticsearch
```

| Requirement              | Version                                  |
| ------------------------ | ---------------------------------------- |
| `better-auth`            | ≥ 1.7.23                                 |
| Elasticsearch            | 8.19 or 9.x                              |
| `@elastic/elasticsearch` | Same major as the server (8.x or 9.x)    |
| Node.js                  | ≥ 22                                     |

## Usage

```ts
import { Client } from "@elastic/elasticsearch";
import { betterAuth } from "better-auth";
import { elasticsearchAdapter } from "better-auth-elasticsearch";

const client = new Client({ node: process.env.ELASTICSEARCH_URL });

export const auth = betterAuth({
  database: elasticsearchAdapter({ client, indexPrefix: "auth" }),
  emailAndPassword: { enabled: true },
});
```

Indices are created on first use.

### Options

| Option                | Default       | Description                                                       |
| --------------------- | ------------- | ----------------------------------------------------------------- |
| `client`              | required      | An `@elastic/elasticsearch` client.                               |
| `indexPrefix`         | `""`          | Prefix for alias and index names (`<prefix>_<model>`).            |
| `refresh`             | `"immediate"` | `"immediate"` or `"wait_for"`. See [Refresh](#refresh).           |
| `writeBlockTimeoutMs` | `30000`       | How long writes wait during a migration before failing.           |
| `maxRetries`          | `3`           | Retries for transient errors (timeouts, 429, 5xx).                |
| `numberOfShards`      | `1`           | Primary shards per index.                                         |
| `numberOfReplicas`    | `0`           | Replicas per index. See [Replicas](#replicas).                    |
| `debugLogs`           | `false`       | Better Auth adapter debug logging.                                |
| `skipUniqueFor`       | `["session.token"]` | Unique fields left unenforced, as `"model.field"`. Replaces the default. |

### Refresh

With the default `"immediate"`, every write is searchable as soon as it
returns, which is what Better Auth expects. `"wait_for"` waits for the next
scheduled refresh instead: slower writes, less cluster load. `deleteMany`
always refreshes immediately.

### Replicas

The default of `0` keeps one copy of each index, which suits a single-node
cluster. On a cluster with several nodes, set `numberOfReplicas` to at least
`1`: without a replica, losing a node loses the auth data stored on it. The
setting applies when an index is created.

## Example

[`examples/nextjs`](examples/nextjs) is a small Next.js app with email and
password sign-up, sign-in and sign-out, an additional user field, and scripts
for `migrate()` and `purgeExpired()`. It runs against the repository's Docker
Compose Elasticsearch:

```bash
docker compose up -d --wait
cd examples/nextjs
pnpm adapter:install
cp .env.example .env
pnpm dev
```

## Index layout

Each model is an alias (`auth_user`) over a versioned index (`auth_user_v1`).
Mappings come from the Better Auth schema with dynamic mapping off:

| Field type                 | Mapping                               |
| -------------------------- | ------------------------------------- |
| `string`, enums, arrays    | `keyword` (`ignore_above: 8191`)      |
| `number`                   | `double`, or `long` for `bigint`      |
| `boolean`                  | `boolean`                             |
| `date`                     | `date`                                |
| `json`                     | `object` (`enabled: false`)           |

On first use the adapter adds new fields to the mapping and fails with a clear
error if a field's type has changed. Run `migrate()` to apply the change.

To review mappings in a pull request:

```bash
npx auth generate --output elasticsearch-mappings.json
```

## Migrations

```ts
import { migrate } from "better-auth-elasticsearch";

const { migrated, duplicates } = await migrate(auth);
```

For each model whose field types changed, `migrate()` creates the next index
version, copies the data (converting values to the new types), and swaps the
alias atomically. Reads continue throughout, and writes wait until the swap
instead of failing. A value that cannot be converted rolls the migration back.

The old index is kept for rollback; pass `{ deleteOldIndices: true }` to remove
it. Running `migrate()` again is safe.

`migrate()` also reserves the unique values of rows written before they were
enforced (see [Caveats](#caveats)). `duplicates` lists values that several
rows already share, by row id; resolve those by hand.

## Purging expired rows

Better Auth does not delete expired sessions on its own. Call `purgeExpired()`
from a scheduled job:

```ts
import { purgeExpired } from "better-auth-elasticsearch";

const { session, verification } = await purgeExpired(auth);
```

`migrate()` and `purgeExpired()` work in plain Node scripts.

## Caveats

- **Ids are strings.** Elasticsearch has no auto-increment, so Better Auth's
  numeric id option (`generateId: "serial"`) cannot be used.
- **No transactions.** Elasticsearch has none, so Better Auth runs multi-step
  operations one write at a time. If one fails midway, earlier writes stay.
- **Unique fields are reserved.** Each value of a `unique` field, such as
  `email`, is reserved in a `<alias>_unique` index, so concurrent requests
  cannot both take it. Unique indexes are covered too, including compound
  ones, which reserve each combination of values. Values are compared exactly
  as stored. A value left reserved by a crashed write is freed after two
  minutes. Fields listed in `skipUniqueFor` are not enforced; name a
  compound index as `"model.fieldA+fieldB"`. Run `migrate()` once to reserve rows
  written by an earlier version.
- **Lists stop at 10,000 rows.** `findMany` returns rows in a fixed order, by
  `id` unless a sort is given, but Elasticsearch refuses a page that ends
  past its `index.max_result_window`, 10,000 rows by default.
- **Joins work**, through Better Auth's follow-up queries, since Elasticsearch
  has no joins of its own.

## Contributing

```bash
pnpm install
docker compose up -d --wait   # Elasticsearch 9.5.5, user elastic / changeme
ELASTICSEARCH_URL=http://127.0.0.1:9200 \
ELASTICSEARCH_USERNAME=elastic \
ELASTICSEARCH_PASSWORD=changeme \
pnpm test:integration
```

`pnpm check` runs lint, typecheck and unit tests. To test against 8.19, set
`ES_VERSION=8.19.25` for Docker Compose and `ELASTICSEARCH_CLIENT_MAJOR=8` for
the tests.

Releases are published from `main` when the version in `package.json` is not
yet on npm.

## License

[Apache-2.0](LICENSE.md)
