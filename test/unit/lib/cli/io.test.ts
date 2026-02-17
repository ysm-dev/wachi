import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  maskAppriseUrl,
  printError,
  printJsonError,
  printJsonSuccess,
  printStderr,
  printStdout,
} from "../../../../src/lib/cli/io.ts";
import { WachiError } from "../../../../src/utils/error.ts";

const output = {
  stdout: "",
  stderr: "",
};

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

const captureStdout = (chunk: unknown): boolean => {
  output.stdout += String(chunk);
  return true;
};

const captureStderr = (chunk: unknown): boolean => {
  output.stderr += String(chunk);
  return true;
};

beforeEach(() => {
  process.stdout.write = captureStdout as typeof process.stdout.write;
  process.stderr.write = captureStderr as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  output.stdout = "";
  output.stderr = "";
});

describe("cli io", () => {
  it("prints stdout and stderr with newline", () => {
    printStdout("hello");
    printStderr("warn");

    expect(output.stdout).toBe("hello\n");
    expect(output.stderr).toBe("warn\n");
  });

  it("prints success JSON envelope", () => {
    printJsonSuccess({ sent: true });

    const payload = JSON.parse(output.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data.sent).toBe(true);
  });

  it("prints error JSON envelope", () => {
    const error = new WachiError("what", "why", "fix", 2);
    printJsonError(error);

    const payload = JSON.parse(output.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.what).toBe("what");
    expect(payload.error.fix).toBe("fix");
  });

  it("printError routes to stderr for text mode", () => {
    const error = new WachiError("boom", "because", "do this", 1);
    printError(error, false);

    expect(output.stderr).toContain("Error: boom");
    expect(output.stdout).toBe("");
  });

  it("printError routes to stdout for json mode", () => {
    const error = new WachiError("boom", "because", "do this", 1);
    printError(error, true);

    const payload = JSON.parse(output.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(output.stderr).toBe("");
  });

  it("masks apprise URLs consistently", () => {
    expect(maskAppriseUrl("no-scheme")).toBe("no-scheme");
    expect(maskAppriseUrl("slack://abc")).toBe("slack://***");
    expect(maskAppriseUrl("slack://abcdef")).toBe("slack://***");
    expect(maskAppriseUrl("slack://abcdefgh")).toBe("slack://abcd...");
    expect(maskAppriseUrl("slack://token/channel")).toBe("slack://token.../channel");
  });
});
