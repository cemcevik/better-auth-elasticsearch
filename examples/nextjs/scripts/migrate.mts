// Usage: pnpm migrate
import { migrate } from "better-auth-elasticsearch";
import { auth } from "../src/lib/auth.ts";

const { migrated } = await migrate(auth);
if (migrated.length === 0) {
  console.log("Every index already matches the schema; nothing to migrate.");
}
for (const { model, alias, from, to } of migrated) {
  console.log(`${model}: ${alias} now points at ${to}; ${from} kept.`);
}
