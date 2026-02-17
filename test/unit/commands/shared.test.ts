import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  commandJson,
  commandVerbose,
  parseCommandArgs,
  runWithErrorHandling,
} from "../../../src/commands/shared.ts";

const output = {
  stdout: "",
  stderr: "",
};

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

beforeEach(() => {
  output.stdout = "";
  output.stderr = "";
  process.exitCode = undefined;

  process.stdout.write = ((chunk: unknown) => {
    output.stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    output.stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  process.exitCode = undefined;
});

describe("command helpers", () => {
  it("reads json/verbose flags", () => {
    expect(commandJson({ json: true })).toBe(true);
    expect(commandJson({ json: false })).toBe(false);
    expect(commandVerbose({ verbose: true })).toBe(true);
    expect(commandVerbose({ verbose: false })).toBe(false);
  });

  it("parseCommandArgs returns parsed data on success", () => {
    const schema = z.object({ value: z.string().min(1) });
    const parsed = parseCommandArgs(schema, { value: "ok" });

    expect(parsed.value).toBe("ok");
  });

  it("parseCommandArgs throws WachiError on validation failure", () => {
    const schema = z.object({ value: z.string().min(1) });
    expect(() => parseCommandArgs(schema, { value: "" })).toThrow("Invalid command arguments");
  });

  it("runWithErrorHandling sets process.exitCode from run result", async () => {
    await runWithErrorHandling({}, async () => 2);
    expect(process.exitCode).toBe(2);
  });

  it("runWithErrorHandling prints JSON error envelope when json flag is enabled", async () => {
    await runWithErrorHandling({ json: true }, async () => {
      throw new Error("boom");
    });

    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(output.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.why).toContain("boom");
  });

  it("runWithErrorHandling prints text error when json flag is disabled", async () => {
    await runWithErrorHandling({ json: false }, async () => {
      throw new Error("boom");
    });

    expect(process.exitCode).toBe(1);
    expect(output.stderr).toContain("Error:");
  });
});
