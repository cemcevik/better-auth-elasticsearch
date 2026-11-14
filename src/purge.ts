import type { Where } from "better-auth/types";

/** How many rows purgeExpired() deleted, per model. */
export interface PurgeResult {
  session: number;
  verification: number;
}

/** The part of a better-auth instance purgeExpired() uses. */
export interface AuthWithAdapter {
  $context: Promise<{
    adapter: {
      deleteMany: (data: { model: string; where: Where[] }) => Promise<number>;
    };
  }>;
}

/**
 * Deletes the session and verification rows whose `expiresAt` has passed,
 * and reports how many of each it deleted. better-auth itself only removes
 * an expired session when its token is presented again, so without this the
 * session index grows without bound. The adapter runs no background work:
 * call this from your own scheduler (a cron job, a queue, a timer).
 */
export const purgeExpired = async (
  auth: AuthWithAdapter,
): Promise<PurgeResult> => {
  const { adapter } = await auth.$context;
  const expiredBy = new Date();
  const purge = (model: keyof PurgeResult) =>
    adapter.deleteMany({
      model,
      where: [{ field: "expiresAt", operator: "lt", value: expiredBy }],
    });
  return {
    session: await purge("session"),
    verification: await purge("verification"),
  };
};
