import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ZodError } from "zod";
import { SellbotError, isSellbotError } from "../errors.js";
import {
  draftSchema,
  ebayBuildSchema,
  enrichmentReportSchema,
  intakeReportSchema,
  statusSchema
} from "../schemas/index.js";
import type { Draft, EbayBuild, EnrichmentReport, IntakeReport, Status } from "../types.js";
import { readJsonFile, writeJsonFile } from "../utils/json.js";

export interface ListingPaths {
  slug: string;
  dir: string;
  photosDir: string;
  notesPath: string;
  draftPath: string;
  enrichmentPath: string;
  intakePath: string;
  ebayPath: string;
  statusPath: string;
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".heic"]);

const normalizeStructuredFileReadError = (
  filePath: string,
  code: string,
  error: unknown
): never => {
  if (error instanceof ZodError) {
    throw new SellbotError(code, `${path.basename(filePath)} non valido: ${error.message}`);
  }

  if (isSellbotError(error) && error.code === "JSON_PARSE_ERROR") {
    throw new SellbotError(code, `${path.basename(filePath)} non valido: ${error.message}`);
  }

  throw error;
};

const listingFromDir = (dir: string): ListingPaths => {
  const slug = path.basename(dir);
  return {
    slug,
    dir,
    photosDir: path.join(dir, "photos"),
    notesPath: path.join(dir, "notes.txt"),
    draftPath: path.join(dir, "draft.json"),
    enrichmentPath: path.join(dir, "enrichment.json"),
    intakePath: path.join(dir, "intake.json"),
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
  try {
    return await readJsonFile(draftPath, draftSchema);
  } catch (error) {
    throw normalizeStructuredFileReadError(draftPath, "DRAFT_INVALID", error);
  }
};

export const writeDraft = async (draftPath: string, draft: Draft): Promise<void> => {
  await writeJsonFile(draftPath, draftSchema.parse(draft));
};

export const readEnrichmentReport = async (enrichmentPath: string): Promise<EnrichmentReport | null> => {
  try {
    return await readJsonFile(enrichmentPath, enrichmentReportSchema);
  } catch (error) {
    throw normalizeStructuredFileReadError(enrichmentPath, "ENRICHMENT_INVALID", error);
  }
};

export const writeEnrichmentReport = async (
  enrichmentPath: string,
  enrichmentReport: EnrichmentReport
): Promise<void> => {
  await writeJsonFile(enrichmentPath, enrichmentReportSchema.parse(enrichmentReport));
};

export const readIntakeReport = async (intakePath: string): Promise<IntakeReport | null> => {
  try {
    return await readJsonFile(intakePath, intakeReportSchema);
  } catch (error) {
    throw normalizeStructuredFileReadError(intakePath, "INTAKE_INVALID", error);
  }
};

export const writeIntakeReport = async (intakePath: string, intakeReport: IntakeReport): Promise<void> => {
  await writeJsonFile(intakePath, intakeReportSchema.parse(intakeReport));
};

export const readEbayBuild = async (ebayPath: string): Promise<EbayBuild | null> => {
  try {
    return await readJsonFile(ebayPath, ebayBuildSchema);
  } catch (error) {
    throw normalizeStructuredFileReadError(ebayPath, "EBAY_BUILD_INVALID", error);
  }
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
