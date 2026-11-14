import { randomUUID } from "node:crypto";

import { createTestSuite, testAdapter } from "@better-auth/test-utils/adapter";
import { Client } from "@elastic/elasticsearch";
import { getAuthTables } from "better-auth/db";
import { describe, expect, it } from "vitest";

import { elasticsearchAdapter } from "../src/elasticsearch-adapter";

const elasticUrl = process.env.ELASTICSEARCH_URL;
const forceElasticTests =
  process.env.BETTER_AUTH_FORCE_ELASTIC_TESTS === "true";

if (forceElasticTests && !elasticUrl) {
  throw new Error(
    "ELASTICSEARCH_URL is required when BETTER_AUTH_FORCE_ELASTIC_TESTS=true",
  );
}

const smokeTestSuite = createTestSuite(
  "smoke",
  {},
  ({ adapter, generate }) => ({
    "create a user and find it by id": async () => {
      const user = await generate("user");
      const created = await adapter.create({
        model: "user",
        data: user,
        forceAllowId: true,
      });

      const found = await adapter.findOne({
        model: "user",
        where: [{ field: "id", value: created.id }],
      });

      expect(found).toEqual(created);
      expect(found?.email).toBe(user.email);
      expect(found?.createdAt).toBeInstanceOf(Date);
    },
  }),
);

const createClient = () => {
  const username = process.env.ELASTICSEARCH_USERNAME;
  const password = process.env.ELASTICSEARCH_PASSWORD;
  return new Client({
    node: elasticUrl,
    ...(username && password ? { auth: { username, password } } : {}),
  });
};

/** Deletes every index and lifecycle policy created under the run's prefix. */
const deleteTestIndices = async (client, indexPrefix) => {
  const indices = await client.indices.get({
    index: `${indexPrefix}_*`,
    ignore_unavailable: true,
    allow_no_indices: true,
  });
  const names = Object.keys(indices);
  if (names.length > 0) await client.indices.delete({ index: names });

  const policies = await client.ilm.getLifecycle();
  await Promise.all(
    Object.keys(policies)
      .filter((name) => name.startsWith(`${indexPrefix}_`))
      .map((name) => client.ilm.deleteLifecycle({ name })),
  );
};

describe("elasticsearchAdapter", async () => {
  // Vitest collects a skipped suite's body too, so bail out before building a
  // client without a node.
  if (!elasticUrl) {
    it.skip("needs ELASTICSEARCH_URL");
    return;
  }

  const client = createClient();
  const indexPrefix = `ba_test_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const createAdapter = () =>
    elasticsearchAdapter({
      client,
      indexPrefix,
      debugLogs: { isRunningAdapterTests: true },
    });

  const { execute } = await testAdapter({
    adapter: createAdapter,
    // The adapter creates a model's index on its first use, so touching each
    // model creates every index the schema needs.
    runMigrations: async (betterAuthOptions) => {
      const adapter = createAdapter()(betterAuthOptions);
      for (const model of Object.keys(getAuthTables(betterAuthOptions))) {
        await adapter.count({ model });
      }
    },
    tests: [smokeTestSuite()],
    onFinish: () => deleteTestIndices(client, indexPrefix),
  });

  execute();
});
