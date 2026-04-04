export const isNewerVersion = (current: string, latest: string): boolean => {
  const currentParts = current.split(".").map((part) => Number(part));
  const latestParts = latest.split(".").map((part) => Number(part));

  const maxLength = Math.max(currentParts.length, latestParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const currentPart = currentParts[index] ?? 0;
    const latestPart = latestParts[index] ?? 0;
    if (latestPart > currentPart) {
      return true;
    }
    if (latestPart < currentPart) {
      return false;
    }
  }

  return false;
};
