#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM_PACKAGE_MAP = {
  "darwin-arm64": "@wachi-cli/darwin-arm64",
  "darwin-x64": "@wachi-cli/darwin-x64",
  "linux-arm64": "@wachi-cli/linux-arm64",
  "linux-x64": "@wachi-cli/linux-x64",
  "win32-x64": "@wachi-cli/win32-x64",
};

const key = `${process.platform}-${process.arch}`;
const packageName = PLATFORM_PACKAGE_MAP[key];
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);

const runBinary = (binaryPath) => {
  const result = spawnSync(binaryPath, args, {
    stdio: "inherit",
  });

  if (result.error) {
    process.stderr.write(
      `Error: Failed to run wachi binary at ${binaryPath}.\n` +
        `${result.error.message}\n` +
        "Try reinstalling wachi and its optional platform package.\n",
    );
    process.exit(1);
  }

  if (typeof result.status === "number") {
    process.exit(result.status);
  }

  if (typeof result.signal === "string") {
    process.stderr.write(`Error: wachi binary terminated by signal ${result.signal}.\n`);
  }

  process.exit(1);
};

const isPlaceholderBinary = (binaryPath) => {
  try {
    if (statSync(binaryPath).size > 4096) {
      return false;
    }

    const fd = openSync(binaryPath, "r");
    try {
      const buffer = Buffer.alloc(512);
      const readSize = readSync(fd, buffer, 0, buffer.length, 0);
      return buffer
        .subarray(0, readSize)
        .toString("utf8")
        .includes("WACHI_DEV_PLACEHOLDER");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
};

const resolvePlatformBinary = () => {
  if (!packageName) {
    return null;
  }

  const binaryNames = process.platform === "win32" ? ["wachi.exe", "wachi"] : ["wachi"];
  for (const binaryName of binaryNames) {
    try {
      const binaryPath = require.resolve(`${packageName}/bin/${binaryName}`);
      if (isPlaceholderBinary(binaryPath)) {
        continue;
      }
      return binaryPath;
    } catch {
      continue;
    }
  }

  return null;
};

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const sourceEntry = join(projectRoot, "src/index.ts");
const binaryPath = resolvePlatformBinary();

if (binaryPath) {
  runBinary(binaryPath);
}

if (existsSync(sourceEntry)) {
  const fallback = spawnSync(process.env.BUN_BINARY || "bun", ["run", sourceEntry, ...args], {
    stdio: "inherit",
  });

  if (typeof fallback.status === "number") {
    process.exit(fallback.status);
  }

  process.stderr.write(
    "Error: Unable to run local development fallback. Install Bun or set BUN_BINARY.\n",
  );
  process.exit(1);
}

if (!packageName) {
  process.stderr.write(
    `Error: Unsupported platform for prebuilt binaries (${key}).\n` +
      "The published wachi package is binary-only.\n",
  );
  process.exit(1);
}

process.stderr.write(
  `Error: Unable to run wachi binary for ${key}.\n` +
    `Expected optional dependency: ${packageName}.\n` +
    "The published wachi package is binary-only.\n" +
    "Reinstall with optional dependencies enabled (avoid --no-optional or --omit=optional).\n",
);
process.exit(1);
