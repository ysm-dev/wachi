export const resolveUrl = (url: string, baseUrl: string): string => {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return baseUrl;
  }
};

export const resolveHttpUrl = (url: string, baseUrl: string): string | null => {
  try {
    const resolved = new URL(url, baseUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.toString()
      : null;
  } catch {
    return null;
  }
};
