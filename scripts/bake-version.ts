import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const run = async (): Promise<void> => {
  const packageJsonPath = resolve(process.cwd(), "package.json");
  const versionTsPath = resolve(process.cwd(), "src/version.ts");

  const packageJsonRaw = await readFile(packageJsonPath, "utf8");
  const packageJson = JSON.parse(packageJsonRaw);

  if (typeof packageJson.version !== "string") {
    throw new Error("package.json does not have a string version field.");
  }

  await writeFile(versionTsPath, `export const VERSION = "${packageJson.version}";\n`, "utf8");
};

await run();
