import { http } from "../http/client.ts";

export const fetchArticleHtml = async (url: string): Promise<string> => {
  const response = await http.raw(url, { responseType: "text" });
  return typeof response._data === "string" ? response._data : "";
};
