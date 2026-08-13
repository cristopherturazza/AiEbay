import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HttpClient } from "../src/ebay/http.js";
import { EbayMediaClient, MEDIA_UPLOAD_ATTEMPTS } from "../src/ebay/media.js";

const makeImage = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "sellbot-media-"));
  const file = path.join(dir, "foto.jpg");
  await writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return file;
};

const internalError = () =>
  new Response(
    JSON.stringify({ errors: [{ errorId: 190000, message: "There was a problem with an eBay internal system" }] }),
    { status: 500, headers: { "Content-Type": "application/json" } }
  );

const created = (id: string) =>
  new Response(JSON.stringify({ imageId: id, imageUrl: `https://i.ebayimg.com/${id}` }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

const makeClient = (responses: Array<() => Response>) => {
  let calls = 0;
  const httpClient = new HttpClient(async () => {
    const next = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return next();
  });

  return {
    client: new EbayMediaClient({
      mediaBaseUrl: "https://apim.ebay.com",
      httpClient,
      sleep: async () => {}
    }),
    calls: () => calls
  };
};

describe("EbayMediaClient.uploadImage", () => {
  it("retries the intermittent 190000 internal error and succeeds", async () => {
    const file = await makeImage();
    const { client, calls } = makeClient([internalError, internalError, () => created("abc")]);

    await expect(client.uploadImage("token", file)).resolves.toBe("https://i.ebayimg.com/abc");
    expect(calls()).toBe(3);
  });

  it("gives up after the attempt budget", async () => {
    const file = await makeImage();
    const { client, calls } = makeClient([internalError]);

    await expect(client.uploadImage("token", file)).rejects.toThrow(/500/);
    expect(calls()).toBe(MEDIA_UPLOAD_ATTEMPTS);
  });

  it("does not retry a client error", async () => {
    const file = await makeImage();
    const { client, calls } = makeClient([
      () =>
        new Response(JSON.stringify({ errors: [{ errorId: 190203, message: "Invalid image" }] }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        })
    ]);

    await expect(client.uploadImage("token", file)).rejects.toThrow(/400/);
    expect(calls()).toBe(1);
  });
});
