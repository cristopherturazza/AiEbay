import { loadRuntimeConfig } from "../config.js";
import { createAppOAuthClient } from "../ebay/oauth-client-factory.js";
import { EbayMetadataClient } from "../ebay/metadata.js";
import { SellbotError } from "../errors.js";
import { logger } from "../logger.js";
import { filterShippingServices, summarizeShippingService } from "../shipping/services.js";
import { toRestMarketplaceId } from "../utils/marketplace.js";

interface ShippingServicesOptions {
  marketplace?: string;
  carrier?: string;
  service?: string;
  category?: string;
  domestic?: boolean;
  international?: boolean;
  all?: boolean;
  json?: boolean;
  acceptLanguage?: string;
  limit?: string;
}

const parseLimit = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SellbotError("SHIPPING_LIMIT_INVALID", `--limit non valido: ${value}`);
  }

  return parsed;
};

export const runShippingServices = async (options: ShippingServicesOptions): Promise<void> => {
  if (options.domestic && options.international) {
    throw new SellbotError(
      "SHIPPING_FILTER_INVALID",
      "Usa solo uno tra --domestic e --international"
    );
  }

  const config = await loadRuntimeConfig();
  const oauthClient = createAppOAuthClient(config);
  const appToken = await oauthClient.createApplicationToken();
  const metadataClient = new EbayMetadataClient({ apiBaseUrl: config.ebayApiBaseUrl });
  const marketplaceId = toRestMarketplaceId(options.marketplace ?? config.ebayMarketplaceId);
  const limit = parseLimit(options.limit);

  const services = await metadataClient.getShippingServices(appToken.access_token, marketplaceId, {
    acceptLanguage: options.acceptLanguage
  });
  const filtered = filterShippingServices(services, {
    carrier: options.carrier,
    service: options.service,
    category: options.category,
    domestic: options.domestic,
    international: options.international,
    sellingFlowOnly: !(options.all ?? false),
    limit
  });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          marketplaceId,
          total: filtered.length,
          filters: {
            carrier: options.carrier,
            service: options.service,
            category: options.category,
            domestic: options.domestic ?? false,
            international: options.international ?? false,
            sellingFlowOnly: !(options.all ?? false),
            limit: limit ?? null
          },
          services: filtered
        },
        null,
        2
      )}\n`
    );
    return;
  }

  logger.info(
    `Shipping services marketplace=${marketplaceId} count=${filtered.length} sellingFlowOnly=${!(options.all ?? false)}`
  );

  if (filtered.length === 0) {
    logger.warn("Nessun servizio trovato con i filtri richiesti");
    return;
  }

  for (const service of filtered) {
    logger.info(`- ${summarizeShippingService(service)}`);
  }
};
