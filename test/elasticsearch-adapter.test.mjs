import {
  authFlowTestSuite,
  caseInsensitiveTestSuite,
  createTestSuite,
  joinsTestSuite,
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

        const secondCreate = adapter.create({
          model: "user",
          data: { ...user, name: "Second writer" },
          forceAllowId: true,
        });

        await expect(secondCreate).rejects.toThrow(/duplicate key/);
        const found = await adapter.findOne({
          model: "user",
          where: [{ field: "id", value: user.id }],
        });
        expect(found?.name).toBe(user.name);
      },
    "updateMany and deleteMany return the number of rows they touched":
      async () => {
        const rows = [];
        for (const name of ["keep", "match", "match"]) {
          rows.push(
            await adapter.create({
              model: "user",
              data: { ...(await generate("user")), name },
              forceAllowId: true,
            }),
          );
        }
        const matching = [{ field: "name", value: "match" }];

        const updated = await adapter.updateMany({
          model: "user",
          where: matching,
          update: { emailVerified: true },
        });
        const deleted = await adapter.deleteMany({
          model: "user",
          where: matching,
        });
        const deletedAgain = await adapter.deleteMany({
          model: "user",
          where: matching,
        });

        expect(updated).toBe(2);
        expect(deleted).toBe(2);
        expect(deletedAgain).toBe(0);
        expect(await adapter.count({ model: "user" })).toBe(1);
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
    // Microsoft ID tokens are often longer than a keyword can index.
    "a string too long to index is returned intact and its row stays findable":
      async () => {
        const user = await adapter.create({
          model: "user",
          data: await generate("user"),
          forceAllowId: true,
        });
        // A JWT-like value past the keyword limit of 8191 characters and past
        // Lucene's term limit of 32766 bytes too, where an unbounded keyword
        // would make Elasticsearch reject the whole row. The two-byte "é"
        // checks the value comes back byte for byte.
        const idToken = `eyJ${"x".repeat(32766)}é`;
        const account = await adapter.create({
          model: "account",
          data: { ...(await generate("account")), userId: user.id, idToken },
          forceAllowId: true,
        });

        const found = await adapter.findOne({
          model: "account",
          where: [
            { field: "userId", value: user.id },
            { field: "providerId", value: account.providerId },
          ],
        });

        expect(found?.id).toBe(account.id);
        expect(found?.idToken).toBe(idToken);
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

const rateLimitOptions = { rateLimit: { storage: "database" } };

/** Calls `operation` `times` times at once and waits for every call. */
const concurrently = (times, operation) =>
  Promise.all(Array.from({ length: times }, (_, index) => operation(index)));

/**
 * Keeps updating random rows from `rows` until `whileRunning` settles, so the
 * by-query write in `whileRunning` meets rows that change under it.
 * Returns what `whileRunning` resolved to.
 */
const withConcurrentSessionUpdates = async (adapter, rows, whileRunning) => {
  let running = true;
  const updater = async () => {
    while (running) {
      const row = rows[Math.floor(Math.random() * rows.length)];
      // A row changed or deleted between the update's search and its write
      // makes the update fail with a version conflict; that is the race
      // under test. Any other error fails the test.
      await adapter
        .update({
          model: "session",
          where: [{ field: "id", value: row.id }],
          update: { ipAddress: `10.0.0.${Math.floor(Math.random() * 255)}` },
        })
        .catch((error) => {
          if (error?.meta?.statusCode !== 409) throw error;
        });
    }
  };
  const updaters = Array.from({ length: 8 }, updater);
  try {
    // Let the updaters get going before the by-query write starts.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return await whileRunning();
  } finally {
    running = false;
    await Promise.all(updaters);
  }
};

/**
 * Lets a test make Elasticsearch reject writes as it does when its write
 * queue is full. While `rejectedWrites.next` is above zero, the first row of
 * a bulk request is not sent and is reported back with status 429.
 */
const rejectedWrites = { next: 0 };

const withRejectedWrites = (client) =>
  new Proxy(client, {
    get(target, property) {
      if (property === "bulk") {
        return async (params) => {
          if (rejectedWrites.next === 0) return target.bulk(params);
          rejectedWrites.next--;
          const [action, , ...rest] = params.operations;
          const sent =
            rest.length > 0
              ? await target.bulk({ ...params, operations: rest })
              : { errors: false, items: [] };
          const rejected = {
            update: {
              _id: action.update._id,
              status: 429,
              error: {
                type: "es_rejected_execution_exception",
                reason: "rejected execution of coordinating operation",
              },
            },
          };
          return { ...sent, errors: true, items: [rejected, ...sent.items] };
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

/** Single-use reads, counters and by-query writes under concurrent requests. */
const concurrencyTestSuite = createTestSuite(
  "concurrency",
  {},
  ({ adapter, generate }) => {
    const createSessions = async (userId, count) => {
      const rows = [];
      for (let index = 0; index < count; index++) {
        rows.push(
          await adapter.create({
            model: "session",
            data: { ...(await generate("session")), userId },
            forceAllowId: true,
          }),
        );
      }
      return rows;
    };

    const createRateLimit = (count = 0) =>
      adapter.create({
        model: "rateLimit",
        data: {
          key: `key-${crypto.randomUUID()}`,
          count,
          lastRequest: Date.now(),
        },
      });

    return {
      "consumeOne hands one row to exactly one of many simultaneous callers":
        async () => {
          const row = await adapter.create({
            model: "verification",
            data: await generate("verification"),
            forceAllowId: true,
          });

          const results = await concurrently(20, () =>
            adapter.consumeOne({
              model: "verification",
              where: [{ field: "identifier", value: row.identifier }],
            }),
          );

          const winners = results.filter((result) => result !== null);
          expect(winners).toEqual([row]);
          expect(
            await adapter.findOne({
              model: "verification",
              where: [{ field: "id", value: row.id }],
            }),
          ).toBeNull();
        },
      "consumeOne deletes only one of several matching rows": async () => {
        const identifier = `shared-${crypto.randomUUID()}`;
        for (let index = 0; index < 3; index++) {
          await adapter.create({
            model: "verification",
            data: { ...(await generate("verification")), identifier },
            forceAllowId: true,
          });
        }
        const where = [{ field: "identifier", value: identifier }];

        const consumed = await adapter.consumeOne({
          model: "verification",
          where,
        });

        expect(consumed?.identifier).toBe(identifier);
        expect(await adapter.count({ model: "verification", where })).toBe(2);
      },
      "consumeOne returns null when no row matches": async () => {
        const consumed = await adapter.consumeOne({
          model: "verification",
          where: [{ field: "identifier", value: "no-such-identifier" }],
        });

        expect(consumed).toBeNull();
      },
      "incrementOne loses no increments under simultaneous callers": {
        migrateBetterAuth: rateLimitOptions,
        test: async () => {
          const row = await createRateLimit();

          const results = await concurrently(20, () =>
            adapter.incrementOne({
              model: "rateLimit",
              where: [{ field: "key", value: row.key }],
              increment: { count: 1 },
            }),
          );

          expect(results.every((result) => result !== null)).toBe(true);
          const after = await adapter.findOne({
            model: "rateLimit",
            where: [{ field: "id", value: row.id }],
          });
          expect(after?.count).toBe(20);
        },
      },
      "incrementOne applies deltas and set values and returns the updated row":
        {
          migrateBetterAuth: rateLimitOptions,
          test: async () => {
            const row = await createRateLimit(5);

            const updated = await adapter.incrementOne({
              model: "rateLimit",
              where: [{ field: "key", value: row.key }],
              increment: { count: -2 },
              set: { lastRequest: 1234 },
            });

            expect(updated).toEqual({ ...row, count: 3, lastRequest: 1234 });
            expect(
              await adapter.findOne({
                model: "rateLimit",
                where: [{ field: "id", value: row.id }],
              }),
            ).toEqual(updated);
          },
        },
      "incrementOne whose guard no longer matches returns null and changes nothing":
        {
          migrateBetterAuth: rateLimitOptions,
          test: async () => {
            const row = await createRateLimit(1);
            const stillPositive = [
              { field: "key", value: row.key },
              { field: "count", operator: "gt", value: 0 },
            ];

            const first = await adapter.incrementOne({
              model: "rateLimit",
              where: stillPositive,
              increment: { count: -1 },
            });
            const second = await adapter.incrementOne({
              model: "rateLimit",
              where: stillPositive,
              increment: { count: -1 },
              set: { lastRequest: 1 },
            });

            expect(first?.count).toBe(0);
            expect(second).toBeNull();
            expect(
              await adapter.findOne({
                model: "rateLimit",
                where: [{ field: "id", value: row.id }],
              }),
            ).toEqual(first);
          },
        },
      "incrementOne guarded counters never go below zero under simultaneous callers":
        {
          migrateBetterAuth: rateLimitOptions,
          test: async () => {
            const row = await createRateLimit(5);

            const results = await concurrently(20, () =>
              adapter.incrementOne({
                model: "rateLimit",
                where: [
                  { field: "key", value: row.key },
                  { field: "count", operator: "gt", value: 0 },
                ],
                increment: { count: -1 },
              }),
            );

            expect(results.filter((result) => result !== null)).toHaveLength(5);
            const after = await adapter.findOne({
              model: "rateLimit",
              where: [{ field: "id", value: row.id }],
            });
            expect(after?.count).toBe(0);
          },
        },
      "updateMany writes a row again after Elasticsearch rejected its write":
        async () => {
          const userId = crypto.randomUUID();
          const rows = await createSessions(userId, 3);
          const where = [{ field: "userId", value: userId }];

          rejectedWrites.next = 1;
          const updated = await adapter.updateMany({
            model: "session",
            where,
            update: { userAgent: "revoked" },
          });

          expect(rejectedWrites.next).toBe(0);
          expect(updated).toBe(rows.length);
          expect(
            await adapter.count({
              model: "session",
              where: [...where, { field: "userAgent", value: "revoked" }],
            }),
          ).toBe(rows.length);
        },
      // Revoking all of a user's sessions while one is being refreshed.
      "deleteMany leaves no matching row when the rows change under it":
        async () => {
          const userId = crypto.randomUUID();
          const rows = await createSessions(userId, 200);
          const where = [{ field: "userId", value: userId }];

          const deleted = await withConcurrentSessionUpdates(
            adapter,
            rows,
            () => adapter.deleteMany({ model: "session", where }),
          );

          expect(await adapter.count({ model: "session", where })).toBe(0);
          expect(deleted).toBe(rows.length);
        },
      "updateMany updates every matching row when the rows change under it":
        async () => {
          const userId = crypto.randomUUID();
          const rows = await createSessions(userId, 200);
          const where = [{ field: "userId", value: userId }];

          const updated = await withConcurrentSessionUpdates(
            adapter,
            rows,
            () =>
              adapter.updateMany({
                model: "session",
                where,
                update: { userAgent: "revoked" },
              }),
          );

          const missed = await adapter.count({
            model: "session",
            where: [
              ...where,
              { field: "userAgent", operator: "ne", value: "revoked" },
            ],
          });
          expect(missed).toBe(0);
          expect(updated).toBe(rows.length);
        },
    };
  },
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
        client: withRejectedWrites(client),
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
    tests: [
      smokeTestSuite(),
      contractTestSuite(),
      concurrencyTestSuite(),
      normalTestSuite(),
      authFlowTestSuite(),
      caseInsensitiveTestSuite(),
      // The adapter has no native joins; the factory's fallback queries
      // serve them.
      joinsTestSuite(),
      // Not run, as the adapter does not support them: numberIdTestSuite
      // (ids are strings) and transactionsTestSuite (no transactions).
    ],
  });

  // Every write waits for the next scheduled refresh instead of forcing one,
  // and must still be found by the next read.
  await runSuites({
    adapterOptions: { refresh: "wait_for" },
    tests: [
      smokeTestSuite(),
      contractTestSuite(),
      // Contenders must not keep losing to a write they cannot search yet.
      // The by-query tests are left out: creating their 200 rows one
      // refresh at a time would take minutes.
      concurrencyTestSuite({
        disableTests: {
          "deleteMany leaves no matching row when the rows change under it": true,
          "updateMany updates every matching row when the rows change under it": true,
        },
      }),
    ],
    prefixTests: "wait_for refresh",
  });
});
