import { WachiError } from "../../utils/error.ts";

const createCommandResult = (stdout: string, stderr: string) => {
  return { stdout, stderr };
};

type CommandResult = ReturnType<typeof createCommandResult>;

export const runBrowserCommand = async (
  args: string[],
  timeoutMs = 60_000,
): Promise<CommandResult> => {
  const proc = Bun.spawn(["agent-browser", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timed = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new WachiError("agent-browser command timed out", args.join(" "), "Try again."));
    }, timeoutMs);

    proc.exited.finally(() => clearTimeout(timer));
  });

  await Promise.race([proc.exited, timed]);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if ((await proc.exited) !== 0) {
    throw new WachiError(
      `agent-browser ${args[0] ?? ""} failed`,
      stderr.trim() || stdout.trim() || "agent-browser exited with an error.",
      "Ensure agent-browser is installed and retry.",
    );
  }

  return createCommandResult(stdout, stderr);
};
