import type { WachiError } from "../../utils/error.ts";

export const printStdout = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export const printStderr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export const printJsonSuccess = <TData>(data: TData): void => {
  const payload = { ok: true, data };
  printStdout(JSON.stringify(payload));
};

export const printJsonError = (error: WachiError): void => {
  const payload = {
    ok: false,
    error: {
      what: error.what,
      why: error.why,
      fix: error.fix,
    },
  };
  printStdout(JSON.stringify(payload));
};

export const printError = (error: WachiError, json: boolean): void => {
  if (json) {
    printJsonError(error);
    return;
  }
  printStderr(error.format());
};

export const maskAppriseUrl = (url: string): string => {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd === -1) {
    return url;
  }

  const scheme = url.slice(0, schemeEnd + 3);
  const rest = url.slice(schemeEnd + 3);
  if (rest.length < 8) {
    return `${scheme}***`;
  }

  const slashIndex = rest.lastIndexOf("/");
  if (slashIndex <= 2) {
    return `${scheme}${rest.slice(0, 4)}...`;
  }

  const head = rest.slice(0, 5);
  const tail = rest.slice(slashIndex);
  return `${scheme}${head}...${tail}`;
};
