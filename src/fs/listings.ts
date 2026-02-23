import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ZodError } from "zod";
import { SellbotError, isSellbotError } from "../errors.js";
import { draftSchema, ebayBuildSchema, statusSchema } from "../schemas/index.js";
import type { Draft, EbayBuild, Status } from "../types.js";
import { readJsonFile, writeJsonFile } from "../utils/json.js";

export interface ListingPaths {
  slug: string;
  dir: string;
  photosDir: string;
  notesPath: string;
  draftPath: string;
  ebayPath: string;
  statusPath: string;
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

const listingFromDir = (dir: string): ListingPaths => {
  const slug = path.basename(dir);
  return {
    slug,
    dir,
    photosDir: path.join(dir, "photos"),
    notesPath: path.join(dir, "notes.txt"),
    draftPath: path.join(dir, "draft.json"),
    ebayPath: path.join(dir, "ebay.json"),
    statusPath: path.join(dir, "status.json")
  };
};

export const getToSellRoot = (cwd = process.cwd()): string => {
  return path.resolve(cwd, "ToSell");
};

export const ensureToSellRoot = async (rootPath: string): Promise<void> => {
  await mkdir(rootPath, { recursive: true });
};

export const listListingFolders = async (rootPath: string): Promise<ListingPaths[]> => {
  await ensureToSellRoot(rootPath);
  const entries = await readdir(rootPath, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => listingFromDir(path.join(rootPath, entry.name)))
    .sort((a, b) => a.slug.localeCompare(b.slug));
};

export const listPhotoFiles = async (photosDir: string): Promise<string[]> => {
  try {
    const entries = await readdir(photosDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
};

export const readNotes = async (notesPath: string): Promise<string> => {
  try {
    return await readFile(notesPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }
};

export const readDraft = async (draftPath: string): Promise<Draft | null> => {
  return readJsonFile(draftPath, draftSchema);
};

export const writeDraft = async (draftPath: string, draft: Draft): Promise<void> => {
  await writeJsonFile(draftPath, draftSchema.parse(draft));
};

export const readEbayBuild = async (ebayPath: string): Promise<EbayBuild | null> => {
  return readJsonFile(ebayPath, ebayBuildSchema);
};

export const writeEbayBuild = async (ebayPath: string, ebayBuild: EbayBuild): Promise<void> => {
  await writeJsonFile(ebayPath, ebayBuildSchema.parse(ebayBuild));
};

export const emptyStatus = (): Status => ({
  state: "draft",
  published_at: null,
  ebay: {
    sku: null,
    offer_id: null,
    listing_id: null,
    url: null
  },
  last_error: null
});

export const readStatus = async (statusPath: string): Promise<Status> => {
  try {
    const status = await readJsonFile(statusPath, statusSchema);
    return status ?? emptyStatus();
  } catch (error) {
    if (error instanceof ZodError) {
      throw new SellbotError("STATUS_INVALID", `status.json non valido: ${error.message}`);
    }

    throw error;
  }
};

export const writeStatus = async (statusPath: string, status: Status): Promise<void> => {
  await writeJsonFile(statusPath, statusSchema.parse(status));
};

export const readStatusOrEmpty = async (statusPath: string): Promise<Status> => {
  try {
    return await readStatus(statusPath);
  } catch (error) {
    if (
      isSellbotError(error) &&
      (error.code === "STATUS_INVALID" || error.code === "JSON_PARSE_ERROR")
    ) {
      return emptyStatus();
    }

    throw error;
  }
};

const directoryExists = async (candidate: string): Promise<boolean> => {
  try {
    const metadata = await stat(candidate);
    return metadata.isDirectory();
  } catch {
    return false;
  }
};

export const resolveListing = async (rootPath: string, input: string): Promise<ListingPaths> => {
  const asGiven = path.resolve(process.cwd(), input);
  const inRoot = path.resolve(rootPath, input);
  const candidates = [asGiven, inRoot];

  for (const candidate of candidates) {
    if (await directoryExists(candidate)) {
      return listingFromDir(candidate);
    }
  }

  throw new SellbotError(
    "LISTING_NOT_FOUND",
    `Cartella non trovata: ${input}. Atteso percorso esistente oppure slug in ${rootPath}`
  );
};
