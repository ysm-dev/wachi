export const resolveUrl = (url: string, baseUrl: string): string => {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return baseUrl;
  }
};
