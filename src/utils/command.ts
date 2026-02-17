export type SpawnFn = typeof Bun.spawn;

const createLookupCommand = (command: string, platform: NodeJS.Platform): string[] => {
  if (platform === "win32") {
    return ["cmd", "/c", "where", command];
  }

  return ["sh", "-lc", `command -v ${command}`];
};

type CommandExistsOptions = {
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
};

export const commandExists = async (
  command: string,
  options: CommandExistsOptions = {},
): Promise<boolean> => {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? Bun.spawn;
  const proc = spawn(createLookupCommand(command, platform), {
    stdout: "ignore",
    stderr: "ignore",
  });

  return (await proc.exited) === 0;
};
