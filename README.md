# @cemcevik/better-auth-elasticsearch

Elasticsearch adapter for Better Auth.

## Install

```bash
pnpm add @cemcevik/better-auth-elasticsearch better-auth @elastic/elasticsearch
```

`better-auth` and `@elastic/elasticsearch` are peer dependencies.

## Usage

```ts
import { Client } from "@elastic/elasticsearch";
import { betterAuth } from "better-auth";
import { elasticsearchAdapter } from "@cemcevik/better-auth-elasticsearch";

const client = new Client({
  node: process.env.ELASTICSEARCH_URL!,
});

export const auth = betterAuth({
  database: elasticsearchAdapter({
    client,
    indexPrefix: "better_auth",
    maxRetries: 3,
    // "immediate" (default): every write is searchable on return.
    // "wait_for": wait for the next scheduled refresh; less cluster load.
    // deleteMany always refreshes immediately.
    refresh: "immediate",
    number_of_shards: 1,
    number_of_replicas: 0,
  }),
});
```

## Purging expired rows

better-auth deletes an expired session only when its token is presented
again, so the session index keeps growing. `purgeExpired` deletes the session
and verification rows whose `expiresAt` has passed and reports how many it
deleted. The adapter runs no background work, so call it from your own
scheduler:

```ts
import { purgeExpired } from "@cemcevik/better-auth-elasticsearch";

const { session, verification } = await purgeExpired(auth);
```

Purging is a write: while `migrate()` moves the session or verification
index, it waits like any other write and fails after `writeBlockTimeoutMs`.
The next scheduled run picks up what it missed.

## Development

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

For integration tests, start a local single-node Elasticsearch (basic auth
on, user `elastic`, password `changeme`) and point the tests at it:

```bash
docker compose up -d --wait
ELASTICSEARCH_URL=http://127.0.0.1:9200 \
ELASTICSEARCH_USERNAME=elastic \
ELASTICSEARCH_PASSWORD=changeme \
pnpm test:integration
docker compose down
```

Set `ES_VERSION` to choose the server image tag (default `9.5.5`).

## CI / Release Flow

- Push to `dev`: runs CI (Biome, typecheck, build, integration tests with Elasticsearch service).
- Push to `main`: runs CI, bumps patch version, commits version bump, and publishes to npm.
- Publish step is guarded to skip if the target version already exists on npm.

## License

Apache-2.0
