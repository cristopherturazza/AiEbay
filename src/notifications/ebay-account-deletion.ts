import { createHash } from "node:crypto";
import { URL } from "node:url";
import { SellbotError } from "../errors.js";

export interface NotificationSummary {
  notificationId?: string;
  topic?: string;
  publishDate?: string;
}

export const parseNotificationEndpointUrl = (value: string): URL => {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch (error) {
    throw new SellbotError(
      "NOTIFICATION_ENDPOINT_INVALID",
      `SELLBOT_NOTIFICATION_ENDPOINT_URL non valido: ${(error as Error).message}`
    );
  }

  if (parsed.protocol !== "https:") {
    throw new SellbotError(
      "NOTIFICATION_ENDPOINT_INVALID",
      "SELLBOT_NOTIFICATION_ENDPOINT_URL deve essere https"
    );
  }

  return parsed;
};

// eBay Marketplace Account Deletion notification challenge response (docs):
// https://developer.ebay.com/develop/guides-v2/marketplace-user-account-deletion/notification-endpoint-validation
export const computeChallengeResponse = (
  challengeCode: string,
  verificationToken: string,
  endpointUrl: string
): string => {
  return createHash("sha256")
    .update(challengeCode)
    .update(verificationToken)
    .update(endpointUrl)
    .digest("hex");
};

export const summarizeNotificationPayload = (payload: unknown): NotificationSummary => {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const record = payload as Record<string, unknown>;
  return {
    notificationId:
      typeof record.notificationId === "string" ? record.notificationId : undefined,
    topic: typeof record.topic === "string" ? record.topic : undefined,
    publishDate:
      typeof record.publishDate === "string" ? record.publishDate : undefined
  };
};
