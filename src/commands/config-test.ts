import { SellbotError } from "../errors.js";
import { logger } from "../logger.js";
import { loadRuntimeConfig } from "../config.js";
import { type ConfigCheckResult, runConfigChecks } from "../services/config-check.js";

const printCheck = (check: ConfigCheckResult): void => {
  const symbol = check.ok ? "OK" : "KO";
  if (check.detail) {
    logger.info(`[${symbol}] ${check.name} - ${check.detail}`);
    return;
  }

  logger.info(`[${symbol}] ${check.name}`);
};

export const runConfigTest = async (): Promise<void> => {
  const config = await loadRuntimeConfig();
  const checks = await runConfigChecks(config);

  logger.info("Checklist config:test");
  for (const check of checks) {
    printCheck(check);
  }

  if (checks.some((check) => !check.ok)) {
    throw new SellbotError("CONFIG_TEST_FAILED", "Una o più verifiche config:test sono KO");
  }
};
