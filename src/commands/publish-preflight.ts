import { loadRuntimeConfig } from "../config.js";
import { SellbotError } from "../errors.js";
import { logger } from "../logger.js";
import { type PublishPreflightCheckResult, runPublishPreflightChecks } from "../services/publish-preflight.js";

const printCheck = (check: PublishPreflightCheckResult): void => {
  logger.info(`[${check.level}] ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
};

export const runPublishPreflight = async (folder: string): Promise<void> => {
  const config = await loadRuntimeConfig();
  const result = await runPublishPreflightChecks(folder, config);

  logger.info(`Preflight publish per '${result.listing.slug}'`);
  result.checks.forEach(printCheck);

  if (result.checks.some((check) => check.level === "KO")) {
    throw new SellbotError("PUBLISH_PREFLIGHT_FAILED", "Preflight fallito: presenti check KO");
  }
};
