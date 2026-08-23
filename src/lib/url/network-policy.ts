import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

type LookupAddresses = (hostname: string) => Promise<Array<{ address: string }>>;
export type SafeResolvedAddress = { address: string; family: 4 | 6 };

const withoutIpv6Brackets = (hostname: string): string => hostname.replace(/^\[(.*)\]$/, "$1");

const toAddressFamily = (value: number): 4 | 6 | null => {
  return value === 4 || value === 6 ? value : null;
};

const parseIpv4Octets = (hostname: string): number[] | null => {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => Number.parseInt(part, 10));
  return octets.every(
    (octet, index) =>
      Number.isInteger(octet) && octet >= 0 && octet <= 255 && String(octet) === parts[index],
  )
    ? octets
    : null;
};

export const isPrivateNetworkHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }

  if (normalized.includes(":")) {
    const firstSegment = Number.parseInt(normalized.split(":")[0] ?? "", 16);
    if (
      normalized.startsWith("::") ||
      (Number.isFinite(firstSegment) &&
        ((firstSegment & 0xfe00) === 0xfc00 ||
          (firstSegment & 0xffc0) === 0xfe80 ||
          (firstSegment & 0xff00) === 0xff00))
    ) {
      return true;
    }
  }

  const octets = parseIpv4Octets(normalized);
  if (!octets) {
    return false;
  }

  const first = octets[0] ?? 0;
  const second = octets[1] ?? 0;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
};

export const isSafeDiscoveredHttpUrl = (candidateUrl: string, sourceUrl: string): boolean => {
  let candidate: URL;
  let source: URL;
  try {
    candidate = new URL(candidateUrl);
    source = new URL(sourceUrl);
  } catch {
    return false;
  }

  if (
    (candidate.protocol !== "http:" && candidate.protocol !== "https:") ||
    (source.protocol !== "http:" && source.protocol !== "https:")
  ) {
    return false;
  }

  if (!isPrivateNetworkHost(candidate.hostname)) {
    return true;
  }

  return (
    isPrivateNetworkHost(source.hostname) &&
    candidate.hostname.toLowerCase() === source.hostname.toLowerCase()
  );
};

export const resolveSafeHttpAddresses = async (
  candidateUrl: string,
  sourceUrl: string,
  lookupAddresses: LookupAddresses = (hostname) => lookup(hostname, { all: true, verbatim: true }),
  signal?: AbortSignal,
): Promise<SafeResolvedAddress[] | null> => {
  if (!isSafeDiscoveredHttpUrl(candidateUrl, sourceUrl)) {
    return null;
  }

  const candidate = new URL(candidateUrl);
  const hostname = withoutIpv6Brackets(candidate.hostname);
  const literalFamily = toAddressFamily(isIP(hostname));
  if (literalFamily) {
    return [{ address: hostname, family: literalFamily }];
  }

  try {
    if (signal?.aborted) {
      return null;
    }
    const addresses = await new Promise<Array<{ address: string }>>((resolve, reject) => {
      const onAbort = () => reject(signal?.reason ?? new Error("DNS lookup aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      lookupAddresses(hostname)
        .then(resolve, reject)
        .finally(() => {
          signal?.removeEventListener("abort", onAbort);
        });
    });
    if (addresses.length === 0) {
      return null;
    }
    if (
      !isPrivateNetworkHost(hostname) &&
      addresses.some(({ address }) => isPrivateNetworkHost(address))
    ) {
      return null;
    }
    const resolved = addresses.flatMap(({ address }) => {
      const family = toAddressFamily(isIP(address));
      return family ? [{ address, family }] : [];
    });
    return resolved.length === addresses.length ? resolved : null;
  } catch {
    return null;
  }
};

export const isSafeResolvedHttpUrl = async (
  candidateUrl: string,
  sourceUrl: string,
  lookupAddresses?: LookupAddresses,
  signal?: AbortSignal,
): Promise<boolean> => {
  return (
    (await resolveSafeHttpAddresses(candidateUrl, sourceUrl, lookupAddresses, signal)) !== null
  );
};
