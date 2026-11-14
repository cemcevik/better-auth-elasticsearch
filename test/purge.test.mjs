import { betterAuth } from "better-auth";
import { afterAll, describe, expect, it } from "vitest";

import { elasticsearchAdapter } from "../src/elasticsearch-adapter";
import { purgeExpired } from "../src/purge";
import {
  createClient,
  deleteTestIndices,
  elasticUrl,
  uniquePrefix,
} from "./elasticsearch.mjs";

const DAY = 24 * 60 * 60 * 1000;

describe("purgeExpired()", () => {
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

  const app = () => {
    const indexPrefix = uniquePrefix();
    prefixes.push(indexPrefix);
    const database = elasticsearchAdapter({ client, indexPrefix });
    return {
      indexPrefix,
      adapter: database({}),
      auth: betterAuth({
        database,
        secret: "a-test-secret-that-is-long-enough-to-pass",
        baseURL: "http://localhost:3000",
      }),
    };
  };

  const createSession = (adapter, userId, expiresAt) =>
    adapter.create({
      model: "session",
      data: {
        userId,
        token: crypto.randomUUID(),
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

  const createVerification = (adapter, expiresAt) =>
    adapter.create({
      model: "verification",
      data: {
        identifier: crypto.randomUUID(),
        value: "a-value",
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

  const ids = (rows) => rows.map((row) => row.id).sort();

  it("deletes expired session and verification rows and keeps the rest", async () => {
    const { adapter, auth } = app();
    const user = await adapter.create({
      model: "user",
      data: {
        name: "Ada",
        email: `${crypto.randomUUID()}@example.com`,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const past = new Date(Date.now() - DAY);
    const future = new Date(Date.now() + DAY);

    await createSession(adapter, user.id, past);
    await createSession(adapter, user.id, new Date(Date.now() - 1000));
    const liveSession = await createSession(adapter, user.id, future);
    await createVerification(adapter, past);
    const liveVerification = await createVerification(adapter, future);

    await expect(purgeExpired(auth)).resolves.toEqual({
      session: 2,
      verification: 1,
    });

    expect(ids(await adapter.findMany({ model: "session" }))).toEqual([
      liveSession.id,
    ]);
    expect(ids(await adapter.findMany({ model: "verification" }))).toEqual([
      liveVerification.id,
    ]);
    // Users never expire.
    expect(await adapter.count({ model: "user" })).toBe(1);
  });

  it("reports nothing deleted when nothing has expired", async () => {
    const { auth } = app();
    await expect(purgeExpired(auth)).resolves.toEqual({
      session: 0,
      verification: 0,
    });
  });

  it("attaches no lifecycle policy to the session or verification index", async () => {
    const { adapter, indexPrefix } = app();
    await createVerification(adapter, new Date(Date.now() + DAY));
    await createSession(adapter, "a-user", new Date(Date.now() + DAY));

    const settingsByIndex = await client.indices.getSettings({
      index: `${indexPrefix}_*`,
    });
    for (const [index, { settings }] of Object.entries(settingsByIndex)) {
      expect(settings.index?.lifecycle, index).toBeUndefined();
    }
  });
});
