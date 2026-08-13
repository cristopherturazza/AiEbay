import { loadRuntimeConfig } from "../config.js";
import { logger } from "../logger.js";
import { importRemoteListings } from "../services/listings-import-remote.js";

interface ListingsImportRemoteOptions {
  dryRun?: boolean;
  activeOnly?: boolean;
  photos?: boolean;
  redownloadPhotos?: boolean;
  limit?: string;
  json?: boolean;
}

export const runListingsImportRemote = async (options: ListingsImportRemoteOptions): Promise<void> => {
  const config = await loadRuntimeConfig();
  const result = await importRemoteListings(config, {
    dryRun: options.dryRun,
    activeOnly: options.activeOnly,
    downloadPhotos: options.photos,
    redownloadPhotos: options.redownloadPhotos,
    limit: options.limit ? Number.parseInt(options.limit, 10) : undefined
  });

  if (options.json) {
    logger.info(JSON.stringify(result, null, 2));
    return;
  }

  const prefix = result.dry_run ? "[dry-run] " : "";
  logger.info(`${prefix}Listing remote esaminate: ${result.remote_total}`);

  for (const entry of result.imported) {
    logger.info(
      `${prefix}+ ${entry.slug} (${entry.listing_status ?? "n/d"}) — ${entry.photos_downloaded} foto` +
        (entry.photos_failed > 0 ? `, ${entry.photos_failed} fallite` : "")
    );
  }

  for (const entry of result.refreshed) {
    const changes = entry.changes.length > 0 ? entry.changes.join("; ") : "nessuna modifica";
    logger.info(`${prefix}~ ${entry.slug} — ${changes}`);
  }

  for (const entry of result.skipped) {
    logger.warn(`${prefix}- ${entry.slug ?? entry.sku}: ${entry.detail}`);
  }

  for (const entry of result.duplicates) {
    logger.warn(`${prefix}! ${entry.detail}`);
  }

  logger.info(
    `${prefix}Ricostruite ${result.imported.length}, aggiornate ${result.refreshed.length}, saltate ${result.skipped.length}.`
  );
};
