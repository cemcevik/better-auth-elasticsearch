import { createTestSuite, testAdapter } from "@better-auth/test-utils/adapter";
import { betterAuth } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { deviceAuthorization, username } from "better-auth/plugins";
import { afterAll, describe, expect, it, vi } from "vitest";

import { elasticsearchAdapter } from "../src/elasticsearch-adapter";
import { migrate } from "../src/migrate";
import { GRACE_MS, reservationId } from "../src/unique-reservations";
import {
  createClient,
  deleteTestIndices,
  elasticUrl,
  uniquePrefix,
} from "./elasticsearch.mjs";

const duplicateEmail =
  /duplicate key: a "user" row with this email already exists/;

/** Calls `operation` `times` times at once and settles every call. */
const concurrently = (times, operation) =>
  Promise.allSettled(
    Array.from({ length: times }, (_, index) => operation(index)),
  );

/** Unique values through the adapter, as better-auth calls it. */
const uniqueTestSuite = createTestSuite(
  "unique fields",
  {},
  ({ adapter, generate }) => {
    const createUser = async (overrides = {}) =>
      adapter.create({
        model: "user",
        data: { ...(await generate("user")), ...overrides },
        forceAllowId: true,
      });
    const byId = (row) => [{ field: "id", value: row.id }];
    const findUser = (row) =>
      adapter.findOne({ model: "user", where: byId(row) });
    const emailFree = async (email) => {
      const row = await createUser({ email });
      await adapter.delete({ model: "user", where: byId(row) });
      return true;
    };

    return {
      "exactly one of many simultaneous creates of one email succeeds":
        async () => {
          const email = `${crypto.randomUUID()}@example.com`;

          const results = await concurrently(20, () => createUser({ email }));

          const created = results.filter((r) => r.status === "fulfilled");
          const failed = results.filter((r) => r.status === "rejected");
          expect(created).toHaveLength(1);
          expect(failed).toHaveLength(19);
          for (const failure of failed) {
            expect(failure.reason.message).toMatch(duplicateEmail);
            expect(failure.reason.message).not.toContain(email);
          }
          expect(
            await adapter.count({
              model: "user",
              where: [{ field: "email", value: email }],
            }),
          ).toBe(1);
        },
      "delete, deleteMany and consumeOne free the values of the rows they remove":
        async () => {
          const removals = [
            (row) => adapter.delete({ model: "user", where: byId(row) }),
            (row) => adapter.deleteMany({ model: "user", where: byId(row) }),
            (row) => adapter.consumeOne({ model: "user", where: byId(row) }),
          ];
          for (const remove of removals) {
            const row = await createUser();
            await remove(row);
            const again = await createUser({ email: row.email });
            expect(again.email).toBe(row.email);
          }
        },
      "deleteMany frees the values of every row it deletes": async () => {
        const name = `bulk-${crypto.randomUUID()}`;
        const rows = [];
        for (let index = 0; index < 5; index++) {
          rows.push(await createUser({ name }));
        }
        const kept = await createUser();

        const deleted = await adapter.deleteMany({
          model: "user",
          where: [{ field: "name", value: name }],
        });

        expect(deleted).toBe(rows.length);
        for (const row of rows) expect(await emailFree(row.email)).toBe(true);
        await expect(createUser({ email: kept.email })).rejects.toThrow(
          duplicateEmail,
        );
      },
      "update claims the new value and frees the old one": async () => {
        const row = await createUser();
        const email = `${crypto.randomUUID()}@example.com`;

        await adapter.update({
          model: "user",
          where: byId(row),
          update: { email },
        });

        expect((await findUser(row))?.email).toBe(email);
        await expect(createUser({ email })).rejects.toThrow(duplicateEmail);
        expect(await emailFree(row.email)).toBe(true);
      },
      "update to a taken value fails and leaves the row unchanged":
        async () => {
          const taken = await createUser();
          const row = await createUser();

          const update = adapter.update({
            model: "user",
            where: byId(row),
            update: { email: taken.email, name: "Renamed" },
          });

          await expect(update).rejects.toThrow(duplicateEmail);
          const found = await findUser(row);
          expect(found?.email).toBe(row.email);
          expect(found?.name).toBe(row.name);
          // Its own value stays reserved.
          await expect(createUser({ email: row.email })).rejects.toThrow(
            duplicateEmail,
          );
        },
      "updateMany claims new values, frees old ones and refuses taken ones":
        async () => {
          const row = await createUser();
          const email = `${crypto.randomUUID()}@example.com`;

          const updated = await adapter.updateMany({
            model: "user",
            where: byId(row),
            update: { email },
          });

          expect(updated).toBe(1);
          expect((await findUser(row))?.email).toBe(email);
          await expect(createUser({ email })).rejects.toThrow(duplicateEmail);
          expect(await emailFree(row.email)).toBe(true);

          // One value for two rows.
          const name = `pair-${crypto.randomUUID()}`;
          const pair = [await createUser({ name }), await createUser({ name })];
          const shared = adapter.updateMany({
            model: "user",
            where: [{ field: "name", value: name }],
            update: { email: `${crypto.randomUUID()}@example.com` },
          });
          await expect(shared).rejects.toThrow(duplicateEmail);
          for (const member of pair) {
            expect((await findUser(member))?.email).toBe(member.email);
          }
        },
      "updateMany that leaves unique fields alone still updates every row":
        async () => {
          const name = `plain-${crypto.randomUUID()}`;
          await createUser({ name });
          await createUser({ name });

          const updated = await adapter.updateMany({
            model: "user",
            where: [{ field: "name", value: name }],
            update: { emailVerified: true },
          });

          expect(updated).toBe(2);
        },
      "rows without a value of a unique field do not collide": {
        migrateBetterAuth: { plugins: [username()] },
        test: async () => {
          const rows = [
            await createUser({ username: null }),
            await createUser({ username: null }),
            await createUser({ username: `ada-${crypto.randomUUID()}` }),
          ];

          for (const row of rows) {
            expect((await findUser(row))?.id).toBe(row.id);
          }
          await expect(
            createUser({ username: rows[2].username }),
          ).rejects.toThrow(/row with this username already exists/);
        },
      },
    };
  },
);

