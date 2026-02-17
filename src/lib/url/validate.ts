import { WachiError } from "../../utils/error.ts";
import { http } from "../http/client.ts";

export const validateAppriseUrl = (appriseUrl: string): void => {
  if (!appriseUrl.includes("://")) {
    throw new WachiError(
      `Invalid apprise URL: ${appriseUrl}`,
      "Apprise URL must be a URI and include ://.",
      "Pass a full apprise URL like slack://token/channel or discord://webhook-id/token.",
    );
  }
};

export const validateReachableUrl = async (url: string): Promise<void> => {
  try {
    const response = await http.raw(url, {
      method: "GET",
      responseType: "text",
      retry: 0,
      ignoreResponseError: true,
    });

    if (response.status >= 400) {
      throw new WachiError(
        `Failed to reach ${url}`,
        `HTTP ${response.status} ${response.statusText}. The URL returned an error status.`,
        "Check the URL and try again.",
      );
    }
  } catch (error) {
    if (error instanceof WachiError) {
      throw error;
    }

    throw new WachiError(
      `Failed to reach ${url}`,
      error instanceof Error ? error.message : "Request failed.",
      "Check the URL and your network connection, then try again.",
    );
  }
};
