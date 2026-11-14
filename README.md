# better-auth-elasticsearch

An Elasticsearch database adapter for [Better Auth](https://www.better-auth.com).

[![CI](https://github.com/cemcevik/better-auth-elasticsearch/actions/workflows/ci.yml/badge.svg)](https://github.com/cemcevik/better-auth-elasticsearch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/better-auth-elasticsearch)](https://www.npmjs.com/package/better-auth-elasticsearch)

- Passes Better Auth's official adapter test suites against real Elasticsearch
  8.19 and 9.x servers.
- Explicit index mappings derived from your Better Auth schema, plugin fields
  included, behind aliases that a migration can move without downtime.
- Atomic single-use tokens and counters (`consumeOne`, `incrementOne`), so a
  one-time code cannot be used twice by simultaneous requests.
- No timers or background work, so it is safe on serverless hosts.

## Compatibility

| Package                  | Supported versions                                 |
| ------------------------ | -------------------------------------------------- |
| `better-auth`            | 1.7.23 and later 1.x                               |
| Elasticsearch server     | 8.19 and 9.x                                       |
| `@elastic/elasticsearch` | 8.x for an 8.19 server, 9.x for a 9.x server       |
| Node.js                  | 22 and later                                       |

Use the client major that matches your server. An 8.19 server rejects the 9.x
client.

## Install

```bash
pnpm add better-auth-elasticsearch better-auth @elastic/elasticsearch
```

`better-auth` and `@elastic/elasticsearch` are peer dependencies, so your app
keeps a single copy of each.

## Usage

```ts
import { Client } from "@elastic/elasticsearch";
import { betterAuth } from "better-auth";
import { elasticsearchAdapter } from "better-auth-elasticsearch";

const client = new Client({
  node: process.env.ELASTICSEARCH_URL,
  auth: {
    username: process.env.ELASTICSEARCH_USERNAME!,
    password: process.env.ELASTICSEARCH_PASSWORD!,
  },
});

export const auth = betterAuth({
  database: elasticsearchAdapter({ client, indexPrefix: "auth" }),
  emailAndPassword: { enabled: true },
});
```

There is no setup step: each model's index is created on first use.

A complete Next.js app lives in [`examples/nextjs`](examples/nextjs).

### Options

| Option                | Default       | Description                                                                                                                                                |
| --------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client`              | (required)    | An `@elastic/elasticsearch` client.                                                                                                                        |
| `indexPrefix`         | `""`          | Prepended to every alias and index name as `<prefix>_<model>`.                                                                                             |
| `refresh`             | `"immediate"` | When a write becomes searchable. See [Refresh](#refresh).                                                                                                  |
| `writeBlockTimeoutMs` | `30000`       | How long a write waits while `migrate()` moves its model before it fails.                                                                                  |
| `maxRetries`          | `3`           | Retries, with exponential backoff, for requests that failed for a transient reason (timeout, dropped connection, 429 or 5xx).                              |
| `numberOfShards`      | `1`           | Primary shards of each index the adapter creates.                                                                                                          |
| `numberOfReplicas`    | `0`           | Replicas of each index the adapter creates. Raise it on a multi-node cluster.                                                                              |
| `debugLogs`           | `false`       | Better Auth's adapter debug logging.                                                                                                                       |

### Refresh

By default every write refreshes its index, so a row written in one request is
found by the next. That is what Better Auth expects, and it suits most apps.

On a large deployment, `refresh: "wait_for"` makes each write wait for
Elasticsearch's next scheduled refresh instead (every second by default):
writes take longer, and the cluster does less work. `deleteMany` always
refreshes immediately, as Elasticsearch cannot make a delete-by-query wait.

## How data is stored

Each model is an alias, `<prefix>_<model>` (such as `auth_user`), over a
versioned index, `<prefix>_<model>_v1`. All reads and writes go through the
alias.

Mappings are explicit, with dynamic mapping off:

| Better Auth field type     | Elasticsearch mapping                   |
| -------------------------- | --------------------------------------- |
| `string`, enums and arrays | `keyword` with `ignore_above: 8191`     |
| `number`                   | `double` (`long` for `bigint: true`)    |
| `boolean`                  | `boolean`                               |
| `date`                     | `date`                                  |
| `json`                     | `object` with `enabled: false`          |

Matching is case-sensitive unless Better Auth asks for case-insensitive
matching. Strings longer than 8191 characters, such as large OAuth tokens, are
stored and returned intact but cannot be searched.

The first time a process uses a model, the adapter compares the live mapping
with the one the schema needs:

- Fields the index lacks, for example from a newly enabled plugin, are added.
- A field whose type changed fails with an error that names the field and
  tells you to run `migrate()`.
- Fields only the index has are left alone.
- A plain index where the alias belongs fails with an error and changes
  nothing.

To review the mappings in a pull request, write them to a file with the Better
Auth CLI:

```bash
npx auth generate --output elasticsearch-mappings.json
```

The file is for review only; nothing reads it back.

## Migrating after a schema change

When a field's type changes, `migrate()` moves each affected model to the next
index version. Call it from a script, passing your auth instance:

```ts
// scripts/migrate.ts
import { migrate } from "better-auth-elasticsearch";
import { auth } from "../src/auth";

const { migrated } = await migrate(auth);
for (const { model, from, to } of migrated) {
  console.log(`${model}: moved from ${from} to ${to}`);
}
```

For each model whose mapping changed, `migrate()`:

1. creates the next index version with the new mapping,
2. blocks writes to the old index,
3. copies every row, converting each changed field's stored value to the new
   type (`keyword`, `double`, `long`, `boolean` or `date`),
4. points the alias at the new index in one atomic step.

Reads carry on throughout. Writes to a model being moved wait until it is done,
for up to `writeBlockTimeoutMs`, so users signing in during a migration see a
slow request, not an error. A value that cannot be converted, such as `"abc"`
for a number field, rolls the migration back with an error naming the row, the
field and the value. Models whose mapping already matches are skipped, so
running `migrate()` again is safe, and it also finishes a migration that was
interrupted.

The old index is kept as a rollback. To delete it, pass
`{ deleteOldIndices: true }`. The deletion waits `oldIndexGraceMs` (default
60000) after the last swap so that writes already aimed at the old index can
retry on the new one.

## Purging expired rows

Better Auth deletes an expired session only when its token is presented again,
so the session index keeps growing. `purgeExpired()` deletes the session and
verification rows whose `expiresAt` has passed and reports how many it deleted.
The adapter runs no background work, so call it from your own scheduler (a
cron job, a queue, a serverless schedule):

```ts
import { purgeExpired } from "better-auth-elasticsearch";

const { session, verification } = await purgeExpired(auth);
```

While `migrate()` moves the session or verification index, purging waits like
any other write. A run that times out is caught up by the next one.

Both `migrate()` and `purgeExpired()` run in plain Node, so you can call them
from a script with `node` or `tsx`; no bundler is needed.

## Not supported

- **Numeric ids.** Ids are strings (`advanced.database.generateId: "serial"`
  will not work).
- **Transactions.** Better Auth runs the steps of a multi-step operation one
  after another.
- **Uniqueness beyond `id`.** Creating a row with an existing id fails, but
  other fields declared `unique` (such as `email`) are not enforced by the
  adapter. Better Auth checks for an existing user before creating one, which
  covers its own flows, but two simultaneous sign-ups with the same email can
  both succeed.
- **Native joins.** Better Auth's fallback queries serve joins; they pass the
  official joins suite.

## Development

```bash
pnpm install
pnpm lint
pnpm typecheck   # against both client majors
pnpm build
pnpm test        # unit tests; integration tests are skipped without a server
```

The integration tests need a running Elasticsearch. The compose file starts a
single node with basic auth on (user `elastic`, password `changeme`):

```bash
docker compose up -d --wait
ELASTICSEARCH_URL=http://127.0.0.1:9200 \
ELASTICSEARCH_USERNAME=elastic \
ELASTICSEARCH_PASSWORD=changeme \
pnpm test:integration
docker compose down
```

`ES_VERSION` picks the server image (default `9.5.5`). To test an 8.19 server,
use the 8.x client, installed as the dev dependency `@elastic/elasticsearch-8`.
`ES_PORT` and a separate project name let it run next to the 9.x one:

```bash
ES_VERSION=8.19.25 ES_PORT=9208 docker compose -p adapter-es8 up -d --wait
ELASTICSEARCH_URL=http://127.0.0.1:9208 \
ELASTICSEARCH_USERNAME=elastic \
ELASTICSEARCH_PASSWORD=changeme \
ELASTICSEARCH_CLIENT_MAJOR=8 \
pnpm test:integration
docker compose -p adapter-es8 down
```

### CI and releases

- Every push and pull request to `main` or `dev` runs lint, typecheck, build
  and all tests in two jobs: Elasticsearch 8.19 with the 8.x client, and 9.x
  with the 9.x client.
- A weekly run (Monday 06:00 UTC) does the same against the newest published
  Better Auth, to catch upstream contract changes early.
- The version in `package.json` is set by hand. A push to `main` publishes to
  npm only when that version is not on npm yet, so merging a change that leaves
  the version alone publishes nothing.

## License

[Apache-2.0](LICENSE.md)
