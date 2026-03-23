import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyStatus, readStatus } from "../src/fs/listings.js";
import { hasPublishedListing, persistListingFailure } from "../src/services/listing-status.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.map((dir) => rm(dir, { recursive: true, force: true })));
  temporaryRoots.length = 0;
});

describe("listing status helpers", () => {
  it("detects published listings using state or listing id", () => {
    const draftStatus = emptyStatus();
    const publishedByState = { ...emptyStatus(), state: "published" as const };
    const publishedByListingId = { ...emptyStatus(), ebay: { ...emptyStatus().ebay, listing_id: "123" } };

    expect(hasPublishedListing(draftStatus)).toBe(false);
    expect(hasPublishedListing(publishedByState)).toBe(true);
    expect(hasPublishedListing(publishedByListingId)).toBe(true);
  });

  it("persists error state while preserving published state when requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-status-test-"));
    temporaryRoots.push(root);

    const statusPath = path.join(root, "status.json");
    const status = emptyStatus();

    await persistListingFailure(statusPath, status, false, new Error("boom"));
    const savedAsError = await readStatus(statusPath);
    expect(savedAsError.state).toBe("error");
    expect(savedAsError.last_error?.message).toContain("boom");

    await persistListingFailure(statusPath, status, true, new Error("again"));
    const savedAsPublished = await readStatus(statusPath);
    expect(savedAsPublished.state).toBe("published");
    expect(savedAsPublished.last_error?.message).toContain("again");
  });
});
