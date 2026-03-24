#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadRuntimeConfig } from "../config.js";
import { runBuild } from "../commands/build.js";
import { runEnrich } from "../commands/enrich.js";
import { runPublish } from "../commands/publish.js";
import { runRevise } from "../commands/revise.js";
import { runScan } from "../commands/scan.js";
import { createAppOAuthClient } from "../ebay/oauth-client-factory.js";
import { EbayMetadataClient } from "../ebay/metadata.js";
import { EbayTaxonomyClient } from "../ebay/taxonomy.js";
import { isSellbotError } from "../errors.js";
import { getToSellRoot, resolveListing, writeDraft, writeIntakeReport } from "../fs/listings.js";
import { buildListingIntakeReport } from "../intake/index.js";
import { logger } from "../logger.js";
import { completeUserAuth, getUserAuthStatus, startUserAuth } from "../services/auth-flow.js";
import { runConfigChecks } from "../services/config-check.js";
import { patchListingDraft } from "../services/draft-patch.js";
import { getListingSnapshot, listListingsSummary } from "../services/listing-snapshot.js";
import { listRemoteListings } from "../services/remote-listings.js";
import { runPublishPreflightChecks } from "../services/publish-preflight.js";
import { filterShippingServices, summarizeShippingService } from "../shipping/services.js";
import { toRestMarketplaceId } from "../utils/marketplace.js";

const resultSchema = z.object({
  ok: z.literal(true),
  message: z.string().optional(),
  data: z.any().optional()
});

const asText = (value: unknown): string => JSON.stringify(value, null, 2);

const okResult = (data: unknown, message?: string) => ({
  content: [
    {
      type: "text" as const,
      text: asText({ ok: true, message, data })
    }
  ],
  structuredContent: {
    ok: true as const,
    message,
    data
  }
});

const errorResult = (error: unknown) => {
  const payload = isSellbotError(error)
    ? {
        ok: false,
        code: error.code,
        message: error.message,
        details: error.details
      }
    : error instanceof Error
      ? {
          ok: false,
          code: "UNHANDLED_ERROR",
          message: error.message
        }
      : {
          ok: false,
          code: "UNHANDLED_ERROR",
          message: String(error)
        };

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: asText(payload)
      }
    ]
  };
};

const withTool = async (operation: () => Promise<ReturnType<typeof okResult>>) => {
  try {
    return await operation();
  } catch (error) {
    return errorResult(error);
  }
};

