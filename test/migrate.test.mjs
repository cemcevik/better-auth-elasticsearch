import { betterAuth } from "better-auth";
import { afterAll, describe, expect, it } from "vitest";

import { elasticsearchAdapter } from "../src/elasticsearch-adapter";
import { migrate } from "../src/migrate";
import {
  createClient,
  deleteTestIndices,
  elasticUrl,
  uniquePrefix,
} from "./elasticsearch.mjs";

const userData = (overrides = {}) => ({
  name: "Ada",
  email: `${crypto.randomUUID()}@example.com`,
  emailVerified: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const scoreAs = (type) => ({
  user: { additionalFields: { score: { type, required: false } } },
});

describe("migrate()", () => {
  // Vitest collects a skipped suite's body too, so bail out before building a
  // client without a node.
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

  /**
   * An app's adapter and auth instance on one prefix, built from the given
   * better-auth options and adapter config.
   */
  const app = (indexPrefix, options = {}, adapterConfig = {}) => {
    const database = elasticsearchAdapter({
      client,
      indexPrefix,
      ...adapterConfig,
    });
    return {
      adapter: database(options),
      auth: betterAuth({
        ...options,
        database,
        secret: "a-test-secret-that-is-long-enough-to-pass",
        baseURL: "http://localhost:3000",
      }),
    };
  };

  /** A prefix with users whose `score` is mapped as a string. */
  const populatedPrefix = async (rows = 25) => {
    const indexPrefix = uniquePrefix();
    prefixes.push(indexPrefix);
    const { adapter } = app(indexPrefix, scoreAs("string"));
    const users = [];
    for (let index = 0; index < rows; index++) {
      users.push(
        await adapter.create({
          model: "user",
          data: userData({ score: String(index) }),
        }),
      );
    }
    return { indexPrefix, adapter, users };
  };

  const backingIndices = async (alias) =>
    Object.keys(await client.indices.getAlias({ name: alias }));

  it("moves every row of a changed model behind the same alias with the new mapping", async () => {
    const { indexPrefix, users } = await populatedPrefix();
    const { adapter, auth } = app(indexPrefix, scoreAs("number"));
    const alias = `${indexPrefix}_user`;

    const result = await migrate(auth);

    expect(result.migrated).toEqual([
      {
        model: "user",
        alias,
        from: `${alias}_v1`,
        to: `${alias}_v2`,
        fromDeleted: false,
      },
    ]);
    expect(await backingIndices(alias)).toEqual([`${alias}_v2`]);
    expect(await adapter.count({ model: "user" })).toBe(users.length);
    for (const user of users) {
      const found = await adapter.findOne({
        model: "user",
        where: [{ field: "id", value: user.id }],
      });
      expect(found?.email).toBe(user.email);
    }
    // Numeric now: a range only a number mapping answers this way.
    const high = await adapter.count({
      model: "user",
      where: [{ field: "score", operator: "gte", value: 20 }],
    });
    expect(high).toBe(5);
    // The old index is kept as a rollback.
    expect(await client.indices.exists({ index: `${alias}_v1` })).toBe(true);
  });

  it("leaves matching models alone and changes nothing when run again", async () => {
    const { indexPrefix, adapter: before, users } = await populatedPrefix(3);
    const session = await before.create({
      model: "session",
      data: {
        userId: users[0].id,
        token: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const { adapter, auth } = app(indexPrefix, scoreAs("number"));

    const first = await migrate(auth);
    const second = await migrate(auth);

    expect(first.migrated.map((model) => model.model)).toEqual(["user"]);
    expect(second.migrated).toEqual([]);
    expect(await backingIndices(`${indexPrefix}_user`)).toEqual([
      `${indexPrefix}_user_v2`,
    ]);
    expect(await backingIndices(`${indexPrefix}_session`)).toEqual([
      `${indexPrefix}_session_v1`,
    ]);
    expect(await adapter.count({ model: "user" })).toBe(3);
    const found = await adapter.findOne({
      model: "session",
      where: [{ field: "id", value: session.id }],
    });
    expect(found?.token).toBe(session.token);
  });

  it("deletes the old index only when asked to", async () => {
    const { indexPrefix } = await populatedPrefix(3);
    const { adapter, auth } = app(indexPrefix, scoreAs("number"));
    const alias = `${indexPrefix}_user`;

    const result = await migrate(auth, {
      deleteOldIndices: true,
      oldIndexGraceMs: 0,
    });

    expect(result.migrated).toEqual([
      expect.objectContaining({ from: `${alias}_v1`, fromDeleted: true }),
    ]);
    expect(await client.indices.exists({ index: `${alias}_v1` })).toBe(false);
    expect(await adapter.count({ model: "user" })).toBe(3);
  });

  /**
   * A client that holds a migration after it write-blocks the old index and
   * before it copies the rows, until `release()` is called. `held` resolves
   * once a migration is held.
   */
  const pausingClient = () => {
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
    return { paused, held, release };
  };

  it("lets writes issued during a migration wait and then succeed", async () => {
    const { indexPrefix, adapter: running, users } = await populatedPrefix(6);
    const [updated, deleted, verified, consumed, deletedByQuery] = users;
    const { paused, held, release } = pausingClient();
    const { auth } = app(indexPrefix, scoreAs("number"), { client: paused });
    const byId = (user) => [{ field: "id", value: user.id }];

    const migration = migrate(auth);
    await held;

    // The running app still has the old schema; its writes meet the block.
    let settled = 0;
    const track = (promise) => promise.finally(() => settled++);
    const writes = Promise.all(
      [
        running.create({ model: "user", data: userData({ score: "42" }) }),
        running.update({
          model: "user",
          where: byId(updated),
          update: { name: "Renamed during migration" },
        }),
        running.delete({ model: "user", where: byId(deleted) }),
        running.updateMany({
          model: "user",
          where: byId(verified),
          update: { emailVerified: true },
        }),
        running.consumeOne({ model: "user", where: byId(consumed) }),
        running.deleteMany({ model: "user", where: byId(deletedByQuery) }),
      ].map(track),
    );
    // Reads carry on during the migration.
    expect(await running.count({ model: "user" })).toBe(users.length);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(0);

    release();
    await migration;
    const [created, , , updatedCount, consumedRow, deletedCount] = await writes;

    const { adapter } = app(indexPrefix, scoreAs("number"));
    const find = (user) =>
      adapter.findOne({ model: "user", where: byId(user) });
    expect(await backingIndices(`${indexPrefix}_user`)).toEqual([
      `${indexPrefix}_user_v2`,
    ]);
    expect((await find(created))?.email).toBe(created.email);
    expect((await find(updated))?.name).toBe("Renamed during migration");
    expect(updatedCount).toBe(1);
    expect((await find(verified))?.emailVerified).toBe(true);
    expect(consumedRow?.id).toBe(consumed.id);
    expect(deletedCount).toBe(1);
    // Deleted rows stay deleted: the old index's copies were not carried over.
    expect(await find(deleted)).toBeNull();
    expect(await find(consumed)).toBeNull();
    expect(await find(deletedByQuery)).toBeNull();
    expect(await adapter.count({ model: "user" })).toBe(users.length + 1 - 3);
  });

  /**
   * Has the running app read a row before the alias swap and write it after:
   * its next search returns 300 ms after the alias points at the new index.
   * Returns the update's result, the row as found afterwards, and the
   * migration's result.
   */
  const updateAcrossSwap = async (migrateOptions) => {
    const { indexPrefix, users } = await populatedPrefix(3);
    const [target] = users;
    const alias = `${indexPrefix}_user`;
    let onRead;
    const read = new Promise((resolve) => {
      onRead = resolve;
    });
    let armed = false;
    const lagging = new Proxy(client, {
      get(target, property) {
        if (property === "search" && armed) {
          return async (params) => {
            armed = false;
            const result = await target.search(params);
            onRead();
            while (!(await backingIndices(alias)).includes(`${alias}_v2`)) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            // Long enough for a deletion right after the swap to happen first.
            await new Promise((resolve) => setTimeout(resolve, 300));
            return result;
          };
        }
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { adapter: running } = app(indexPrefix, scoreAs("string"), {
      client: lagging,
    });
    // Move the row's sequence number past anything its copy gets, so an
    // update conditional on the old index's numbers cannot match by chance.
    for (let index = 0; index < 5; index++) {
      await running.update({
        model: "user",
        where: [{ field: "id", value: target.id }],
        update: { image: `v${index}` },
      });
    }
    const { auth } = app(indexPrefix, scoreAs("number"));

    armed = true;
    const update = running.update({
      model: "user",
      where: [{ field: "id", value: target.id }],
      update: { name: "Renamed across the swap" },
    });
    await read;
    const [updated, result] = await Promise.all([
      update,
      migrate(auth, migrateOptions),
    ]);

    const { adapter } = app(indexPrefix, scoreAs("number"));
    const found = await adapter.findOne({
      model: "user",
      where: [{ field: "id", value: target.id }],
    });
    return { alias, target, updated, found, result };
  };

  it("applies an update that read the old index before the swap to the new one", async () => {
    const { target, updated, found } = await updateAcrossSwap();

    expect(updated?.name).toBe("Renamed across the swap");
    expect(found?.name).toBe("Renamed across the swap");
    expect(found?.email).toBe(target.email);
  });

  it("deletes the old index only after an update in flight across the swap is done", async () => {
    const { alias, updated, found, result } = await updateAcrossSwap({
      deleteOldIndices: true,
      oldIndexGraceMs: 1_000,
    });

    expect(updated?.name).toBe("Renamed across the swap");
    expect(found?.name).toBe("Renamed across the swap");
    expect(result.migrated[0]?.fromDeleted).toBe(true);
    // Not recreated empty by the late write, nor left behind.
    expect(await client.indices.exists({ index: `${alias}_v1` })).toBe(false);
  });

  it("fails a write that waits longer than writeBlockTimeoutMs", async () => {
    const { indexPrefix } = await populatedPrefix(1);
    const { adapter: running } = app(indexPrefix, scoreAs("string"), {
      writeBlockTimeoutMs: 300,
    });
    await running.count({ model: "user" });
    const { paused, held, release } = pausingClient();
    const { auth } = app(indexPrefix, scoreAs("number"), { client: paused });

    const migration = migrate(auth);
    await held;
    const started = Date.now();
    const attempt = running.create({ model: "user", data: userData() });

    await expect(attempt).rejects.toThrow(
      new RegExp(
        `"${indexPrefix}_user" .*migration is in progress or was interrupted.*run migrate\\(\\) again`,
      ),
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(Date.now() - started).toBeLessThan(5_000);
    release();
    await migration;
  });

  it("leaves the model as it was when a row does not fit the new mapping", async () => {
    const { indexPrefix, adapter: running } = await populatedPrefix(2);
    await running.create({
      model: "user",
      data: userData({ score: "not a number" }),
    });
    const { auth } = app(indexPrefix, scoreAs("number"));
    const alias = `${indexPrefix}_user`;

    await expect(migrate(auth)).rejects.toThrow(
      new RegExp(`"${alias}_v1" is unchanged`),
    );

    expect(await backingIndices(alias)).toEqual([`${alias}_v1`]);
    expect(await client.indices.exists({ index: `${alias}_v2` })).toBe(false);
    // Writes go through again at once.
    await running.create({ model: "user", data: userData() });
    expect(await running.count({ model: "user" })).toBe(4);
  });

  it("refuses an auth instance on another database", async () => {
    const auth = { $context: Promise.resolve({ adapter: { options: {} } }) };

    await expect(migrate(auth)).rejects.toThrow(/elasticsearchAdapter\(\)/);
  });
});
