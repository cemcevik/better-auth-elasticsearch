import {
  createTestSuite,
  normalTestSuite,
  testAdapter,
} from "@better-auth/test-utils/adapter";
import { getAuthTables } from "better-auth/db";
import { username } from "better-auth/plugins";
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

/** Contract behaviour the official suites do not pin down for this adapter. */
const contractTestSuite = createTestSuite(
  "contract",
  {},
  ({ adapter, generate, modifyBetterAuthOptions }) => ({
    "create rejects an id that already exists with a duplicate key error":
      async () => {
        const user = await generate("user");
        await adapter.create({ model: "user", data: user, forceAllowId: true });

        const again = adapter.create({
          model: "user",
          data: { ...user, name: "Second writer" },
          forceAllowId: true,
        });

        await expect(again).rejects.toThrow(/duplicate key/);
        const found = await adapter.findOne({
          model: "user",
          where: [{ field: "id", value: user.id }],
        });
        expect(found?.name).toBe(user.name);
      },
    "delete with an empty where deletes nothing": async () => {
      const user = await adapter.create({
        model: "user",
        data: await generate("user"),
        forceAllowId: true,
      });

      await adapter.delete({ model: "user", where: [] });

      expect(await adapter.count({ model: "user" })).toBe(1);
      const found = await adapter.findOne({
        model: "user",
        where: [{ field: "id", value: user.id }],
      });
      expect(found?.id).toBe(user.id);
    },
    "select returns a field stored under a custom field name": {
      migrateBetterAuth: { user: { fields: { email: "email_address" } } },
      test: async () => {
        const user = await adapter.create({
          model: "user",
          data: await generate("user"),
          forceAllowId: true,
        });

        const [found] = await adapter.findMany({
          model: "user",
          where: [{ field: "id", value: user.id }],
          select: ["id", "email"],
        });
        const one = await adapter.findOne({
          model: "user",
          where: [{ field: "id", value: user.id }],
          select: ["id", "email"],
        });

        expect(found?.email).toBe(user.email);
        expect(one?.email).toBe(user.email);
      },
    },
    "null matches a field missing from rows written before it existed":
      async () => {
        const older = await adapter.create({
          model: "user",
          data: await generate("user"),
          forceAllowId: true,
        });
        await modifyBetterAuthOptions({ plugins: [username()] }, true);
        const newer = await adapter.create({
          model: "user",
          data: { ...(await generate("user")), username: "ada" },
          forceAllowId: true,
        });

        const nullIds = (
          await adapter.findMany({
            model: "user",
            where: [{ field: "username", operator: "eq", value: null }],
          })
        ).map((row) => row.id);
        const notNullIds = (
          await adapter.findMany({
            model: "user",
            where: [{ field: "username", operator: "ne", value: null }],
          })
        ).map((row) => row.id);

        expect(nullIds).toEqual([older.id]);
        expect(notNullIds).toEqual([newer.id]);
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

  /** Runs suites through `testAdapter` on a fresh prefix. */
  const runSuites = async ({ adapterOptions = {}, tests, prefixTests }) => {
    const indexPrefix = uniquePrefix();
    const createAdapter = () =>
      elasticsearchAdapter({
        client,
        indexPrefix,
        debugLogs: { isRunningAdapterTests: true },
        ...adapterOptions,
      });

    const { execute } = await testAdapter({
      adapter: createAdapter,
      // The adapter creates a model's index on its first use, so touching
      // each model creates every index the schema needs.
      runMigrations: async (betterAuthOptions) => {
        const adapter = createAdapter()(betterAuthOptions);
        for (const model of Object.keys(getAuthTables(betterAuthOptions))) {
          await adapter.count({ model });
        }
      },
      tests,
      prefixTests,
      onFinish: () => deleteTestIndices(client, indexPrefix),
    });
    execute();
  };

  await runSuites({
    tests: [smokeTestSuite(), contractTestSuite(), normalTestSuite()],
  });

  // Every write waits for the next scheduled refresh instead of forcing one,
  // and must still be found by the next read.
  await runSuites({
    adapterOptions: { refresh: "wait_for" },
    tests: [smokeTestSuite(), contractTestSuite()],
    prefixTests: "wait_for refresh",
  });
});
