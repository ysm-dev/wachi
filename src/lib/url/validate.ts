import { WachiError } from "../../utils/error.ts";

export const validateAppriseUrl = (appriseUrl: string): void => {
  if (!appriseUrl.includes("://")) {
    throw new WachiError(
      `Invalid apprise URL: ${appriseUrl}`,
      "Apprise URL must be a URI and include ://.",
      "Pass a full apprise URL like slack://token/channel or discord://webhook-id/token.",
    );
  }
};
