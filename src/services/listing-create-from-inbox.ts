import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runEnrich } from "../commands/enrich.js";
import { resolveVisionBackend, visionModelLabel, type RuntimeConfig } from "../config.js";
import { SellbotError } from "../errors.js";
import { getInboxSession, promoteInboxToListing } from "../fs/inbox.js";
import { recordRecentPromotion } from "../fs/inbox-state.js";
import { getToSellRoot, listPhotoFiles } from "../fs/listings.js";
import { logger } from "../logger.js";
import { isValidSlug, slugifyTitle } from "../utils/slug.js";
import { identifyBookFromPhoto, type BookCandidate } from "../vision/book-identification.js";
import { getListingSnapshot, type ListingSnapshot } from "./listing-snapshot.js";

export type CreateFromInboxModule = "auto" | "book" | "generic";

export interface CreateListingFromInboxOptions {
  sessionId?: string;
  module?: CreateFromInboxModule;
  hint?: string;
  titleOverride?: string;
  slugOverride?: string;
  coverFilename?: string;
}

export interface CreateListingFromInboxResult {
  slug: string;
  source_session_id: string;
  title_used: string;
  title_source: "override" | "vision" | "slug_override";
  vision: {
    cover_filename: string | null;
    candidates: BookCandidate[];
    match: string;
    elapsed_ms: number;
    model: string;
    fallback_attempts: number;
  } | null;
  snapshot: ListingSnapshot;
}

const looksLikeBookFlow = (module: CreateFromInboxModule): boolean => module === "auto" || module === "book";

const orderForCover = (photos: string[], coverFilename: string | undefined): string[] => {
  if (!coverFilename) {
    return photos;
  }
  const idx = photos.indexOf(coverFilename);
  if (idx <= 0) {
    return photos;
  }
  return [photos[idx], ...photos.slice(0, idx), ...photos.slice(idx + 1)];
};

interface VisionAttemptResult {
  cover: string;
  candidates: BookCandidate[];
  match: string;
  elapsed_ms: number;
  model: string;
  attempts: number;
}

const tryIdentify = async (
  config: RuntimeConfig,
  photosDir: string,
  ordered: string[],
  hint: string | undefined
): Promise<VisionAttemptResult | null> => {
  const backend = resolveVisionBackend(config.vision);
  let attempts = 0;
  for (const filename of ordered) {
    attempts += 1;
    const photoPath = path.join(photosDir, filename);
    const result = await identifyBookFromPhoto({
      photoPath,
      backend,
      hint
    });

    if (result.match !== "none" && result.candidates.length > 0) {
      return {
        cover: filename,
        candidates: result.candidates,
        match: result.match,
        elapsed_ms: result.elapsed_ms,
        model: result.model,
        attempts
      };
    }
  }
  return null;
};

export const createListingFromInbox = async (
  config: RuntimeConfig,
  options: CreateListingFromInboxOptions
): Promise<CreateListingFromInboxResult> => {
  const toSellRoot = getToSellRoot(config.cwd);
  const session = getInboxSession(toSellRoot, options.sessionId);
  const photos = await listPhotoFiles(session.photosDir);

  if (photos.length === 0) {
    throw new SellbotError(
      "INBOX_EMPTY",
      `Nessuna foto in inbox per session_id=${session.sessionId}: invoca prima sellbot_inbox_add_photo.`
    );
  }

  const moduleId: CreateFromInboxModule = options.module ?? "auto";

  let titleUsed: string | undefined;
  let titleSource: CreateListingFromInboxResult["title_source"] | undefined;
  let visionInfo: CreateListingFromInboxResult["vision"] = null;

  if (options.slugOverride) {
    if (!isValidSlug(options.slugOverride)) {
      throw new SellbotError(
        "SLUG_INVALID",
        `slug_override non valido: usa lowercase a-z, 0-9, trattini (1-60 char, no inizio/fine con trattino)`
      );
    }
    titleUsed = options.titleOverride?.trim() || options.slugOverride;
    titleSource = "slug_override";
  } else if (options.titleOverride && options.titleOverride.trim().length > 0) {
    titleUsed = options.titleOverride.trim();
    titleSource = "override";
  } else if (looksLikeBookFlow(moduleId)) {
    const ordered = orderForCover(photos, options.coverFilename);
    const attempt = await tryIdentify(config, session.photosDir, ordered, options.hint);
    if (attempt && attempt.candidates[0]?.title) {
      const top = attempt.candidates[0];
      const author = top.author ? ` ${top.author}` : "";
      titleUsed = `${top.title}${author}`.trim();
      titleSource = "vision";
      visionInfo = {
        cover_filename: attempt.cover,
        candidates: attempt.candidates,
        match: attempt.match,
        elapsed_ms: attempt.elapsed_ms,
        model: attempt.model,
        fallback_attempts: attempt.attempts
      };
    } else {
      visionInfo = {
        cover_filename: null,
        candidates: [],
        match: "none",
        elapsed_ms: 0,
        model: visionModelLabel(config.vision),
        fallback_attempts: ordered.length
      };
    }
  }

  if (!titleUsed) {
    throw new SellbotError(
      "TITLE_REQUIRED",
      "Impossibile dedurre il titolo dalle foto: passa title_override o slug_override.",
      { vision: visionInfo, photos }
    );
  }

  const preferredSlug = options.slugOverride ?? slugifyTitle(titleUsed);
  const promoted = await promoteInboxToListing(toSellRoot, session.sessionId, preferredSlug);

  logger.info(
    `[inbox] session=${session.sessionId} promosso a slug=${promoted.slug} (titolo="${titleUsed}", source=${titleSource})`
  );

  if (visionInfo && visionInfo.candidates[0]) {
    const top = visionInfo.candidates[0];
    const lines: string[] = [];
    if (top.title) {
      lines.push(`Titolo: ${top.title}`);
    }
    if (top.author) {
      lines.push(`Autore: ${top.author}`);
    }
    if (top.isbn) {
      lines.push(`ISBN: ${top.isbn}`);
    }
    if (lines.length > 0) {
      await writeFile(path.join(promoted.dir, "notes.txt"), `${lines.join("\n")}\n`, { flag: "wx" }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") {
            throw error;
          }
        }
      );
    }
  }

  await runEnrich(promoted.slug, { module: moduleId });
  const snapshot = await getListingSnapshot(config, promoted.slug);

  await recordRecentPromotion(toSellRoot, session.sessionId, {
    slug: promoted.slug,
    title: titleUsed,
    promoted_at: new Date().toISOString()
  });

  return {
    slug: promoted.slug,
    source_session_id: session.sessionId,
    title_used: titleUsed,
    title_source: titleSource ?? "override",
    vision: visionInfo,
    snapshot
  };
};
