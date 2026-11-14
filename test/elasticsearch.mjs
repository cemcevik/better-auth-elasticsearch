import { randomUUID } from "node:crypto";

import { Client } from "@elastic/elasticsearch";

/** Connection settings shared by every integration test file. */
export const elasticUrl = process.env.ELASTICSEARCH_URL;

if (process.env.BETTER_AUTH_FORCE_ELASTIC_TESTS === "true" && !elasticUrl) {
  throw new Error(
    "ELASTICSEARCH_URL is required when BETTER_AUTH_FORCE_ELASTIC_TESTS=true",
  );
}

export const createClient = () => {
  const username = process.env.ELASTICSEARCH_USERNAME;
  const password = process.env.ELASTICSEARCH_PASSWORD;
  return new Client({
    node: elasticUrl,
    ...(username && password ? { auth: { username, password } } : {}),
  });
};

/** A prefix no other run or test shares, so runs never see each other's data. */
export const uniquePrefix = () =>
  `ba_test_${Date.now()}_${randomUUID().slice(0, 8)}`;

/** Deletes every index created under a prefix. */
export const deleteTestIndices = async (client, indexPrefix) => {
  const indices = await client.indices.get({
    index: `${indexPrefix}_*`,
    ignore_unavailable: true,
    allow_no_indices: true,
  });
  const names = Object.keys(indices);
  if (names.length > 0) await client.indices.delete({ index: names });
};
