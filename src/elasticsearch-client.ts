const isRetriableStatus = (status?: number): boolean => {
  if (status === undefined) return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
};

const isRetriableError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;

  const withStatus = error as Error & {
    statusCode?: number;
    meta?: { statusCode?: number };
    name?: string;
    code?: string;
  };

  const statusCode = withStatus.statusCode ?? withStatus.meta?.statusCode;
  if (isRetriableStatus(statusCode)) return true;

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

const wait = async (milliseconds: number): Promise<void> => {
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
