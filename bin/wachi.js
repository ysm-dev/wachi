#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM_PACKAGE_MAP = {
  "darwin-arm64": "@wachi/darwin-arm64",
  "darwin-x64": "@wachi/darwin-x64",
  "linux-arm64": "@wachi/linux-arm64",
  "linux-x64": "@wachi/linux-x64",
  "win32-x64": "@wachi/win32-x64",
};

const key = `${process.platform}-${process.arch}`;
const packageName = PLATFORM_PACKAGE_MAP[key];
const require = createRequire(import.meta.url);

const runBinary = (binaryPath) => {
  const result = spawnSync(binaryPath, process.argv.slice(2), {
    stdio: "inherit",
  });
  if (typeof result.status === "number") {
    process.exit(result.status);
  }
  process.exit(1);
};

const isPlaceholderBinary = (binaryPath) => {
  try {
    const content = readFileSync(binaryPath, "utf8");
    return content.includes("WACHI_DEV_PLACEHOLDER");
  } catch {
    return false;
  }
};

if (packageName) {
  const binaryNames = process.platform === "win32" ? ["wachi.exe", "wachi"] : ["wachi"];
  for (const binaryName of binaryNames) {
    try {
      const binaryPath = require.resolve(`${packageName}/bin/${binaryName}`);
      if (isPlaceholderBinary(binaryPath)) {
        continue;
      }
      runBinary(binaryPath);
    } catch {
      continue;
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const fallback = spawnSync(
  process.env.BUN_BINARY || "bun",
  ["run", join(projectRoot, "src/index.ts"), ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);

if (typeof fallback.status === "number") {
  process.exit(fallback.status);
}

process.stderr.write(
  "Error: Unable to run wachi. Install Bun for local dev fallback or install matching @wachi/* binary package.\n",
);
process.exit(1);
