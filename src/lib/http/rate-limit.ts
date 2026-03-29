const DEFAULT_MIN_DELAY_MS = 250;

const domainNextAllowedAtMap = new Map<string, Promise<number>>();

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export const waitForDomainRateLimit = async (
  targetUrl: string,
  minDelayMs = DEFAULT_MIN_DELAY_MS,
): Promise<void> => {
  let hostname = "";
  try {
    const url = new URL(targetUrl);
    hostname = url.hostname;
  } catch {
    return;
  }

  const previous = domainNextAllowedAtMap.get(hostname) ?? Promise.resolve(0);
  let resolveNextAllowedAt = (_value: number) => {};
  const next = new Promise<number>((resolve) => {
    resolveNextAllowedAt = resolve;
  });

  domainNextAllowedAtMap.set(
    hostname,
    next.catch(() => {
      return 0;
    }),
  );

  try {
    const nextAllowedAt = await previous;
    const waitMs = Math.max(0, nextAllowedAt - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  } finally {
    resolveNextAllowedAt(Date.now() + minDelayMs);
  }
};
