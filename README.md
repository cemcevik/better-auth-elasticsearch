# @cemcevik/better-auth-elasticsearch

Elasticsearch adapter for Better Auth.

## Install

```bash
pnpm add @cemcevik/better-auth-elasticsearch better-auth @elastic/elasticsearch
```

`better-auth` and `@elastic/elasticsearch` are peer dependencies.

Supported Elasticsearch servers are 8.19 and 9.x. Install the client major that
matches your server: `@elastic/elasticsearch@8` for an 8.19 server (it rejects
the 9.x client), `@elastic/elasticsearch@9` for a 9.x server.

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

Set `ES_VERSION` to choose the server image tag (default `9.5.5`). To test an
8.19 server, run it with the 8.x client (installed as the dev dependency
`@elastic/elasticsearch-8`); `ES_PORT` and a separate project name let it run
next to the 9.x one:

```bash
ES_VERSION=8.19.25 ES_PORT=9208 docker compose -p adapter-es8 up -d --wait
ELASTICSEARCH_URL=http://127.0.0.1:9208 \
ELASTICSEARCH_USERNAME=elastic \
ELASTICSEARCH_PASSWORD=changeme \
ELASTICSEARCH_CLIENT_MAJOR=8 \
pnpm test:integration
docker compose -p adapter-es8 down
```

`pnpm typecheck` checks the source against both client majors.

## CI / Release Flow

- Push or pull request to `main` or `dev`: runs CI (Biome, typecheck, build, all tests) in two jobs, Elasticsearch 8.19 with the 8.x client and 9.x with the 9.x client, both with basic auth on.
- Weekly (Monday 06:00 UTC): the same jobs against the newest published better-auth.
- Push to `main`: runs CI, bumps patch version, commits version bump, and publishes to npm.
- Publish step is guarded to skip if the target version already exists on npm.

## License

Apache-2.0
