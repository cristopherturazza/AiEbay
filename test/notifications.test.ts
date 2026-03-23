import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeChallengeResponse,
  parseNotificationEndpointUrl,
  summarizeNotificationPayload
} from "../src/notifications/ebay-account-deletion.js";

describe("ebay account deletion notifications", () => {
  it("computes the documented sha256 challenge response", () => {
    const challengeCode = "abc123";
    const verificationToken = "token456";
    const endpointUrl = "https://example.com/ebay/notifications";

    const expected = createHash("sha256")
      .update(challengeCode)
      .update(verificationToken)
      .update(endpointUrl)
      .digest("hex");

    expect(computeChallengeResponse(challengeCode, verificationToken, endpointUrl)).toBe(expected);
  });

  it("requires an https endpoint url", () => {
    expect(() => parseNotificationEndpointUrl("http://localhost:8080/hook")).toThrow(
      /deve essere https/
    );
  });

  it("extracts only safe summary fields from payload", () => {
    expect(
      summarizeNotificationPayload({
        notificationId: "n-1",
        topic: "MARKETPLACE_ACCOUNT_DELETION",
        publishDate: "2026-03-15T00:00:00.000Z",
        data: {
          username: "seller"
        }
      })
    ).toEqual({
      notificationId: "n-1",
      topic: "MARKETPLACE_ACCOUNT_DELETION",
      publishDate: "2026-03-15T00:00:00.000Z"
    });
  });
});
