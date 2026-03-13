import { randomUUID } from "node:crypto";

import { Client } from "@elastic/elasticsearch";
import { runAdapterTest } from "better-auth/adapters/test";
import { afterAll, beforeAll, describe } from "vitest";

const hasElasticEnv =
  typeof process.env.ELASTICSEARCH_URL === "string" &&
  process.env.ELASTICSEARCH_URL.length > 0;

const forceElasticTests =
  process.env.BETTER_AUTH_FORCE_ELASTIC_TESTS === "true";

function getElasticUrl() {
  const value = process.env.ELASTICSEARCH_URL;
  if (!value && forceElasticTests) {
    throw new Error(
      "ELASTICSEARCH_URL is required when BETTER_AUTH_FORCE_ELASTIC_TESTS=true",
    );
  }

  return value ?? "http://127.0.0.1:9200";
}

describe.skipIf(!hasElasticEnv && !forceElasticTests)(
  "elasticsearchAdapter integration",
  () => {
    const indexPrefix = `ba_test_${Date.now()}_${randomUUID().slice(0, 8)}`;

    let client;

    beforeAll(async () => {
      const node = getElasticUrl();
      const username = process.env.ELASTICSEARCH_USERNAME;
      const password = process.env.ELASTICSEARCH_PASSWORD;

      client = new Client({
        node,
        ...(username && password
          ? {
              auth: {
                username,
                password,
              },
            }
          : {}),
      });
    });

    afterAll(async () => {
      if (!client) return;

      try {
        const aliases = await client.indices.getAlias({
          name: `${indexPrefix}_*`,
          ignore_unavailable: true,
        });

        const indexNames = Object.keys(aliases ?? {});
        if (!indexNames.length) return;

        await client.indices.delete({
          index: indexNames,
          ignore_unavailable: true,
        });
      } catch {
        return;
      }
    });

    runAdapterTest({
      getAdapter: async (betterAuthOptions = {}) => {
        const { elasticsearchAdapter } = await import(
          "../src/elasticsearch-adapter"
        );

        const adapterFactory = elasticsearchAdapter({
          client,
          indexPrefix,
          sessionRetentionDays: 30,
          verificationRetentionDays: 7,
          debugLogs: {
            isRunningAdapterTests: true,
          },
        });

        return adapterFactory(betterAuthOptions);
      },
    });
  },
);
