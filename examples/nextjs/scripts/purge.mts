// Usage: pnpm purge
import { purgeExpired } from "better-auth-elasticsearch";
import { auth } from "../src/lib/auth.ts";

const { session, verification } = await purgeExpired(auth);
console.log(`Deleted ${session} sessions and ${verification} verifications.`);