export const createSellbotMcpServer = (): McpServer => {
  const server = new McpServer({
    name: "sellbot-mcp",
    version: "0.1.0"
  });

  server.registerTool(
    "sellbot_auth_status",
    {
      title: "Auth Status",
      description: "Restituisce stato del token utente eBay e di una eventuale sessione OAuth pendente.",
      outputSchema: resultSchema
    },
    async () =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        return okResult(await getUserAuthStatus(config), "Stato autenticazione letto");
      })
  );

  server.registerTool(
    "sellbot_auth_start",
    {
      title: "Auth Start",
      description:
        "Avvia il flusso OAuth eBay salvando una sessione pendente e restituendo il consent URL da aprire nel browser.",
      outputSchema: resultSchema
    },
    async () =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        const result = await startUserAuth(config);
        return okResult(
          result,
          result.callbackMode === "automatic_http"
            ? "Apri consentUrl e poi monitora sellbot_auth_status: il callback HTTP salvera' il token automaticamente"
            : "Apri consentUrl e poi chiama sellbot_auth_complete con redirect_url o code"
        );
      })
  );

  server.registerTool(
    "sellbot_auth_complete",
    {
      title: "Auth Complete",
      description:
        "Completa il flusso OAuth usando l'URL finale di redirect eBay oppure il solo parametro code.",
      inputSchema: {
        redirect_url: z.string().optional().describe("URL finale di redirect copiato dal browser"),
        code: z.string().optional().describe("Solo il parametro code, se gia' estratto")
      },
      outputSchema: resultSchema
    },
    async ({ redirect_url, code }) =>
      withTool(async () => {
        const raw = redirect_url?.trim() || code?.trim();
        if (!raw) {
          throw new Error("Serve redirect_url oppure code");
        }

        const config = await loadRuntimeConfig();
        return okResult(await completeUserAuth(config, raw), "Token eBay salvato");
      })
  );

  server.registerTool(
    "sellbot_config_test",
    {
      title: "Config Test",
      description: "Esegue controlli read-only su token, policy e merchant location.",
      outputSchema: resultSchema
    },
    async () =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        const checks = await runConfigChecks(config);
        return okResult(
          {
            all_ok: checks.every((check) => check.ok),
            checks
          },
          "Checklist config completata"
        );
      })
  );

  server.registerTool(
    "sellbot_listings_list",
    {
      title: "List Listings",
      description: "Elenca le cartelle in ToSell con stato, foto e artefatti disponibili.",
      inputSchema: {
        scope: z.enum(["all", "current_env"]).optional().describe("Di default mostra solo listing compatibili con l'env attivo"),
        state: z.string().optional().describe("Filtra per stato locale, es. draft|ready|published|error"),
        published_only: z.boolean().optional().describe("Mostra solo listing pubblicate")
      },
      outputSchema: resultSchema
    },
    async ({ scope, state, published_only }) =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        const listings = await listListingsSummary(config, {
          scope: scope ?? "current_env",
          state,
          publishedOnly: published_only ?? false
        });
        return okResult(
          {
            current_env: config.ebayEnv,
            total: listings.length,
            filters: {
              scope: scope ?? "current_env",
              state: state ?? null,
              published_only: published_only ?? false
            },
            listings
          },
          "Elenco listing letto"
        );
      })
  );

  server.registerTool(
    "sellbot_listing_get",
    {
      title: "Get Listing",
      description: "Restituisce snapshot completa di una listing locale.",
      inputSchema: {
        folder: z.string().min(1)
      },
      outputSchema: resultSchema
    },
    async ({ folder }) =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        return okResult(await getListingSnapshot(config, folder), "Snapshot listing letta");
      })
  );

  server.registerTool(
    "sellbot_remote_listings_list",
    {
      title: "List Remote Listings",
      description:
        "Interroga eBay sull'env attivo e restituisce le listing remote note a Inventory API (attive di default).",
      inputSchema: {
        active_only: z
          .boolean()
          .optional()
          .describe("Di default true: filtra solo listing PUBLISHED con listingStatus=ACTIVE"),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Numero massimo di listing remote da restituire (default 100)")
      },
      outputSchema: resultSchema
    },
    async ({ active_only, limit }) =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        return okResult(
          await listRemoteListings(config, {
            activeOnly: active_only,
            limit
          }),
          "Elenco listing remote letto da eBay"
        );
      })
  );

  server.registerTool(
    "sellbot_scan",
    {
      title: "Scan",
      description: "Scansiona ToSell e crea/aggiorna draft/status senza pubblicare.",
      outputSchema: resultSchema
    },
    async () =>
      withTool(async () => {
        await runScan();
        const config = await loadRuntimeConfig();
        const listings = await listListingsSummary(config);
        return okResult({ total: listings.length, listings }, "Scan completata");
      })
  );

  server.registerTool(
    "sellbot_listing_enrich",
    {
      title: "Enrich Listing",
      description: "Genera enrichment.json e, se necessario, draft.json usando un modulo dedicato.",
      inputSchema: {
        folder: z.string().min(1),
        module: z.enum(["auto", "generic", "book"]).optional(),
        force: z.boolean().optional()
      },
      outputSchema: resultSchema
    },
    async ({ folder, module, force }) =>
      withTool(async () => {
        await runEnrich(folder, { module, force });
        const config = await loadRuntimeConfig();
        return okResult(await getListingSnapshot(config, folder), "Enrichment completato");
      })
  );

  server.registerTool(
    "sellbot_listing_patch_draft",
    {
      title: "Patch Draft",
      description: "Applica una patch strutturata e validata a draft.json.",
      inputSchema: {
        folder: z.string().min(1),
        title: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        condition: z.string().min(1).optional(),
        shipping_profile: z.string().min(1).optional(),
        clear_shipping_profile: z.boolean().optional(),
        category_hint: z.string().min(1).optional(),
        category_id: z.string().regex(/^[0-9]+$/).optional(),
        clear_category_id: z.boolean().optional(),
        price: z
          .object({
            target: z.number().positive().optional(),
            quick_sale: z.number().positive().optional(),
            floor: z.number().positive().optional(),
            currency: z.string().regex(/^[A-Z]{3}$/).optional()
          })
          .optional(),
        recalculate_price_ladder: z.boolean().optional(),
        shipping: z
          .object({
            weight_g: z.number().positive().max(30000).optional(),
            thickness_cm: z.number().positive().max(100).optional(),
            pages: z.number().int().positive().max(10000).optional(),
            binding: z.enum(["paperback", "hardcover"]).optional()
          })
          .optional(),
        clear_shipping: z.boolean().optional(),
        item_specifics_set: z.record(z.string(), z.string()).optional(),
        item_specifics_remove: z.array(z.string().min(1)).max(100).optional()
      },
      outputSchema: resultSchema
    },
    async ({
      folder,
      title,
      description,
      condition,
      shipping_profile,
      clear_shipping_profile,
      category_hint,
      category_id,
      clear_category_id,
      price,
      recalculate_price_ladder,
      shipping,
      clear_shipping,
      item_specifics_set,
      item_specifics_remove
    }) =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        await patchListingDraft(
          folder,
          {
            title,
            description,
            condition,
            shippingProfile: shipping_profile,
            clearShippingProfile: clear_shipping_profile,
            categoryHint: category_hint,
            categoryId: category_id,
            clearCategoryId: clear_category_id,
            price,
            recalculatePriceLadder: recalculate_price_ladder,
            shipping,
            clearShipping: clear_shipping,
            itemSpecificsSet: item_specifics_set,
            itemSpecificsRemove: item_specifics_remove
          },
          config
        );

        return okResult(await getListingSnapshot(config, folder), "draft.json aggiornato");
      })
  );

  server.registerTool(
    "sellbot_listing_intake_check",
    {
      title: "Intake Check",
      description: "Costruisce il report intake search-first/ask-user con suggerimento prezzo.",
      inputSchema: {
        folder: z.string().min(1),
        module: z.enum(["auto", "generic", "book"]).optional(),
        save: z.boolean().optional()
      },
      outputSchema: resultSchema
    },
    async ({ folder, module, save }) =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        const listing = await resolveListing(getToSellRoot(config.cwd), folder);
        const result = await buildListingIntakeReport(listing, {
          moduleId: module ?? "auto"
        });

        if (save ?? true) {
          await writeIntakeReport(listing.intakePath, result.report);
        }

        return okResult(result, "Intake report generato");
      })
  );

  server.registerTool(
    "sellbot_listing_build",
    {
      title: "Build Listing",
      description: "Valida draft.json e genera ebay.json per una listing.",
      inputSchema: {
        folder: z.string().min(1)
      },
      outputSchema: resultSchema
    },
    async ({ folder }) =>
      withTool(async () => {
        await runBuild(folder);
        const config = await loadRuntimeConfig();
        return okResult(await getListingSnapshot(config, folder), "ebay.json generato");
      })
  );

  server.registerTool(
    "sellbot_listing_prepare_for_publish",
    {
      title: "Prepare Listing For Publish",
      description:
        "Workflow alto livello per agenti: enrich, intake, build e preflight in un solo passo.",
      inputSchema: {
        folder: z.string().min(1),
        module: z.enum(["auto", "generic", "book"]).optional(),
        force_enrich: z.boolean().optional(),
        save_intake: z.boolean().optional()
      },
      outputSchema: resultSchema
    },
    async ({ folder, module, force_enrich, save_intake }) =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        const listing = await resolveListing(getToSellRoot(config.cwd), folder);

        await runEnrich(folder, { module, force: force_enrich });

        const intake = await buildListingIntakeReport(listing, {
          moduleId: module ?? "auto"
        });

        if (save_intake ?? true) {
          await writeIntakeReport(listing.intakePath, intake.report);
        }

        await runBuild(folder);
        const preflight = await runPublishPreflightChecks(folder, config);
        const snapshot = await getListingSnapshot(config, folder);

        const readyToPublish =
          intake.report.summary.publish_blockers.length === 0 &&
          preflight.checks.every((check) => check.level !== "KO");

        return okResult(
          {
            ready_to_publish: readyToPublish,
            next_step: readyToPublish ? "publish" : "resolve_missing_data_or_preflight_issues",
            intake: intake.report,
            preflight: {
              all_ok: preflight.checks.every((check) => check.level !== "KO"),
              checks: preflight.checks
            },
            snapshot
          },
          "Workflow prepare_for_publish completato"
        );
      })
  );

  server.registerTool(
    "sellbot_listing_preflight",
    {
      title: "Publish Preflight",
      description: "Esegue i check pre-publish su categoria, condition policy, aspects e config.",
      inputSchema: {
        folder: z.string().min(1)
      },
      outputSchema: resultSchema
    },
    async ({ folder }) =>
      withTool(async () => {
        const result = await runPublishPreflightChecks(folder);
        return okResult(
          {
            all_ok: result.checks.every((check) => check.level !== "KO"),
            listing: result.listing.slug,
            ebay_build: result.ebayBuild,
            checks: result.checks
          },
          "Preflight completato"
        );
      })
  );

  server.registerTool(
    "sellbot_listing_publish",
    {
      title: "Publish Listing",
      description: "Pubblica una listing su eBay senza conferma interattiva.",
      inputSchema: {
        folder: z.string().min(1)
      },
      outputSchema: resultSchema
    },
    async ({ folder }) =>
      withTool(async () => {
        await runPublish(folder, { yes: true });
        const config = await loadRuntimeConfig();
        return okResult(await getListingSnapshot(config, folder), "Listing pubblicata o aggiornata");
      })
  );

  server.registerTool(
    "sellbot_listing_revise",
    {
      title: "Revise Listing",
      description: "Aggiorna una listing gia' pubblicata via API eBay senza conferma interattiva.",
      inputSchema: {
        folder: z.string().min(1)
      },
      outputSchema: resultSchema
    },
    async ({ folder }) =>
      withTool(async () => {
        await runRevise(folder, { yes: true });
        const config = await loadRuntimeConfig();
        return okResult(await getListingSnapshot(config, folder), "Listing rivista");
      })
  );

  server.registerTool(
    "sellbot_category_suggest",
    {
      title: "Category Suggest",
      description: "Suggerisce categorie eBay da Taxonomy API e puo' fissare draft.category_id.",
      inputSchema: {
        folder: z.string().min(1),
        query: z.string().optional(),
        top: z.number().int().positive().max(20).optional(),
        pick: z.number().int().positive().optional()
      },
      outputSchema: resultSchema
    },
    async ({ folder, query, top, pick }) =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        const listing = await resolveListing(getToSellRoot(config.cwd), folder);
        const snapshot = await getListingSnapshot(config, folder);
        const draft = snapshot.draft;
        if (!draft) {
          throw new Error("draft.json mancante");
        }

        const resolvedQuery = query?.trim() || draft.category_hint;
        if (!resolvedQuery) {
          throw new Error("Query categoria vuota");
        }

        const oauthClient = createAppOAuthClient(config);
        const accessToken = await oauthClient.createApplicationToken();
        const taxonomyClient = new EbayTaxonomyClient({ apiBaseUrl: config.ebayApiBaseUrl });
        const marketplaceId = toRestMarketplaceId(config.ebayMarketplaceId);
        const treeId = await taxonomyClient.getDefaultCategoryTreeId(accessToken.access_token, marketplaceId);
        const suggestions = await taxonomyClient.getCategorySuggestions(
          accessToken.access_token,
          treeId,
          resolvedQuery
        );
        const visible = suggestions.slice(0, top ?? 5);

        if (pick) {
          const selected = visible[pick - 1];
          if (!selected) {
            throw new Error(`pick fuori range 1..${visible.length}`);
          }

          draft.category_id = selected.category.categoryId;
          await writeDraft(listing.draftPath, draft);
        }

        return okResult(
          {
            query: resolvedQuery,
            marketplaceId,
            suggestions: visible
          },
          pick ? "Categoria selezionata e salvata nel draft" : "Suggerimenti categoria letti"
        );
      })
  );

  server.registerTool(
    "sellbot_category_conditions",
    {
      title: "Category Conditions",
      description: "Restituisce le condizioni ammesse per una category_id nel marketplace corrente.",
      inputSchema: {
        category_id: z.string().regex(/^[0-9]+$/)
      },
      outputSchema: resultSchema
    },
    async ({ category_id }) =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        const oauthClient = createAppOAuthClient(config);
        const accessToken = await oauthClient.createApplicationToken();
        const metadataClient = new EbayMetadataClient({ apiBaseUrl: config.ebayApiBaseUrl });
        const marketplaceId = toRestMarketplaceId(config.ebayMarketplaceId);
        const policies = await metadataClient.getItemConditionPolicies(accessToken.access_token, marketplaceId, [
          category_id
        ]);

        return okResult(
          {
            marketplaceId,
            category_id,
            policies
          },
          "Condition policy letta"
        );
      })
  );

  server.registerTool(
    "sellbot_shipping_services",
    {
      title: "Shipping Services",
      description: "Legge i servizi di spedizione disponibili via Metadata API con filtri opzionali.",
      inputSchema: {
        marketplace: z.string().optional(),
        carrier: z.string().optional(),
        service: z.string().optional(),
        category: z.string().optional(),
        domestic: z.boolean().optional(),
        international: z.boolean().optional(),
        include_all: z.boolean().optional(),
        accept_language: z.string().optional(),
        limit: z.number().int().positive().max(100).optional()
      },
      outputSchema: resultSchema
    },
    async ({
      marketplace,
      carrier,
      service,
      category,
      domestic,
      international,
      include_all,
      accept_language,
      limit
    }) =>
      withTool(async () => {
        if (domestic && international) {
          throw new Error("Usa solo uno tra domestic e international");
        }

        const config = await loadRuntimeConfig();
        const oauthClient = createAppOAuthClient(config);
        const appToken = await oauthClient.createApplicationToken();
        const metadataClient = new EbayMetadataClient({ apiBaseUrl: config.ebayApiBaseUrl });
        const marketplaceId = toRestMarketplaceId(marketplace ?? config.ebayMarketplaceId);
        const services = await metadataClient.getShippingServices(appToken.access_token, marketplaceId, {
          acceptLanguage: accept_language
        });
        const filtered = filterShippingServices(services, {
          carrier,
          service,
          category,
          domestic,
          international,
          sellingFlowOnly: !(include_all ?? false),
          limit
        });

        return okResult(
          {
            marketplaceId,
            total: filtered.length,
            filters: {
              carrier,
              service,
              category,
              domestic: domestic ?? false,
              international: international ?? false,
              sellingFlowOnly: !(include_all ?? false),
              limit: limit ?? null
            },
            services: filtered,
            summaries: filtered.map((entry) => summarizeShippingService(entry))
          },
          "Servizi di spedizione letti"
        );
      })
  );

  return server;
};

export const runMcpServer = async (): Promise<void> => {
  const server = createSellbotMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("sellbot MCP server pronto su stdio");
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runMcpServer().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
