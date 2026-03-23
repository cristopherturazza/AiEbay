import { loadRuntimeConfig } from "../config.js";
import { getToSellRoot, resolveListing, writeIntakeReport } from "../fs/listings.js";
import { buildListingIntakeReport } from "../intake/index.js";
import { logger } from "../logger.js";
import type { EnrichmentModuleId } from "../enrichment/modules.js";

interface IntakeCheckOptions {
  json?: boolean;
  save?: boolean;
  module?: EnrichmentModuleId;
}

const printList = (title: string, items: string[]): void => {
  if (items.length === 0) {
    logger.info(`${title}: nessuno`);
    return;
  }

  logger.info(`${title}: ${items.join(", ")}`);
};

export const runIntakeCheck = async (folder: string, options: IntakeCheckOptions): Promise<void> => {
  const config = await loadRuntimeConfig();
  const listing = await resolveListing(getToSellRoot(config.cwd), folder);
  const result = await buildListingIntakeReport(listing, {
    moduleId: options.module ?? "auto"
  });

  if (options.save ?? true) {
    await writeIntakeReport(listing.intakePath, result.report);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    return;
  }

  logger.info(`Intake report per '${listing.slug}' (profile=${result.moduleId})`);
  logger.info(`Completeness: ${result.report.summary.completeness}`);
  printList("Search first", result.report.summary.search_first);
  printList("Ask user", result.report.summary.ask_user);
  printList("Publish blockers", result.report.summary.publish_blockers);

  for (const field of result.report.fields) {
    logger.info(
      `- ${field.label}: ${field.status}${
        field.value ? ` (${field.value})` : ""
      } [${field.importance}] primary=${field.acquisition.primary}${
        field.acquisition.fallback ? ` fallback=${field.acquisition.fallback}` : ""
      }`
    );
  }

  const pricing = result.report.pricing;
  logger.info(
    `Pricing strategy: nuovo - ${pricing.discount_percent}% (bucket=${pricing.condition_bucket})`
  );
  if (pricing.ready) {
    logger.info(
      `Suggested price: target=${pricing.suggested_target?.toFixed(2)} ${pricing.currency}, quick_sale=${pricing.suggested_quick_sale?.toFixed(2)}, floor=${pricing.suggested_floor?.toFixed(2)}`
    );
  } else {
    logger.info(`Suggested price unavailable: ${pricing.note}`);
  }
};
