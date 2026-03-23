import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { basename, extname } from "node:path";
import { promisify } from "node:util";
import { SellbotError } from "../errors.js";
import { HttpClient } from "./http.js";

interface MediaClientOptions {
  mediaBaseUrl: string;
  httpClient?: HttpClient;
}

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

    try {
      const fileBuffer = await readFile(prepared.filePath);
      const blob = new Blob([fileBuffer], { type: prepared.mimeType });
      const form = new FormData();
      form.append("image", blob, prepared.fileName);

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
    } finally {
      await prepared.cleanup();
    }
  }
}
