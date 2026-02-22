import { spawn } from "node:child_process";

export const openInBrowser = async (url: string): Promise<void> => {
  const platform = process.platform;

  let command = "";
  let args: string[] = [];
  let useShell = false;

  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "start";
    args = ["", url];
    useShell = true;
  } else {
    command = "xdg-open";
    args = [url];
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
      shell: useShell
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
};
