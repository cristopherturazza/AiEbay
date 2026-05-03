import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../config.js";
import { SellbotError } from "../errors.js";
import {
  getInboxSession,
  savePhotoToDir,
  type SavePhotoInput,
  type SavePhotoResult
} from "../fs/inbox.js";
import { getToSellRoot, resolveListing } from "../fs/listings.js";

export interface AddPhotoToListingResult extends SavePhotoResult {
  slug: string;
  listing_dir: string;
}

export const addPhotoToListing = async (
  config: RuntimeConfig,
  slugOrPath: string,
  input: SavePhotoInput
): Promise<AddPhotoToListingResult> => {
  const listing = await resolveListing(getToSellRoot(config.cwd), slugOrPath);
  const result = await savePhotoToDir(listing.photosDir, input);
  return {
    ...result,
    slug: listing.slug,
    listing_dir: listing.dir
  };
};

const pathExists = async (candidate: string): Promise<boolean> => {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const uniqueTargetName = async (targetDir: string, filename: string): Promise<string> => {
  const ext = path.extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  let candidate = filename;
  let attempt = 1;
  while (await pathExists(path.join(targetDir, candidate))) {
    candidate = `${stem}-${attempt}${ext}`;
    attempt += 1;
  }
  return candidate;
};

export interface AdoptInboxPhotosResult {
  slug: string;
  listing_dir: string;
  moved_filenames: string[];
  total_photos_after: number;
  source_session_id: string;
}

export const adoptInboxPhotosToListing = async (
  config: RuntimeConfig,
  slugOrPath: string,
  rawSessionId: string | undefined
): Promise<AdoptInboxPhotosResult> => {
  const toSellRoot = getToSellRoot(config.cwd);
  const listing = await resolveListing(toSellRoot, slugOrPath);
  const session = getInboxSession(toSellRoot, rawSessionId);

  let entries;
  try {
    entries = await readdir(session.photosDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SellbotError(
        "INBOX_EMPTY",
        `Nessuna foto da adottare per session_id=${session.sessionId}`
      );
    }
    throw error;
  }
  const sourceFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);

  if (sourceFiles.length === 0) {
    throw new SellbotError(
      "INBOX_EMPTY",
      `Nessuna foto da adottare per session_id=${session.sessionId}`
    );
  }

  await mkdir(listing.photosDir, { recursive: true });
  const moved: string[] = [];
  for (const filename of sourceFiles.sort()) {
    const target = await uniqueTargetName(listing.photosDir, filename);
    await rename(path.join(session.photosDir, filename), path.join(listing.photosDir, target));
    moved.push(target);
  }

  await rm(session.dir, { recursive: true, force: true });

  const updated = await readdir(listing.photosDir, { withFileTypes: true });
  const totalPhotos = updated.filter((entry) => entry.isFile()).length;

  return {
    slug: listing.slug,
    listing_dir: listing.dir,
    moved_filenames: moved,
    total_photos_after: totalPhotos,
    source_session_id: session.sessionId
  };
};
