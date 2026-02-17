export type InstallMethod = "npm" | "brew" | "binary";

export const detectInstallMethod = (execPath: string): InstallMethod => {
  const lower = execPath.toLowerCase();
  if (lower.includes("node_modules") || lower.includes("bun")) {
    return "npm";
  }
  if (lower.includes("homebrew") || lower.includes("cellar")) {
    return "brew";
  }
  return "binary";
};
