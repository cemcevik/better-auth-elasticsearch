import { username } from "better-auth/plugins";
import { afterAll, describe, expect, it } from "vitest";

import { elasticsearchAdapter } from "../src/elasticsearch-adapter";
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

describe("index layout and mappings", () => {
  // Vitest collects a skipped suite's body too, so bail out before building a
  // client without a node.
  if (!elasticUrl) {
    it.skip("needs ELASTICSEARCH_URL");
    return;
  }

  const client = createClient();
  const prefixes = new Set();

  /** An adapter on a fresh prefix, built from the given better-auth options. */
  const freshAdapter = (options = {}, indexPrefix = uniquePrefix()) => {
    prefixes.add(indexPrefix);
    return {
      indexPrefix,
      adapter: elasticsearchAdapter({ client, indexPrefix })(options),
    };
  };

  afterAll(async () => {
    await Promise.all(
      [...prefixes].map((prefix) => deleteTestIndices(client, prefix)),
    );
  });

  it("stores a model behind an alias over a v1 index", async () => {
    const { adapter, indexPrefix } = freshAdapter();

    const created = await adapter.create({ model: "user", data: userData() });

    const aliases = await client.indices.getAlias({
      name: `${indexPrefix}_user`,
    });
    expect(Object.keys(aliases)).toEqual([`${indexPrefix}_user_v1`]);
    const found = await adapter.findOne({
      model: "user",
      where: [{ field: "id", value: created.id }],
    });
    expect(found?.email).toBe(created.email);
  });

  it("maps the schema explicitly, plugin fields included, with dynamic mapping off", async () => {
    const { adapter, indexPrefix } = freshAdapter({
      plugins: [username()],
      user: {
        additionalFields: {
          score: { type: "number" },
          visits: { type: "number", bigint: true },
          tags: { type: "string[]" },
          prefs: { type: "json" },
        },
      },
    });

    await adapter.count({ model: "user" });

    const response = await client.indices.getMapping({
      index: `${indexPrefix}_user`,
    });
    const { mappings } = response[`${indexPrefix}_user_v1`];
    const keyword = { type: "keyword", ignore_above: 8191 };
    expect(mappings.dynamic).toBe("false");
    expect(mappings.properties).toEqual({
      id: keyword,
      name: keyword,
      email: keyword,
      emailVerified: { type: "boolean" },
      image: keyword,
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
      username: keyword,
      displayUsername: keyword,
      score: { type: "double" },
      visits: { type: "long" },
      tags: keyword,
      prefs: { type: "object", enabled: false },
    });
  });

  it("finds a row by a string longer than 1024 characters", async () => {
    const { adapter } = freshAdapter();
    const long = "x".repeat(5000);

    const created = await adapter.create({
      model: "user",
      data: userData({ name: long }),
    });

    const found = await adapter.findOne({
      model: "user",
      where: [{ field: "name", value: long }],
    });
    expect(found?.id).toBe(created.id);
  });

  it("stores and returns array fields intact", async () => {
    const { adapter } = freshAdapter({
      user: {
        additionalFields: {
          lucky: { type: "number[]" },
          tags: { type: "string[]" },
        },
      },
    });

    const created = await adapter.create({
      model: "user",
      data: userData({ lucky: [7, 1.5], tags: ["a", "b"] }),
    });

    const found = await adapter.findOne({
      model: "user",
      where: [{ field: "id", value: created.id }],
    });
    expect(found?.lucky).toEqual([7, 1.5]);
    expect(found?.tags).toEqual(["a", "b"]);
  });

  it("sorts numbers numerically", async () => {
    const { adapter } = freshAdapter({
      user: { additionalFields: { score: { type: "number" } } },
    });
    for (const score of [10, 9, 100]) {
      await adapter.create({ model: "user", data: userData({ score }) });
    }

    const rows = await adapter.findMany({
      model: "user",
      sortBy: { field: "score", direction: "asc" },
    });
    expect(rows.map((row) => row.score)).toEqual([9, 10, 100]);
  });

  it("adds a field from a newly enabled plugin on the next first use", async () => {
    const { indexPrefix, adapter: before } = freshAdapter();
    await before.create({ model: "user", data: userData() });

    const { adapter: after } = freshAdapter(
      { plugins: [username()] },
      indexPrefix,
    );
    const created = await after.create({
      model: "user",
      data: userData({ username: "ada" }),
    });

    const found = await after.findOne({
      model: "user",
      where: [{ field: "username", value: "ada" }],
    });
    expect(found?.id).toBe(created.id);
  });

  it("refuses a field whose type changed, naming it and the migration", async () => {
    const { indexPrefix, adapter: before } = freshAdapter({
      user: { additionalFields: { score: { type: "string" } } },
    });
    await before.count({ model: "user" });

    const { adapter: after } = freshAdapter(
      { user: { additionalFields: { score: { type: "number" } } } },
      indexPrefix,
    );

    const attempt = after.count({ model: "user" });
    await expect(attempt).rejects.toThrow(/"score"/);
    await expect(attempt).rejects.toThrow(/migrate\(\)/);
  });

  it("ignores fields in the index that the schema no longer has", async () => {
    const { indexPrefix, adapter: before } = freshAdapter({
      plugins: [username()],
    });
    await before.create({
      model: "user",
      data: userData({ username: "ada" }),
    });

    const { adapter: after } = freshAdapter({}, indexPrefix);
    const created = await after.create({ model: "user", data: userData() });

    const found = await after.findOne({
      model: "user",
      where: [{ field: "id", value: created.id }],
    });
    expect(found?.email).toBe(created.email);
  });

  it("refuses a plain index where the alias belongs and leaves it alone", async () => {
    const { indexPrefix, adapter } = freshAdapter();
    const index = `${indexPrefix}_user`;
    await client.indices.create({ index, mappings: { dynamic: true } });

    await expect(adapter.count({ model: "user" })).rejects.toThrow(
      /plain Elasticsearch index.*Nothing was changed/,
    );

    const indices = await client.indices.get({ index: `${indexPrefix}_*` });
    expect(Object.keys(indices)).toEqual([index]);
    expect(indices[index].mappings).toEqual({ dynamic: "true" });
  });

  it("names the alias after a custom model name", async () => {
    const { indexPrefix, adapter } = freshAdapter({
      user: { modelName: "members" },
    });

    await adapter.count({ model: "user" });

    const aliases = await client.indices.getAlias({
      name: `${indexPrefix}_members`,
    });
    expect(Object.keys(aliases)).toEqual([`${indexPrefix}_members_v1`]);
  });

  it("generates the mappings a freshly created index has, one entry per model", async () => {
    const options = {
      plugins: [username()],
      user: {
        modelName: "members",
        additionalFields: { score: { type: "number" } },
      },
    };
    const { adapter, indexPrefix } = freshAdapter(options);

    const { code, path, overwrite } = await adapter.createSchema(options);

    expect(path).toBe("elasticsearch-mappings.json");
    expect(overwrite).toBe(true);
    const generated = JSON.parse(code);
    expect(Object.keys(generated).sort()).toEqual([
      "account",
      "session",
      "user",
      "verification",
    ]);
    expect(generated.user.alias).toBe(`${indexPrefix}_members`);
    expect(generated.user.mappings.properties.username).toEqual({
      type: "keyword",
      ignore_above: 8191,
    });
    for (const [model, { alias, mappings }] of Object.entries(generated)) {
      await adapter.count({ model });
      const live = await client.indices.getMapping({ index: alias });
      // Elasticsearch reports `dynamic` as a string.
      expect(Object.values(live)[0].mappings).toEqual({
        ...mappings,
        dynamic: String(mappings.dynamic),
      });
    }
  });

  it("puts the generated mappings at the path passed to the command", async () => {
    const { adapter } = freshAdapter();

    const { path } = await adapter.createSchema({}, "schema/es.json");

    expect(path).toBe("schema/es.json");
  });

  it("lowercases the alias of a model name with capitals", async () => {
    const { indexPrefix, adapter } = freshAdapter({
      user: { modelName: "teamMembers" },
    });

    const created = await adapter.create({ model: "user", data: userData() });

    const aliases = await client.indices.getAlias({
      name: `${indexPrefix}_teammembers`,
    });
    expect(Object.keys(aliases)).toEqual([`${indexPrefix}_teammembers_v1`]);
    const found = await adapter.findOne({
      model: "user",
      where: [{ field: "id", value: created.id }],
    });
    expect(found?.email).toBe(created.email);
  });
});
