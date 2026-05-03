import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SellbotError } from "../errors.js";

export const INBOX_FOLDER_NAME = "_inbox";
export const INBOX_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
export const DEFAULT_SESSION_ID = "default";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const FILENAME_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

export const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heic"
};

const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "heic"]);

export interface InboxSessionPaths {
  sessionId: string;
  dir: string;
  photosDir: string;
}

export const getInboxRoot = (toSellRoot: string): string => path.join(toSellRoot, INBOX_FOLDER_NAME);

export const sanitizeSessionId = (raw: string | undefined): string => {
  const value = (raw ?? DEFAULT_SESSION_ID).trim();
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new SellbotError(
      "INBOX_SESSION_INVALID",
      `session_id non valido: usa 1-64 caratteri tra A-Z, a-z, 0-9, _, -`
    );
  }
  return value;
};

export const getInboxSession = (toSellRoot: string, rawSessionId: string | undefined): InboxSessionPaths => {
  const sessionId = sanitizeSessionId(rawSessionId);
  const dir = path.join(getInboxRoot(toSellRoot), sessionId);
  return {
    sessionId,
    dir,
    photosDir: path.join(dir, "photos")
  };
};

const extensionFromMime = (mime: string): string => {
  const normalized = mime.toLowerCase().trim();
  const ext = MIME_TO_EXT[normalized];
  if (!ext) {
    throw new SellbotError(
      "INBOX_PHOTO_MIME_UNSUPPORTED",
      `MIME non supportato: ${mime}. Accettati: ${Object.keys(MIME_TO_EXT).join(", ")}`
    );
  }
  return ext;
};

const sanitizeFilename = (raw: string, fallbackExt: string): string => {
  const base = path.basename(raw).trim();
  if (!FILENAME_PATTERN.test(base)) {
    throw new SellbotError(
      "INBOX_PHOTO_FILENAME_INVALID",
      `filename non valido: usa 1-120 caratteri tra A-Z, a-z, 0-9, ., _, -`
    );
  }
  const ext = path.extname(base).slice(1).toLowerCase();
  if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
    throw new SellbotError(
      "INBOX_PHOTO_EXTENSION_UNSUPPORTED",
      `Estensione non supportata: .${ext}. Accettate: ${[...ALLOWED_EXTENSIONS].join(", ")}`
    );
  }
  if (!ext) {
    return `${base}.${fallbackExt}`;
  }
  return base;
};

const decodeBase64Photo = (bytesBase64: string): Buffer => {
  let buffer: Buffer;
  try {
    buffer = Buffer.from(bytesBase64, "base64");
  } catch (error) {
    throw new SellbotError(
      "INBOX_PHOTO_BASE64_INVALID",
      `bytes_base64 non decodificabile: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (buffer.length === 0) {
    throw new SellbotError("INBOX_PHOTO_EMPTY", "bytes_base64 decodifica a 0 byte");
  }
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw new SellbotError(
      "INBOX_PHOTO_TOO_LARGE",
      `Foto troppo grande: ${buffer.length} byte > limite ${MAX_PHOTO_BYTES}`
    );
  }
  return buffer;
};

export interface SaveInboxPhotoInput {
  bytesBase64: string;
  mime: string;
  filename?: string;
}

export interface SaveInboxPhotoResult {
  photoPath: string;
  filename: string;
  bytes: number;
  totalPhotos: number;
}

const listInboxPhotoNames = async (photosDir: string): Promise<string[]> => {
  try {
    const entries = await readdir(photosDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

const generateAutoFilename = (existing: string[], ext: string): string => {
  const stamp = Date.now();
  let attempt = 0;
  while (true) {
    const candidate = attempt === 0 ? `photo-${stamp}.${ext}` : `photo-${stamp}-${attempt}.${ext}`;
    if (!existing.includes(candidate)) {
      return candidate;
    }
    attempt += 1;
  }
};

export const saveInboxPhoto = async (
  session: InboxSessionPaths,
  input: SaveInboxPhotoInput
): Promise<SaveInboxPhotoResult> => {
  const ext = extensionFromMime(input.mime);
  const buffer = decodeBase64Photo(input.bytesBase64);

  await mkdir(session.photosDir, { recursive: true });
  const existing = await listInboxPhotoNames(session.photosDir);

  const filename = input.filename ? sanitizeFilename(input.filename, ext) : generateAutoFilename(existing, ext);
  const photoPath = path.join(session.photosDir, filename);

  await writeFile(photoPath, buffer);

  const updated = existing.includes(filename) ? existing : [...existing, filename];
  return {
    photoPath,
    filename,
    bytes: buffer.length,
    totalPhotos: updated.length
  };
};

export interface PurgeResult {
  purged: string[];
}

export const purgeStaleInboxSessions = async (
  toSellRoot: string,
  ttlMs = INBOX_SESSION_TTL_MS,
  now: number = Date.now()
): Promise<PurgeResult> => {
  const root = getInboxRoot(toSellRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { purged: [] };
    }
    throw error;
  }

  const purged: string[] = [];
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const sessionDir = path.join(root, entry.name);
        try {
          const meta = await stat(sessionDir);
          if (now - meta.mtimeMs > ttlMs) {
            await rm(sessionDir, { recursive: true, force: true });
            purged.push(entry.name);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      })
  );

  return { purged };
};

const directoryExists = async (candidate: string): Promise<boolean> => {
  try {
    const meta = await stat(candidate);
    return meta.isDirectory();
  } catch {
    return false;
  }
};

export interface PromoteInboxResult {
  slug: string;
  dir: string;
}

export const promoteInboxToListing = async (
  toSellRoot: string,
  sessionId: string,
  preferredSlug: string
): Promise<PromoteInboxResult> => {
  const session = getInboxSession(toSellRoot, sessionId);
  if (!(await directoryExists(session.dir))) {
    throw new SellbotError("INBOX_SESSION_NOT_FOUND", `Inbox vuota per session_id=${sessionId}`);
  }

  let slug = preferredSlug;
  let attempt = 1;
  while (await directoryExists(path.join(toSellRoot, slug))) {
    attempt += 1;
    slug = `${preferredSlug}-${attempt}`;
  }

  const targetDir = path.join(toSellRoot, slug);
  await rename(session.dir, targetDir);
  return { slug, dir: targetDir };
};
