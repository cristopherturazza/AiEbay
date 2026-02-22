import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export const confirm = async (question: string, defaultYes = true): Promise<boolean> => {
  if (!input.isTTY) {
    return false;
  }

  const rl = createInterface({ input, output });

  try {
    const suffix = defaultYes ? "[Y/n]" : "[y/N]";
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();

    if (answer.length === 0) {
      return defaultYes;
    }

    return ["y", "yes", "s", "si"].includes(answer);
  } finally {
    rl.close();
  }
};
