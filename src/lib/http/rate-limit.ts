const domainLastRequestMap = new Map<string, number>();

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export const waitForDomainRateLimit = async (
  targetUrl: string,
  minDelayMs = 1_000,
): Promise<void> => {
  let hostname = "";
  try {
    const url = new URL(targetUrl);
    hostname = url.hostname;
  } catch {
    return;
  }

  const now = Date.now();
  const previous = domainLastRequestMap.get(hostname);
  if (previous) {
    const elapsed = now - previous;
    if (elapsed < minDelayMs) {
      await sleep(minDelayMs - elapsed);
    }
  }

  domainLastRequestMap.set(hostname, Date.now());
};
