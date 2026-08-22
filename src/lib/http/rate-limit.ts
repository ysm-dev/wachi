export const DEFAULT_DOMAIN_MIN_DELAY_MS = 250;

const domainNextAllowedAtMap = new Map<string, number>();

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export type DomainRateLimitResult = { acquired: true } | { acquired: false; retryAfterMs: number };

export const domainRateLimitKey = (targetUrl: string): string | null => {
  try {
    return new URL(targetUrl).hostname;
  } catch {
    return null;
  }
};

export const tryAcquireDomainRateLimit = (
  targetUrl: string,
  minDelayMs = DEFAULT_DOMAIN_MIN_DELAY_MS,
): DomainRateLimitResult => {
  const hostname = domainRateLimitKey(targetUrl);
  if (!hostname) {
    return { acquired: true };
  }

  const now = Date.now();
  const nextAllowedAt = domainNextAllowedAtMap.get(hostname) ?? 0;
  if (nextAllowedAt > now) {
    return { acquired: false, retryAfterMs: nextAllowedAt - now };
  }

  domainNextAllowedAtMap.set(hostname, now + Math.max(0, minDelayMs));
  return { acquired: true };
};

export const waitForDomainRateLimit = async (
  targetUrl: string,
  minDelayMs = DEFAULT_DOMAIN_MIN_DELAY_MS,
): Promise<void> => {
  while (true) {
    const result = tryAcquireDomainRateLimit(targetUrl, minDelayMs);
    if (result.acquired) {
      return;
    }
    await sleep(result.retryAfterMs);
  }
};

export const resetDomainRateLimitsForTest = (): void => {
  domainNextAllowedAtMap.clear();
};
