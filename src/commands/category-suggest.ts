import { loadRuntimeConfig } from "../config.js";
import { createAppOAuthClient } from "../ebay/oauth-client-factory.js";
import { EbayTaxonomyClient } from "../ebay/taxonomy.js";
import { SellbotError } from "../errors.js";
import { getToSellRoot, readDraft, resolveListing, writeDraft } from "../fs/listings.js";
import { logger } from "../logger.js";
import { toRestMarketplaceId } from "../utils/marketplace.js";

interface CategorySuggestOptions {
  top?: string;
  query?: string;
  pick?: string;
}

export const runCategorySuggest = async (
  folder: string,
  options: CategorySuggestOptions
): Promise<void> => {
  const config = await loadRuntimeConfig();
  const listing = await resolveListing(getToSellRoot(config.cwd), folder);
  const draft = await readDraft(listing.draftPath);

  if (!draft) {
    throw new SellbotError("DRAFT_MISSING", `draft.json mancante in ${listing.dir}`);
  }

  const query = options.query?.trim() || draft.category_hint;
  if (!query.trim()) {
    throw new SellbotError(
      "CATEGORY_HINT_EMPTY",
      "Query categoria vuota: specifica --query oppure valorizza draft.category_hint"
    );
  }

  const top = Math.max(1, Number.parseInt(options.top ?? "5", 10) || 5);

  if (config.ebayEnv === "sandbox") {
    logger.warn(
      "Sandbox: getCategorySuggestions e' documentato da eBay come non pienamente supportato. Usa il risultato come suggerimento, non come verita'."
    );
  }

  const oauthClient = createAppOAuthClient(config);
  const accessToken = await oauthClient.createApplicationToken();
  const taxonomyClient = new EbayTaxonomyClient({ apiBaseUrl: config.ebayApiBaseUrl });
  const marketplaceId = toRestMarketplaceId(config.ebayMarketplaceId);
  const treeId = await taxonomyClient.getDefaultCategoryTreeId(accessToken.access_token, marketplaceId);
  const suggestions = await taxonomyClient.getCategorySuggestions(accessToken.access_token, treeId, query);

  if (suggestions.length === 0) {
    logger.warn(`Nessuna categoria suggerita per query='${query}'`);
    return;
  }

  const visibleSuggestions = suggestions.slice(0, top);

  logger.info(`Suggerimenti categoria per '${listing.slug}' con query='${query}'`);
  visibleSuggestions.forEach((suggestion, index) => {
    const ancestors = (suggestion.categoryTreeNodeAncestors ?? [])
      .map((entry) => entry.categoryName)
      .filter(Boolean)
      .join(" > ");
    logger.info(
      `${index + 1}. ${suggestion.category.categoryId} - ${suggestion.category.categoryName ?? "(senza nome)"}${
        ancestors ? ` [${ancestors}]` : ""
      }`
    );
  });

  const rawPick = options.pick?.trim();
  if (!rawPick) {
    return;
  }

  const pick = Number.parseInt(rawPick, 10);
  if (!Number.isFinite(pick) || pick < 1 || pick > visibleSuggestions.length) {
    throw new SellbotError(
      "CATEGORY_PICK_INVALID",
      `--pick deve essere compreso tra 1 e ${visibleSuggestions.length} (top visibile)`
    );
  }

  draft.category_id = visibleSuggestions[pick - 1]?.category.categoryId;
  await writeDraft(listing.draftPath, draft);
  logger.info(`[${listing.slug}] draft.category_id aggiornato a ${draft.category_id}`);
};
