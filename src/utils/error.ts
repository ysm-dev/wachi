export class WachiError extends Error {
  readonly what: string;
  readonly why: string;
  readonly fix: string;
  readonly exitCode: number;

  constructor(what: string, why: string, fix: string, exitCode = 1) {
    super(`Error: ${what}`);
    this.name = "WachiError";
    this.what = what;
    this.why = why;
    this.fix = fix;
    this.exitCode = exitCode;
  }

  format(): string {
    return `Error: ${this.what}\n\n${this.why}\n\n${this.fix}`;
  }
}

export const toWachiError = (error: unknown, fallbackWhat = "Unexpected error") => {
  if (error instanceof WachiError) {
    return error;
  }

  if (error instanceof Error) {
    return new WachiError(
      fallbackWhat,
      error.message,
      "Run with --verbose for more details or check your network/configuration.",
    );
  }

  return new WachiError(
    fallbackWhat,
    "An unknown error occurred.",
    "Run again with --verbose for more details.",
  );
};
