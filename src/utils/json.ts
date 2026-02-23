import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ZodType } from "zod";
import { SellbotError } from "../errors.js";

export const readJsonFile = async <T>(
  filePath: string,
  schema: ZodType<T>
): Promise<T | null> => {
  let raw: string;

  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SellbotError(
      "JSON_PARSE_ERROR",
      `JSON non valido in ${filePath}: ${(error as Error).message}`
    );
  }

  return schema.parse(parsed);
};

export const writeJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};