describe("unique fields", async () => {
  // Vitest collects a skipped suite's body too, so bail out before building a
  // client without a node.
  if (!elasticUrl) {
    it.skip("needs ELASTICSEARCH_URL");
    return;
  }

  const client = createClient();

  for (const adapterOptions of [{}, { refresh: "wait_for" }]) {
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
      runMigrations: async (betterAuthOptions) => {
        const adapter = createAdapter()(betterAuthOptions);
        for (const model of Object.keys(getAuthTables(betterAuthOptions))) {
          await adapter.count({ model });
        }
      },
      tests: [uniqueTestSuite()],
      prefixTests: adapterOptions.refresh ?? "immediate",
      onFinish: () => deleteTestIndices(client, indexPrefix),
    });
    execute();
  }
});

describe("unique field reservations", () => {
  if (!elasticUrl) {
    it.skip("needs ELASTICSEARCH_URL");
    return;
  }

  const client = createClient();
  const prefixes = [];

  afterAll(async () => {
    await Promise.all(
      prefixes.map((prefix) => deleteTestIndices(client, prefix)),
    );
  });

  /** An adapter and auth instance on `indexPrefix`, or on a new prefix. */
  const app = ({ indexPrefix, options = {}, ...adapterConfig } = {}) => {
    const prefix = indexPrefix ?? uniquePrefix();
    if (!indexPrefix) prefixes.push(prefix);
    const database = elasticsearchAdapter({
      client,
      indexPrefix: prefix,
      ...adapterConfig,
    });
    return {
      indexPrefix: prefix,
      adapter: database(options),
      auth: betterAuth({
        ...options,
        database,
        secret: "a-test-secret-that-is-long-enough-to-pass",
        baseURL: "http://localhost:3000",
      }),
    };
  };

  const userData = (overrides = {}) => ({
    name: "Ada",
    email: `${crypto.randomUUID()}@example.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  const createUser = (adapter, overrides) =>
    adapter.create({ model: "user", data: userData(overrides) });
  const byId = (row) => [{ field: "id", value: row.id }];

  /** The reservation of a user's email, as stored, or null. */
  const reservationOf = async (indexPrefix, email) => {
    try {
      const doc = await client.get({
        index: `${indexPrefix}_user_unique`,
        id: reservationId(["email"], [email]),
      });
      return doc._source;
    } catch (error) {
      if (error?.meta?.statusCode === 404) return null;
      throw error;
    }
  };

  /**
   * Writes a reservation of `email` directly, as a crashed write would have
   * left it. The index must exist, so the prefix needs one user created.
   */
  const writeReservation = (indexPrefix, email, owner, claimedAt) =>
    client.index({
      index: `${indexPrefix}_user_unique`,
      id: reservationId(["email"], [email]),
      document: { field: "email", owner, claimedAt },
    });

  /**
   * A client that holds the first bulk request to a reservation index whose
   * operations match `matches`, until `release()` is called. `held` resolves
   * once one is held.
   */
  const holdingClient = (matches) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let onHeld;
    const held = new Promise((resolve) => {
      onHeld = resolve;
    });
    let armed = true;
    const holding = new Proxy(client, {
      get(target, property) {
        if (property === "bulk") {
          return async (params) => {
            if (
              armed &&
              String(params.index).endsWith("_unique") &&
              matches(params.operations)
            ) {
              armed = false;
              onHeld();
              await gate;
            }
            return target.bulk(params);
          };
        }
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { holding, held, release };
  };

  const isReleaseAfterUpdate = (operations) =>
    operations.some((operation) => "delete" in operation);
  const isReleaseAfterDelete = (operations) =>
    operations.some((operation) =>
      operation?.script?.source?.includes("ctx.op = 'delete'"),
    );

  it("takes over an orphaned reservation older than the grace period", async () => {
    const { indexPrefix, adapter } = app();
    await createUser(adapter);
    const email = `${crypto.randomUUID()}@example.com`;
    await writeReservation(
      indexPrefix,
      email,
      "crashed-row",
      Date.now() - GRACE_MS - 1000,
    );

    const row = await createUser(adapter, { email });

    expect((await reservationOf(indexPrefix, email))?.owner).toBe(row.id);
  });

  it("treats a younger reservation without its row as a write in flight", async () => {
    const { indexPrefix, adapter } = app();
    await createUser(adapter);
    const email = `${crypto.randomUUID()}@example.com`;
    await writeReservation(
      indexPrefix,
      email,
      "row-in-flight",
      Date.now() - 1000,
    );

    await expect(createUser(adapter, { email })).rejects.toThrow(
      duplicateEmail,
    );
    expect((await reservationOf(indexPrefix, email))?.owner).toBe(
      "row-in-flight",
    );
  });

  it("does not take over an old reservation whose row holds the value", async () => {
    const { indexPrefix, adapter } = app();
    const row = await createUser(adapter);
    await writeReservation(
      indexPrefix,
      row.email,
      row.id,
      Date.now() - GRACE_MS - 1000,
    );

    await expect(createUser(adapter, { email: row.email })).rejects.toThrow(
      duplicateEmail,
    );
    expect((await reservationOf(indexPrefix, row.email))?.owner).toBe(row.id);
  });

  it("re-stamps a leftover reservation its row claims again", async () => {
    const { indexPrefix, adapter } = app();
    const row = await createUser(adapter);
    const first = row.email;
    await adapter.update({
      model: "user",
      where: byId(row),
      update: { email: `${crypto.randomUUID()}@example.com` },
    });
    // The release of the first value failed and left it behind.
    const stale = Date.now() - GRACE_MS - 1000;
    await writeReservation(indexPrefix, first, row.id, stale);

    const before = Date.now();
    await adapter.update({
      model: "user",
      where: byId(row),
      update: { email: first },
    });

    const reservation = await reservationOf(indexPrefix, first);
    expect(reservation?.owner).toBe(row.id);
    expect(reservation?.claimedAt).toBeGreaterThanOrEqual(before);
  });

  it("does not release a value a later update of the row re-claimed", async () => {
    const { indexPrefix, adapter } = app();
    const row = await createUser(adapter);
    const first = row.email;
    const second = `${crypto.randomUUID()}@example.com`;
    const { holding, held, release } = holdingClient(isReleaseAfterUpdate);
    const { adapter: slow } = app({ indexPrefix, client: holding });

    // Moves to the second value, then stalls before releasing the first.
    const away = slow.update({
      model: "user",
      where: byId(row),
      update: { email: second },
    });
    await held;
    await adapter.update({
      model: "user",
      where: byId(row),
      update: { email: first },
    });
    release();
    await away;

    expect((await reservationOf(indexPrefix, first))?.owner).toBe(row.id);
    await expect(createUser(adapter, { email: first })).rejects.toThrow(
      duplicateEmail,
    );
    // The second value was released by the move back.
    expect(await reservationOf(indexPrefix, second)).toBeNull();
  });

  it("does not release a value another row took over after a delete", async () => {
    const { indexPrefix, adapter } = app();
    const row = await createUser(adapter);
    // Old enough to be taken over once the row is gone.
    await writeReservation(
      indexPrefix,
      row.email,
      row.id,
      Date.now() - GRACE_MS - 1000,
    );
    const { holding, held, release } = holdingClient(isReleaseAfterDelete);
    const { adapter: slow } = app({ indexPrefix, client: holding });

    const deletion = slow.delete({ model: "user", where: byId(row) });
    await held;
    const successor = await createUser(adapter, { email: row.email });
    release();
    await deletion;

    expect((await reservationOf(indexPrefix, row.email))?.owner).toBe(
      successor.id,
    );
    await expect(createUser(adapter, { email: row.email })).rejects.toThrow(
      duplicateEmail,
    );
  });

  it("keeps the value reserved when two updates of one row move it to the same value", async () => {
    const { indexPrefix, adapter } = app();
    for (let round = 0; round < 10; round++) {
      const row = await createUser(adapter);
      const email = `${crypto.randomUUID()}@example.com`;

      const results = await concurrently(2, () =>
        adapter.update({ model: "user", where: byId(row), update: { email } }),
      );

      expect(results.some((result) => result.status === "fulfilled")).toBe(
        true,
      );
      for (const result of results) {
        if (result.status === "rejected") {
          expect(result.reason?.meta?.statusCode).toBe(409);
        }
      }
      expect(
        (await adapter.findOne({ model: "user", where: byId(row) }))?.email,
      ).toBe(email);
      expect((await reservationOf(indexPrefix, email))?.owner).toBe(row.id);
      await expect(createUser(adapter, { email })).rejects.toThrow(
        duplicateEmail,
      );
    }
  });

  it("deletes a row written so late that its value was taken over meanwhile", async () => {
    const { indexPrefix, adapter } = app();
    await createUser(adapter);
    const email = `${crypto.randomUUID()}@example.com`;
    let competitor;
    // The first create's row write stalls past the grace period, during
    // which a second create takes its reservation for an orphan.
    const stalling = new Proxy(client, {
      get(target, property) {
        if (property === "index") {
          return async (params) => {
            if (
              params.op_type === "create" &&
              params.document?.email === email
            ) {
              vi.setSystemTime(Date.now() + GRACE_MS + 1000);
              competitor = await createUser(adapter, { email });
            }
            return target.index(params);
          };
        }
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { adapter: late } = app({ indexPrefix, client: stalling });

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      await expect(createUser(late, { email })).rejects.toThrow(duplicateEmail);
    } finally {
      vi.useRealTimers();
    }

    const holders = await adapter.findMany({
      model: "user",
      where: [{ field: "email", value: email }],
    });
    expect(holders.map((holder) => holder.id)).toEqual([competitor.id]);
    expect((await reservationOf(indexPrefix, email))?.owner).toBe(
      competitor.id,
    );
  });

  it("refuses an incrementOne that sets a unique field", async () => {
    const options = { rateLimit: { storage: "database" } };
    const { adapter } = app({ options });
    const row = await adapter.create({
      model: "rateLimit",
      data: { key: crypto.randomUUID(), count: 0, lastRequest: Date.now() },
    });

    const attempt = adapter.incrementOne({
      model: "rateLimit",
      where: [{ field: "id", value: row.id }],
      increment: { count: 1 },
      set: { key: crypto.randomUUID() },
    });

    await expect(attempt).rejects.toThrow(/unique field; use update instead/);
  });

  it("leaves the fields in skipUniqueFor unenforced", async () => {
    const { indexPrefix, adapter } = app({ skipUniqueFor: ["user.email"] });
    const email = `${crypto.randomUUID()}@example.com`;

    await createUser(adapter, { email });
    await createUser(adapter, { email });

    expect(
      await adapter.count({
        model: "user",
        where: [{ field: "email", value: email }],
      }),
    ).toBe(2);
    expect(
      await client.indices.exists({ index: `${indexPrefix}_user_unique` }),
    ).toBe(false);
  });

  /** A client that records the name of every request method called. */
  const recordingClient = () => {
    const calls = [];
    const record = (target, path) =>
      new Proxy(target, {
        get(inner, property) {
          const value = inner[property];
          if (property === "indices") return record(value, "indices.");
          if (typeof value !== "function") return value;
          return (...args) => {
            calls.push(`${path}${String(property)}`);
            return value.apply(inner, args);
          };
        },
      });
    return { recording: record(client, ""), calls };
  };

  it("sends the same requests as before for a model with no enforced unique field", async () => {
    const { recording, calls } = recordingClient();
    const options = { rateLimit: { storage: "database" } };
    const { adapter } = app({
      client: recording,
      options,
      skipUniqueFor: ["session.token"],
    });
    const verification = () =>
      adapter.create({
        model: "verification",
        data: {
          identifier: crypto.randomUUID(),
          value: "v",
          expiresAt: new Date(Date.now() + 60_000),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    const session = () =>
      adapter.create({
        model: "session",
        data: {
          userId: "u",
          token: crypto.randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    for (const model of ["verification", "session", "user", "rateLimit"]) {
      await adapter.count({ model });
    }
    const requests = async (operation) => {
      calls.length = 0;
      await operation();
      return [...calls];
    };

    expect(await requests(verification)).toEqual(["index"]);
    const row = await verification();
    expect(
      await requests(() =>
        adapter.update({
          model: "verification",
          where: byId(row),
          update: { value: "w" },
        }),
      ),
    ).toEqual(["search", "index"]);
    expect(
      await requests(() =>
        adapter.updateMany({
          model: "verification",
          where: byId(row),
          update: { value: "x" },
        }),
      ),
    ).toEqual(["search", "bulk"]);
    expect(
      await requests(() =>
        adapter.consumeOne({ model: "verification", where: byId(row) }),
      ),
    ).toEqual(["search", "delete"]);
    const other = await verification();
    expect(
      await requests(() =>
        adapter.delete({ model: "verification", where: byId(other) }),
      ),
    ).toEqual(["search", "delete"]);
    // Unenforced through skipUniqueFor, sessions are deleted by query as
    // before.
    await session();
    expect(await requests(session)).toEqual(["index"]);
    expect(
      await requests(() =>
        adapter.deleteMany({
          model: "session",
          where: [{ field: "userId", value: "u" }],
        }),
      ),
    ).toEqual(["deleteByQuery"]);
    // An enforced model's writes that leave its unique fields alone.
    const user = await createUser(adapter);
    expect(
      await requests(() =>
        adapter.update({
          model: "user",
          where: byId(user),
          update: { name: "Renamed" },
        }),
      ),
    ).toEqual(["search", "index"]);
    expect(
      await requests(() =>
        adapter.incrementOne({
          model: "rateLimit",
          where: [{ field: "key", value: "none" }],
          increment: { count: 1 },
        }),
      ),
    ).toEqual(["search"]);
  });

  it("migrate() reserves the values of existing rows and reports duplicates", async () => {
    // Written while the field was not enforced.
    const { indexPrefix, adapter: before } = app({
      skipUniqueFor: ["user.email"],
    });
    const shared = `${crypto.randomUUID()}@example.com`;
    const first = await createUser(before, { email: shared });
    const second = await createUser(before, { email: shared });
    const single = await createUser(before);
    const { adapter, auth } = app({ indexPrefix });

    const result = await migrate(auth);

    expect(result.migrated).toEqual([]);
    expect(result.duplicates).toEqual([
      { model: "user", field: "email", ids: [first.id, second.id].sort() },
    ]);
    expect((await reservationOf(indexPrefix, single.email))?.owner).toBe(
      single.id,
    );
    await expect(createUser(adapter, { email: single.email })).rejects.toThrow(
      duplicateEmail,
    );
    await expect(createUser(adapter, { email: shared })).rejects.toThrow(
      duplicateEmail,
    );

    // Again: nothing new to reserve, the same duplicate to report.
    const again = await migrate(auth);
    expect(again.duplicates).toEqual(result.duplicates);
    await client.indices.refresh({ index: `${indexPrefix}_user_unique` });
    const reserved = await client.count({
      index: `${indexPrefix}_user_unique`,
    });
    expect(reserved.count).toBe(2);
  });

  it("migrate() takes over orphans past the grace period while backfilling", async () => {
    const { indexPrefix, adapter: before } = app({
      skipUniqueFor: ["user.email"],
    });
    const row = await createUser(before);
    const { adapter, auth } = app({ indexPrefix });
    await createUser(adapter);
    await writeReservation(
      indexPrefix,
      row.email,
      "crashed-row",
      Date.now() - GRACE_MS - 1000,
    );

    const result = await migrate(auth);

    expect(result.duplicates).toEqual([]);
    expect((await reservationOf(indexPrefix, row.email))?.owner).toBe(row.id);
  });

  it("re-stamps the claims of a create that waited out a migration", async () => {
    const scoreAs = (type) => ({
      user: { additionalFields: { score: { type, required: false } } },
    });
    const { indexPrefix, adapter: running } = app({
      options: scoreAs("string"),
    });
    await createUser(running, { score: "1" });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let onHeld;
    const held = new Promise((resolve) => {
      onHeld = resolve;
    });
    const paused = new Proxy(client, {
      get(target, property) {
        if (property === "reindex") {
          return async (params) => {
            onHeld();
            await gate;
            return target.reindex(params);
          };
        }
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { auth } = app({
      indexPrefix,
      options: scoreAs("number"),
      client: paused,
    });

    const migration = migrate(auth);
    await held;
    const email = `${crypto.randomUUID()}@example.com`;
    const create = createUser(running, { email, score: "2" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const releasedAt = Date.now();
    release();
    await migration;
    const created = await create;

    const reservation = await reservationOf(indexPrefix, email);
    expect(reservation?.owner).toBe(created.id);
    expect(reservation?.claimedAt).toBeGreaterThanOrEqual(releasedAt);
    const { adapter } = app({ indexPrefix, options: scoreAs("number") });
    await expect(createUser(adapter, { email })).rejects.toThrow(
      duplicateEmail,
    );
  });
  /**
   * A plugin with a "pair" table unique over two fields, `b` stored under a
   * custom name, and a "badge" table whose `code` is declared unique both on
   * the field and as an index.
   */
  const constraintsPlugin = {
    id: "unique-constraints-test",
    schema: {
      pair: {
        fields: {
          a: { type: "string", required: true },
          b: { type: "string", required: true, fieldName: "pair_b" },
          label: { type: "string", required: false },
        },
        indexes: [{ fields: ["a", "b"], unique: true }],
      },
      badge: {
        fields: { code: { type: "string", required: true, unique: true } },
        indexes: [
          { name: "badge_code_unique", fields: ["code"], unique: true },
        ],
      },
    },
  };
  const pluginOptions = { plugins: [constraintsPlugin] };
  const duplicatePair =
    /duplicate key: a "pair" row with this a\+b already exists/;
  const createPair = (adapter, data) =>
    adapter.create({ model: "pair", data: { label: "x", ...data } });

  /** How many reservations an index holds, after making them searchable. */
  const reservationCount = async (index) => {
    await client.indices.refresh({ index });
    return (await client.count({ index })).count;
  };

  it("enforces a single-field unique index like a unique field", async () => {
    const { indexPrefix, adapter } = app({
      options: { plugins: [deviceAuthorization()] },
    });
    const device = (overrides = {}) =>
      adapter.create({
        model: "deviceCode",
        data: {
          deviceCode: crypto.randomUUID(),
          userCode: crypto.randomUUID().slice(0, 8),
          expiresAt: new Date(Date.now() + 60_000),
          status: "pending",
          ...overrides,
        },
      });
    const row = await device();

    await expect(device({ deviceCode: row.deviceCode })).rejects.toThrow(
      /duplicate key: a "deviceCode" row with this deviceCode already exists/,
    );
    await expect(device({ userCode: row.userCode })).rejects.toThrow(
      /row with this userCode already exists/,
    );
    const results = await concurrently(10, () =>
      device({ userCode: "SAMECODE" }),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    // Hashed as a field declared unique would be.
    const reservation = await client.get({
      index: `${indexPrefix}_devicecode_unique`,
      id: reservationId(["deviceCode"], [row.deviceCode]),
    });
    expect(reservation._source.owner).toBe(row.id);
  });

  it("holds one reservation for a field declared unique both ways", async () => {
    const { indexPrefix, adapter } = app({ options: pluginOptions });
    const code = crypto.randomUUID();

    await adapter.create({ model: "badge", data: { code } });

    await expect(
      adapter.create({ model: "badge", data: { code } }),
    ).rejects.toThrow(/row with this code already exists/);
    expect(await reservationCount(`${indexPrefix}_badge_unique`)).toBe(1);
  });

  it("enforces a unique index over several fields on their combination", async () => {
    const { indexPrefix, adapter } = app({ options: pluginOptions });
    const a = crypto.randomUUID();
    const first = await createPair(adapter, { a, b: "1" });
    // Sharing one field is fine.
    const second = await createPair(adapter, { a, b: "2" });
    await createPair(adapter, { a: crypto.randomUUID(), b: "1" });

    await expect(createPair(adapter, { a, b: "1" })).rejects.toThrow(
      duplicatePair,
    );
    const results = await concurrently(10, () =>
      createPair(adapter, { a, b: "3" }),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason.message).toMatch(duplicatePair);
        expect(result.reason.message).not.toContain(a);
      }
    }
    // Stored under the database name of `b`.
    const reservation = await client.get({
      index: `${indexPrefix}_pair_unique`,
      id: reservationId(["a", "pair_b"], [a, "1"]),
    });
    expect(reservation._source).toMatchObject({
      field: "a+pair_b",
      owner: first.id,
    });

    // An update changing one of the two fields claims the new combination
    // and frees the old one.
    await expect(
      adapter.update({
        model: "pair",
        where: [{ field: "id", value: second.id }],
        update: { b: "1" },
      }),
    ).rejects.toThrow(duplicatePair);
    await adapter.update({
      model: "pair",
      where: [{ field: "id", value: second.id }],
      update: { b: "4" },
    });
    await expect(createPair(adapter, { a, b: "4" })).rejects.toThrow(
      duplicatePair,
    );
    await createPair(adapter, { a, b: "2" });

    // updateMany reads the field it leaves alone to build the combination.
    await expect(
      adapter.updateMany({
        model: "pair",
        where: [{ field: "id", value: second.id }],
        update: { b: "1" },
      }),
    ).rejects.toThrow(duplicatePair);
    expect(
      await adapter.updateMany({
        model: "pair",
        where: [{ field: "id", value: second.id }],
        update: { b: "5" },
      }),
    ).toBe(1);
    await createPair(adapter, { a, b: "4" });

    // Deleting frees the combination.
    await adapter.delete({
      model: "pair",
      where: [{ field: "id", value: first.id }],
    });
    await createPair(adapter, { a, b: "1" });
    await adapter.deleteMany({
      model: "pair",
      where: [{ field: "a", value: a }],
    });
    await createPair(adapter, { a, b: "5" });
  });

  it("reserves nothing for a combination with a null in it", async () => {
    const { indexPrefix, adapter } = app({ options: pluginOptions });
    const a = crypto.randomUUID();
    await createPair(adapter, { a: "seed", b: "seed" });
    const before = await reservationCount(`${indexPrefix}_pair_unique`);

    const first = await createPair(adapter, { a, b: null });
    await createPair(adapter, { a, b: null });

    expect(await reservationCount(`${indexPrefix}_pair_unique`)).toBe(before);
    // Filling in the null claims the combination.
    await adapter.update({
      model: "pair",
      where: [{ field: "id", value: first.id }],
      update: { b: "1" },
    });
    await expect(createPair(adapter, { a, b: "1" })).rejects.toThrow(
      duplicatePair,
    );
  });

  it("refuses an incrementOne that sets a field of a unique index", async () => {
    const { adapter } = app({ options: pluginOptions });
    const row = await createPair(adapter, { a: crypto.randomUUID(), b: "1" });

    const attempt = adapter.incrementOne({
      model: "pair",
      where: [{ field: "id", value: row.id }],
      increment: {},
      set: { b: "2" },
    });

    await expect(attempt).rejects.toThrow(
      /cannot set "b" on "pair", as it is a unique field/,
    );
  });

  it("skips unique indexes named in skipUniqueFor, in either form", async () => {
    const { indexPrefix, adapter } = app({
      options: { plugins: [constraintsPlugin, deviceAuthorization()] },
      skipUniqueFor: ["pair.a+b", "badge.code", "deviceCode.userCode"],
    });
    const a = crypto.randomUUID();
    const code = crypto.randomUUID();

    await createPair(adapter, { a, b: "1" });
    await createPair(adapter, { a, b: "1" });
    await adapter.create({ model: "badge", data: { code } });
    await adapter.create({ model: "badge", data: { code } });
    const device = (deviceCode) =>
      adapter.create({
        model: "deviceCode",
        data: {
          deviceCode,
          userCode: "SAMECODE",
          expiresAt: new Date(Date.now() + 60_000),
          status: "pending",
        },
      });
    const kept = crypto.randomUUID();
    await device(kept);
    await device(crypto.randomUUID());

    // deviceCode is still enforced.
    await expect(device(kept)).rejects.toThrow(/row with this deviceCode/);
    for (const model of ["pair", "badge"]) {
      expect(
        await client.indices.exists({
          index: `${indexPrefix}_${model}_unique`,
        }),
      ).toBe(false);
    }
  });

  it("migrate() backfills unique indexes over several fields and reports their duplicates", async () => {
    const { indexPrefix, adapter: before } = app({
      options: pluginOptions,
      skipUniqueFor: ["pair.a+b"],
    });
    const a = crypto.randomUUID();
    const first = await createPair(before, { a, b: "1" });
    const second = await createPair(before, { a, b: "1" });
    const single = await createPair(before, { a, b: "2" });
    await createPair(before, { a, b: null });
    const { adapter, auth } = app({ indexPrefix, options: pluginOptions });

    const result = await migrate(auth);

    expect(result.duplicates).toEqual([
      { model: "pair", field: "a+b", ids: [first.id, second.id].sort() },
    ]);
    expect(await reservationCount(`${indexPrefix}_pair_unique`)).toBe(2);
    await expect(createPair(adapter, { a, b: single.b })).rejects.toThrow(
      duplicatePair,
    );
    expect((await migrate(auth)).duplicates).toEqual(result.duplicates);
  });
});
