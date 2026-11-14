// 409 is not retried: a version conflict on a create (duplicate id) or on a
// sequence-number check fails the same way every time.
const isRetriableStatus = (status?: number): boolean => {
  if (status === undefined) return false;
  return status === 408 || status === 429 || status >= 500;
};

/** The HTTP status of an Elasticsearch client error, if it has one. */
export const statusCodeOf = (error: unknown): number | undefined => {
  const withStatus = error as
    | { statusCode?: number; meta?: { statusCode?: number } }
    | undefined;
  return withStatus?.statusCode ?? withStatus?.meta?.statusCode;
};

/** Elasticsearch's version conflict: a duplicate id or a stale write. */
export const isVersionConflict = (error: unknown): boolean =>
  statusCodeOf(error) === 409;

/** A document or index that does not exist. */
export const isNotFound = (error: unknown): boolean =>
  statusCodeOf(error) === 404;

/**
 * A write refused because its index has a write block, which migrate() sets
 * on the old index while it copies the rows. Also matches a bulk item's
 * `{ status, error }`, and a by-query write whose every failure is the block.
 */
export const isWriteBlocked = (errorOrItem: unknown): boolean => {
  const withBody = errorOrItem as {
    status?: number;
    error?: { type?: string; reason?: string };
    meta?: {
      body?: {
        error?: { type?: string; reason?: string };
        failures?: { status?: number; cause?: object }[];
      };
    };
  };
  const failures = withBody?.meta?.body?.failures;
  if (failures && failures.length > 0) {
    return failures.every((failure) =>
      isWriteBlocked({ status: failure.status, error: failure.cause }),
    );
  }
  const status = withBody?.status ?? statusCodeOf(errorOrItem);
  const error = withBody?.error ?? withBody?.meta?.body?.error;
  return (
    status === 403 &&
    error?.type === "cluster_block_exception" &&
    (error.reason ?? "").includes("index write")
  );
};

/**
 * A wait of at most `timeoutMs` from the first pause, spread over many short
 * pauses. Each call pauses once, a little longer each time; once the time is
 * used up it throws an error saying `alias` is still write-blocked, with
 * `cause` and any `progress` made so far.
 */
export const writeBlockWaiter = (timeoutMs: number, alias: string) => {
  let deadline: number | undefined;
  let pauses = 0;
  return async (cause: unknown, progress?: string): Promise<void> => {
    deadline ??= Date.now() + timeoutMs;
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error(
        `Writes to "${alias}" were still blocked after ${timeoutMs} ms: a migration is in progress or was interrupted. If no migrate() is running, run migrate() again to finish it.${progress ? ` ${progress}` : ""}`,
        { cause },
      );
    }
    const pause = Math.min(500, 25 * 2 ** pauses++) * (0.5 + Math.random());
    await wait(Math.min(left, pause));
  };
};

/**
 * Runs `operation` again while its write to `alias` meets a migration's
 * write block, for at most `timeoutMs`. The whole operation reruns, so a
 * write that is conditional on what it read reads again from the index the
 * alias points at by then.
 */
export const waitOutWriteBlock = async <T>(
  timeoutMs: number,
  alias: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const pause = writeBlockWaiter(timeoutMs, alias);
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isWriteBlocked(error)) throw error;
      await pause(error);
    }
  }
};

/**
 * Runs `attempt` until it returns something other than `retry`, waiting a
 * short, jittered while between tries so contenders spread out. Throws once
 * `maxAttempts` tries all asked to retry.
 */
export const retryOnContention = async <T>(
  description: string,
  maxAttempts: number,
  attempt: (retry: symbol) => Promise<T | symbol>,
): Promise<T> => {
  const retry = Symbol("retry");
  for (let tries = 0; tries < maxAttempts; tries++) {
    const result = await attempt(retry);
    if (result !== retry) return result as T;
    await wait(Math.random() * Math.min(200, 10 * 2 ** tries));
  }
  throw new Error(
    `${description} did not complete after ${maxAttempts} attempts because other requests kept changing the same rows`,
  );
};

const isRetriableError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;

  if (isRetriableStatus(statusCodeOf(error))) return true;

  const withStatus = error as Error & { code?: string };

  const name = withStatus.name ?? "";
  const code = withStatus.code ?? "";

  return (
    name === "TimeoutError" ||
    name === "ConnectionError" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE"
  );
};

export const wait = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

export const withElasticsearchRetry = async <T>(
  operation: () => Promise<T>,
  maxRetries = 3,
): Promise<T> => {
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !isRetriableError(error)) {
        throw error;
      }

      const backoff = Math.min(1000, 100 * 2 ** attempt);
      attempt += 1;
      await wait(backoff);
    }
  }
};
