const ARCHIVE_HOSTS = new Set([
  "archive.fo",
  "archive.is",
  "archive.li",
  "archive.md",
  "archive.ph",
  "archive.today",
  "archive.vn",
  "web.archive.org",
]);

const parseIpv4Octets = (hostname: string): number[] | null => {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (
    octets.some(
      (octet, index) =>
        Number.isNaN(octet) || octet < 0 || octet > 255 || octet.toString() !== parts[index],
    )
  ) {
    return null;
  }

  return octets;
};

const isPrivateOrLoopbackHost = (hostname: string): boolean => {
  const normalizedHostname = hostname.toLowerCase();
  if (normalizedHostname === "localhost" || normalizedHostname.endsWith(".local")) {
    return true;
  }

  const ipv6Hostname = normalizedHostname.replace(/^\[(.*)\]$/, "$1");
  if (ipv6Hostname === "::1") {
    return true;
  }

  const ipv4Octets = parseIpv4Octets(normalizedHostname);
  if (!ipv4Octets) {
    return false;
  }

  const first = ipv4Octets[0];
  const second = ipv4Octets[1];
  if (first === undefined || second === undefined) {
    return false;
  }

  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

export const shouldArchive = (url: string): boolean => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return false;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return false;
  }

  if (ARCHIVE_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    return false;
  }

  return !isPrivateOrLoopbackHost(parsedUrl.hostname);
};
