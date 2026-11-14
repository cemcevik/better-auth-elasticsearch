import { Client } from "@elastic/elasticsearch";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { elasticsearchAdapter } from "better-auth-elasticsearch";

const client = new Client({ node: process.env.ELASTICSEARCH_URL });

export const auth = betterAuth({
  database: elasticsearchAdapter({ client, indexPrefix: "example" }),
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: {
      company: { type: "string", required: false },
    },
  },
  plugins: [nextCookies()],
});
