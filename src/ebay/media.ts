import { basename, extname } from "node:path";
import { readFile } from "node:fs/promises";
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
  ".png": "image/png"
};

export class EbayMediaClient {
  private readonly httpClient: HttpClient;

  constructor(private readonly options: MediaClientOptions) {
    this.httpClient = options.httpClient ?? new HttpClient();
  }

  // Media API createImageFromFile (docs):
  // https://developer.ebay.com/api-docs/commerce/media/resources/image/methods/createImageFromFile
  async uploadImage(accessToken: string, filePath: string): Promise<string> {
    const extension = extname(filePath).toLowerCase();
    const mimeType = mimeByExtension[extension];

    if (!mimeType) {
      throw new SellbotError("IMAGE_FORMAT_UNSUPPORTED", `Formato immagine non supportato: ${filePath}`);
    }

    const fileBuffer = await readFile(filePath);
    const blob = new Blob([fileBuffer], { type: mimeType });
    const form = new FormData();
    form.append("image", blob, basename(filePath));

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
  }
}
