import { createTestSuite, testAdapter } from "@better-auth/test-utils/adapter";
import { getAuthTables } from "better-auth/db";
import { describe, expect, it } from "vitest";

import { elasticsearchAdapter } from "../src/elasticsearch-adapter";
import {
  createClient,
  deleteTestIndices,
  elasticUrl,
  uniquePrefix,
} from "./elasticsearch.mjs";

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

describe("elasticsearchAdapter", async () => {
  // Vitest collects a skipped suite's body too, so bail out before building a
  // client without a node.
  if (!elasticUrl) {
    it.skip("needs ELASTICSEARCH_URL");
    return;
  }

  const client = createClient();
  const indexPrefix = uniquePrefix();
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
