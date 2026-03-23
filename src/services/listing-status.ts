import { writeStatus } from "../fs/listings.js";
import type { Status } from "../types.js";
import { toStatusError } from "../utils/status-error.js";

export const hasPublishedListing = (status: Status): boolean => {
  return status.state === "published" || Boolean(status.ebay.listing_id);
};

export const persistListingFailure = async (
  statusPath: string,
  status: Status,
  previouslyPublished: boolean,
  error: unknown
): Promise<void> => {
  status.state = previouslyPublished ? "published" : "error";
  status.last_error = toStatusError(error);
  await writeStatus(statusPath, status);
};
