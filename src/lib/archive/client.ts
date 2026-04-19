import { http } from "../http/client.ts";

const WAYBACK_SAVE_URL = "https://web.archive.org/save";
const WAYBACK_SUBMIT_TIMEOUT_MS = 10_000;

type SubmitWaybackPostOptions = {
  accessKey: string;
  secretKey: string;
  signal?: AbortSignal;
};

type SubmitWaybackGetOptions = {
  signal?: AbortSignal;
};

export const submitWaybackPost = async (
  url: string,
  { accessKey, secretKey, signal }: SubmitWaybackPostOptions,
): Promise<{ jobId: string }> => {
  const response = await http.raw(WAYBACK_SAVE_URL, {
    method: "POST",
    responseType: "json",
    headers: {
      Accept: "application/json",
      Authorization: `LOW ${accessKey}:${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: new URLSearchParams({
      url,
      if_not_archived_within: "30d",
      skip_first_archive: "1",
    }),
    retry: 0,
    signal,
    timeout: WAYBACK_SUBMIT_TIMEOUT_MS,
  });

  const jobId = (response._data as { job_id?: string } | null | undefined)?.job_id;
  if (!jobId) {
    throw new Error("Wayback response did not include a job_id.");
  }

  return { jobId };
};

export const submitWaybackGet = async (
  url: string,
  { signal }: SubmitWaybackGetOptions = {},
): Promise<void> => {
  await http.raw(`${WAYBACK_SAVE_URL}/${url}`, {
    method: "GET",
    redirect: "manual",
    responseType: "text",
    retry: 0,
    signal,
    timeout: WAYBACK_SUBMIT_TIMEOUT_MS,
  });
};
