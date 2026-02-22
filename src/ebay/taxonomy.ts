import { SellbotError } from "../errors.js";
import { HttpClient } from "./http.js";

interface TaxonomyClientOptions {
  apiBaseUrl: string;
  httpClient?: HttpClient;
}

interface DefaultCategoryTreeResponse {
  categoryTreeId: string;
}

interface CategorySuggestion {
  category: {
    categoryId: string;
    categoryName?: string;
  };
}

interface CategorySuggestionsResponse {
  categorySuggestions: CategorySuggestion[];
}

export class EbayTaxonomyClient {
  private readonly httpClient: HttpClient;

  constructor(private readonly options: TaxonomyClientOptions) {
    this.httpClient = options.httpClient ?? new HttpClient();
  }

  // getDefaultCategoryTreeId (docs):
  // https://developer.ebay.com/api-docs/commerce/taxonomy/resources/category_tree/methods/getDefaultCategoryTreeId
  async getDefaultCategoryTreeId(accessToken: string, marketplaceId: string): Promise<string> {
    const params = new URLSearchParams({ marketplace_id: marketplaceId });
    const response = await this.httpClient.requestJson<DefaultCategoryTreeResponse>({
      method: "GET",
      url: `${this.options.apiBaseUrl}/commerce/taxonomy/v1/get_default_category_tree_id?${params.toString()}`,
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    return response.categoryTreeId;
  }

  // getCategorySuggestions (docs):
  // https://developer.ebay.com/api-docs/commerce/taxonomy/resources/category_tree/methods/getCategorySuggestions
  async getCategorySuggestions(
    accessToken: string,
    categoryTreeId: string,
    query: string
  ): Promise<CategorySuggestion[]> {
    const params = new URLSearchParams({ q: query });
    const response = await this.httpClient.requestJson<CategorySuggestionsResponse>({
      method: "GET",
      url: `${this.options.apiBaseUrl}/commerce/taxonomy/v1/category_tree/${encodeURIComponent(
        categoryTreeId
      )}/get_category_suggestions?${params.toString()}`,
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    return response.categorySuggestions ?? [];
  }

  async resolveCategoryId(accessToken: string, marketplaceId: string, query: string): Promise<string> {
    const normalized = query.trim();

    if (!normalized) {
      throw new SellbotError("CATEGORY_HINT_EMPTY", "category_hint vuoto: impossibile risolvere categoryId.");
    }

    const treeId = await this.getDefaultCategoryTreeId(accessToken, marketplaceId);
    const suggestions = await this.getCategorySuggestions(accessToken, treeId, normalized);

    if (suggestions.length === 0) {
      throw new SellbotError(
        "CATEGORY_NOT_FOUND",
        `Nessuna categoria suggerita per '${normalized}'. Inserire draft.category_id manualmente.`
      );
    }

    return suggestions[0].category.categoryId;
  }
}
