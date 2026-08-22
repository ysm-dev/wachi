import {
  DEFAULT_DOMAIN_MIN_DELAY_MS,
  domainRateLimitKey,
  tryAcquireDomainRateLimit,
} from "../http/rate-limit.ts";

type RateLimitedWork = {
  targetUrl: string;
};

type WorkBucket<T> = {
  items: T[];
  index: number;
};

export const runRateLimitedChecks = async <T extends RateLimitedWork>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
  minDelayMs = DEFAULT_DOMAIN_MIN_DELAY_MS,
): Promise<void> => {
  if (items.length === 0) {
    return;
  }

  const bucketsByHost = new Map<string, WorkBucket<T>>();
  for (const item of items) {
    const key = domainRateLimitKey(item.targetUrl) ?? `invalid:${bucketsByHost.size}`;
    const bucket = bucketsByHost.get(key) ?? { items: [], index: 0 };
    bucket.items.push(item);
    bucketsByHost.set(key, bucket);
  }
  const buckets = [...bucketsByHost.values()];
  const maxActive = Math.max(1, Math.floor(concurrency));

  await new Promise<void>((resolve, reject) => {
    let active = 0;
    let completed = 0;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let firstError: unknown;
    let failed = false;

    const pump = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }

      while (active < maxActive && completed + active < items.length) {
        let selected: T | undefined;
        let selectedBucketIndex = -1;
        let retryAfterMs = Number.POSITIVE_INFINITY;

        for (let offset = 0; offset < buckets.length; offset += 1) {
          const bucketIndex = (cursor + offset) % buckets.length;
          const bucket = buckets[bucketIndex];
          const item = bucket?.items[bucket.index];
          if (!item) {
            continue;
          }

          const acquisition = tryAcquireDomainRateLimit(item.targetUrl, minDelayMs);
          if (acquisition.acquired) {
            selected = item;
            selectedBucketIndex = bucketIndex;
            break;
          }
          retryAfterMs = Math.min(retryAfterMs, acquisition.retryAfterMs);
        }

        if (!selected || selectedBucketIndex < 0) {
          if (Number.isFinite(retryAfterMs)) {
            timer = setTimeout(pump, Math.max(1, retryAfterMs));
          }
          break;
        }

        const bucket = buckets[selectedBucketIndex];
        if (!bucket) {
          break;
        }
        bucket.index += 1;
        cursor = (selectedBucketIndex + 1) % buckets.length;
        active += 1;

        void run(selected)
          .catch((error: unknown) => {
            if (!failed) {
              firstError = error;
              failed = true;
            }
          })
          .finally(() => {
            active -= 1;
            completed += 1;
            if (completed === items.length) {
              if (failed) {
                reject(firstError);
              } else {
                resolve();
              }
              return;
            }
            pump();
          });
      }
    };

    pump();
  });
};
