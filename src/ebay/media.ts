import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { basename, extname } from "node:path";
import { promisify } from "node:util";
import { SellbotError } from "../errors.js";
import { EbayApiError, HttpClient } from "./http.js";

interface MediaClientOptions {
  mediaBaseUrl: string;
  httpClient?: HttpClient;
  /** Iniettabile nei test per non dormire davvero. */
  sleep?: (ms: number) => Promise<void>;
}

// createImageFromFile sbaglia a intermittenza con 500/190000 ("eBay internal
// system or process"): lo stesso file fallisce e un istante dopo passa. Senza
// retry basta un singolo buco per far abortire un publish da 6 foto.
export const MEDIA_UPLOAD_ATTEMPTS = 4;
const MEDIA_RETRY_BASE_MS = 500;

const isRetryableMediaError = (error: unknown): boolean =>
  error instanceof EbayApiError && (error.status >= 500 || error.status === 429);

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface CreateImageResponse {
  imageId?: string;
  imageUrl?: string;
}

const mimeByExtension: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".heic": "image/heic"
};

const execFileAsync = promisify(execFile);

interface PreparedUploadImage {
  filePath: string;
  fileName: string;
  mimeType: string;
  cleanup: () => Promise<void>;
}

const prepareImageForUpload = async (filePath: string): Promise<PreparedUploadImage> => {
  const extension = extname(filePath).toLowerCase();
  const mimeType = mimeByExtension[extension];

  if (!mimeType) {
    throw new SellbotError("IMAGE_FORMAT_UNSUPPORTED", `Formato immagine non supportato: ${filePath}`);
  }

  // eBay docs list HEIC as supported, but sandbox rejected real iPhone HEIC files
  // with error 190203 during end-to-end tests on macOS. Convert to JPEG first.
  // https://developer.ebay.com/api-docs/commerce/media/resources/image/methods/createImageFromFile
  if (extension !== ".heic" || process.platform !== "darwin") {
    return {
      filePath,
      fileName: basename(filePath),
      mimeType,
      cleanup: async () => {}
    };
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "sellbot-heic-"));
  const convertedPath = path.join(tempDir, `${basename(filePath, extension)}.jpg`);

  try {
    await execFileAsync("sips", ["-s", "format", "jpeg", filePath, "--out", convertedPath]);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw new SellbotError(
      "IMAGE_CONVERSION_FAILED",
      `Conversione HEIC->JPEG fallita per ${filePath}: ${(error as Error).message}`
    );
  }

  return {
    filePath: convertedPath,
    fileName: basename(convertedPath),
    mimeType: "image/jpeg",
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
};

export class EbayMediaClient {
  private readonly httpClient: HttpClient;

  constructor(private readonly options: MediaClientOptions) {
    this.httpClient = options.httpClient ?? new HttpClient();
  }

  // Media API createImageFromFile (docs):
  // https://developer.ebay.com/api-docs/commerce/media/resources/image/methods/createImageFromFile
  async uploadImage(accessToken: string, filePath: string): Promise<string> {
    const prepared = await prepareImageForUpload(filePath);
    const sleep = this.options.sleep ?? defaultSleep;

    try {
      const fileBuffer = await readFile(prepared.filePath);
      let lastError: unknown;

      for (let attempt = 1; attempt <= MEDIA_UPLOAD_ATTEMPTS; attempt += 1) {
        // Blob e FormData vanno ricostruiti a ogni tentativo: il body di una
        // fetch e' consumabile una volta sola.
        const form = new FormData();
        form.append("image", new Blob([fileBuffer], { type: prepared.mimeType }), prepared.fileName);

        try {
          const response = await this.httpClient.requestJson<CreateImageResponse>({
            method: "POST",
            url: `${this.options.mediaBaseUrl}/commerce/media/v1_beta/image/create_image_from_file`,
            headers: {
              Authorization: `Bearer ${accessToken}`
            },
            body: form
          });

          if (!response?.imageUrl) {
            throw new SellbotError("MEDIA_RESPONSE_INVALID", "Risposta createImageFromFile priva di imageUrl");
          }

          return response.imageUrl;
        } catch (error) {
          lastError = error;

          if (attempt === MEDIA_UPLOAD_ATTEMPTS || !isRetryableMediaError(error)) {
            throw error;
          }

          await sleep(MEDIA_RETRY_BASE_MS * 2 ** (attempt - 1));
        }
      }

      throw lastError;
    } finally {
      await prepared.cleanup();
    }
  }
}
