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
    sessionRetentionDays: 30,
    verificationRetentionDays: 7,
    maxRetries: 3,
    number_of_shards: 1,
    number_of_replicas: 0,
  }),
});
```

## Development

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

For integration tests:

```bash
ELASTICSEARCH_URL=http://127.0.0.1:9200 BETTER_AUTH_FORCE_ELASTIC_TESTS=true pnpm test:integration
```

## CI / Release Flow

- Push to `dev`: runs CI (Biome, typecheck, build, integration tests with Elasticsearch service).
- Push to `main`: runs CI, bumps patch version, commits version bump, and publishes to npm.
- Publish step is guarded to skip if the target version already exists on npm.

## License

Apache-2.0
