#!/usr/bin/env node
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadRuntimeConfig, resolveVisionBackend, type RuntimeConfig } from "../config.js";
import { runBuild } from "../commands/build.js";
import { runEnrich } from "../commands/enrich.js";
import { runPublish } from "../commands/publish.js";
import { runRevise } from "../commands/revise.js";
import { runScan } from "../commands/scan.js";
import { createAppOAuthClient } from "../ebay/oauth-client-factory.js";
import { EbayMetadataClient } from "../ebay/metadata.js";
import { EbayTaxonomyClient } from "../ebay/taxonomy.js";
import { isSellbotError } from "../errors.js";
import {
  clearInboxSession,
  getInboxSession,
  getInboxSessionStatus,
  purgeStaleInboxSessions,
  saveInboxPhoto
} from "../fs/inbox.js";
import {
  clearRecentPromotion,
  getRecentPromotion,
  removeStalePromotions,
  type RecentPromotionLookup
} from "../fs/inbox-state.js";
import { getToSellRoot, resolveListing, writeDraft, writeIntakeReport } from "../fs/listings.js";
import { buildListingIntakeReport } from "../intake/index.js";
import { logger } from "../logger.js";
import { completeUserAuth, getUserAuthStatus, startUserAuth } from "../services/auth-flow.js";
import { readToken } from "../token/token-store.js";
import { runConfigChecks } from "../services/config-check.js";
import { patchListingDraft } from "../services/draft-patch.js";
import { addPhotoToListing, adoptInboxPhotosToListing } from "../services/listing-add-photo.js";
import { createListingFromInbox } from "../services/listing-create-from-inbox.js";
import {
  DEFAULT_BULK_DELETE_STATES,
  deleteListing,
  deleteListingsBulk,
  type DeletableState
} from "../services/listing-delete.js";
import { endListingOnEbay } from "../services/listing-end-on-ebay.js";
import { resolveListings } from "../services/listing-resolve.js";
import { getListingSnapshot, listListingsSummary } from "../services/listing-snapshot.js";
import { listRemoteListings } from "../services/remote-listings.js";
import { runPublishPreflightChecks } from "../services/publish-preflight.js";
import { filterShippingServices, summarizeShippingService } from "../shipping/services.js";
import { toRestMarketplaceId } from "../utils/marketplace.js";
import { identifyBookFromPhoto } from "../vision/book-identification.js";

const resultSchema = z.object({
  ok: z.literal(true),
  message: z.string().optional(),
  data: z.any().optional()
});

const asText = (value: unknown): string => JSON.stringify(value, null, 2);

const okResult = (data: unknown, message?: string, textOverride?: string) => ({
  content: [
    {
      type: "text" as const,
      text: textOverride ?? asText({ ok: true, message, data })
    }
  ],
  structuredContent: {
    ok: true as const,
    message,
    data
  }
});

const AUTH_ERROR_CODES = new Set([
  "AUTH_PENDING_MISSING",
  "AUTH_PENDING_INVALID",
  "AUTH_SESSION_EXPIRED",
  "AUTH_SESSION_ERROR",
  "OAUTH_STATE",
  "OAUTH_DENIED",
  "OAUTH_CODE_MISSING",
  "OAUTH_ERROR",
  "TOKEN_MISSING",
  "TOKEN_REFRESH_FAILED",
  "TOKEN_REFRESH_REQUIRED",
  "TOKEN_INVALID",
  "EBAY_AUTH_REQUIRED"
]);

const RETRYABLE_ERROR_CODES = new Set([
  "EBAY_API_TIMEOUT",
  "EBAY_API_RATE_LIMIT",
  "EBAY_API_SERVER_ERROR",
  "HTTP_TIMEOUT",
  "NETWORK_ERROR"
]);

interface ErrorPayload {
  ok: false;
  code: string;
  message: string;
  details?: unknown;
  requires_auth: boolean;
  retryable: boolean;
  hint?: string;
}

const buildErrorPayload = (code: string, message: string, details?: unknown): ErrorPayload => {
  const requiresAuth = AUTH_ERROR_CODES.has(code) || /OAUTH|TOKEN|AUTH/i.test(code);
  const retryable = RETRYABLE_ERROR_CODES.has(code);

  const hint = requiresAuth
    ? "Chiama sellbot_auth_ensure (oppure sellbot_auth_status + sellbot_auth_start) per ripristinare l'autenticazione utente eBay prima di riprovare."
    : retryable
      ? "Errore transitorio: si puo' ritentare la chiamata dopo un breve backoff."
      : undefined;

  return {
    ok: false,
    code,
    message,
    details,
    requires_auth: requiresAuth,
    retryable,
    ...(hint ? { hint } : {})
  };
};

const errorResult = (error: unknown) => {
  const payload: ErrorPayload = isSellbotError(error)
    ? buildErrorPayload(error.code, error.message, error.details)
    : error instanceof Error
      ? buildErrorPayload("UNHANDLED_ERROR", error.message)
      : buildErrorPayload("UNHANDLED_ERROR", String(error));

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

interface RecentPromotionPayload {
  session_id: string;
  slug: string;
  title: string;
  promoted_at: string;
  age_seconds: number;
}

const buildRecentPromotionPayload = (
  sessionId: string,
  lookup: RecentPromotionLookup
): RecentPromotionPayload => ({
  session_id: sessionId,
  slug: lookup.promotion.slug,
  title: lookup.promotion.title,
  promoted_at: lookup.promotion.promoted_at,
  age_seconds: Math.round(lookup.age_ms / 1000)
});

const lookupRecentPromotionForResponse = async (
  config: RuntimeConfig,
  sessionId: string
): Promise<RecentPromotionPayload | null> => {
  const toSellRoot = getToSellRoot(config.cwd);
  const lookup = await getRecentPromotion(toSellRoot, sessionId);
  if (!lookup) {
    return null;
  }
  try {
    await resolveListing(toSellRoot, lookup.promotion.slug);
  } catch {
    await clearRecentPromotion(toSellRoot, sessionId);
    return null;
  }
  return buildRecentPromotionPayload(sessionId, lookup);
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

        const followup =
          result.callbackMode === "automatic_http"
            ? "Quando l'utente completa il consenso nel browser, il callback HTTP salvera' automaticamente il token. Monitora lo stato con sellbot_auth_status."
            : "Dopo il consenso, copia l'URL finale dal browser (dopo il redirect) e chiama il tool sellbot_auth_complete con redirect_url=<URL>.";

        const message =
          "Avvio flusso OAuth eBay completato. Apri questo URL nel browser per autorizzare l'app:";

        const text = [
          "ok: true",
          `message: ${message}`,
          "",
          result.consentUrl,
          "",
          followup,
          "",
          `callbackMode: ${result.callbackMode}`,
          `state: ${result.state}`,
          `expiresAt: ${result.expiresAt}`,
          `authSessionId: ${result.authSessionId}`,
          `reused: ${result.reused}`
        ].join("\n");

        return okResult(result, message, text);
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
        const result = await completeUserAuth(config, raw);
        const token = await readToken(config).catch(() => null);

        const message = result.alreadyCompleted
          ? "Sessione gia' autenticata: nessuna azione necessaria."
          : "Autenticazione eBay completata: token salvato.";

        const data = {
          ...result,
          token: token
            ? {
                expires_at: token.expires_at,
                refresh_token_expires_at: token.refresh_token_expires_at ?? null,
                scope: token.scope ?? null
              }
            : null
        };

        const lines = [
          "ok: true",
          `message: ${message}`,
          "",
          `tokenFilePath: ${result.tokenFilePath}`,
          `authSessionId: ${result.authSessionId}`,
          `alreadyCompleted: ${result.alreadyCompleted}`
        ];
        if (result.completedAt) {
          lines.push(`completedAt: ${result.completedAt}`);
        }
        if (token) {
          lines.push(`tokenExpiresAt: ${token.expires_at}`);
          if (token.refresh_token_expires_at) {
            lines.push(`refreshTokenExpiresAt: ${token.refresh_token_expires_at}`);
          }
          if (token.scope) {
            lines.push(`scope: ${token.scope}`);
          }
        }

        return okResult(data, message, lines.join("\n"));
      })
  );

  server.registerTool(
    "sellbot_auth_ensure",
    {
      title: "Auth Ensure",
      description:
        "Tool 'all-in-one' per agenti: garantisce che ci sia un token utente valido. Se gia' autenticato → ritorna state='authenticated'. Se c'e' una sessione OAuth pendente non scaduta → riusa il consentUrl esistente (reused=true). Altrimenti → avvia un nuovo flusso OAuth e ritorna un consentUrl da aprire nel browser. Se la configurazione OAuth e' incompleta → ritorna state='not_configured' con la lista delle env mancanti. Usalo PRIMA di ogni tool che parla con eBay (publish/revise/end/remote_listings/prepare_for_publish): elimina il giro a tre tool (status→start→consent).",
      outputSchema: resultSchema
    },
    async () =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        const status = await getUserAuthStatus(config);

        if (status.state === "authenticated") {
          return okResult(
            {
              state: "authenticated" as const,
              env: status.env,
              token: {
                expires_at: status.tokenExpiresAt ?? null,
                scopes: status.scopes ?? []
              },
              action_required: false
            },
            "Token utente eBay valido"
          );
        }

        if (status.state === "not_configured") {
          return okResult(
            {
              state: "not_configured" as const,
              env: status.env,
              missing_configuration: status.missingConfiguration,
              reason: status.reason,
              action_required: true
            },
            `Configurazione OAuth incompleta: ${status.missingConfiguration.join(", ")}`
          );
        }

        const start = await startUserAuth(config);
        const message = start.reused
          ? "Sessione OAuth pendente gia' presente: riutilizzo consentUrl esistente."
          : "Avviato nuovo flusso OAuth eBay. Apri consentUrl nel browser per autorizzare l'app.";

        const text = [
          "ok: true",
          `state: pending_user_consent`,
          `message: ${message}`,
          "",
          start.consentUrl,
          "",
          start.callbackMode === "automatic_http"
            ? "Quando l'utente completa il consenso, il callback HTTP salvera' automaticamente il token. Polla sellbot_auth_status finche' state='authenticated'."
            : "Dopo il consenso, copia l'URL finale dal browser e chiama sellbot_auth_complete con redirect_url=<URL>.",
          "",
          `callbackMode: ${start.callbackMode}`,
          `reused: ${start.reused}`,
          `expiresAt: ${start.expiresAt}`
        ].join("\n");

        return okResult(
          {
            state: "pending_user_consent" as const,
            env: config.ebayEnv,
            consent_url: start.consentUrl,
            callback_mode: start.callbackMode,
            callback_url: start.callbackUrl ?? null,
            expires_at: start.expiresAt,
            auth_session_id: start.authSessionId,
            reused: start.reused,
            previous_state: status.state,
            action_required: true
          },
          message,
          text
        );
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
      description:
        "Elenca le cartelle in ToSell con stato, foto e artefatti disponibili. Accetta un parametro 'query' opzionale per filtrare per substring sullo slug (o listing_id se la query e' numerica): comodo quando l'utente fa riferimento a un'inserzione con linguaggio naturale (es. 'rosa', 'libro di Calvino').",
      inputSchema: {
        scope: z.enum(["all", "current_env"]).optional().describe("Di default mostra solo listing compatibili con l'env attivo"),
        state: z.string().optional().describe("Filtra per stato locale, es. draft|ready|published|error"),
        published_only: z.boolean().optional().describe("Mostra solo listing pubblicate"),
        query: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Substring case-insensitive su slug (o su listing_id se numerico). Utile per risolvere riferimenti naturali."
          )
      },
      outputSchema: resultSchema
    },
    async ({ scope, state, published_only, query }) =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        const listings = await listListingsSummary(config, {
          scope: scope ?? "current_env",
          state,
          publishedOnly: published_only ?? false,
          query
        });
        return okResult(
          {
            current_env: config.ebayEnv,
            total: listings.length,
            filters: {
              scope: scope ?? "current_env",
              state: state ?? null,
              published_only: published_only ?? false,
              query: query ?? null
            },
            listings
          },
          "Elenco listing letto"
        );
      })
  );

  server.registerTool(
    "sellbot_listing_resolve",
    {
      title: "Resolve Listing",
      description:
        "Risolve uno slug a partire da listing_id eBay (numerico), URL eBay (es. https://www.ebay.it/itm/1234...) o query testuale sullo slug. Cerca sempre con scope='all' perche' un listing_id e' globale tra env. Restituisce zero, uno o piu' match con il reason del matching ('listing_id'|'ebay_url'|'slug_exact'|'slug_substring'). Pensato per agenti che ricevono un riferimento naturale dall'utente e devono mappare allo slug interno SENZA chiedere la cartella.",
      inputSchema: {
        listing_id: z
          .string()
          .min(1)
          .optional()
          .describe("Listing ID numerico eBay (la parte dopo /itm/ negli URL)."),
        ebay_url: z
          .string()
          .min(1)
          .optional()
          .describe("URL eBay completo della listing (sandbox o produzione). Il listing_id viene estratto da /itm/<id>."),
        query: z
          .string()
          .min(1)
          .optional()
          .describe("Substring case-insensitive sullo slug (es. parte del titolo dell'inserzione)."),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("Numero massimo di match da restituire (default 20).")
      },
      outputSchema: resultSchema
    },
    async ({ listing_id, ebay_url, query, limit }) =>
      withTool(async () => {
        if (!listing_id && !ebay_url && !query) {
          throw new Error("Specifica almeno uno tra listing_id, ebay_url o query.");
        }

        const config = await loadRuntimeConfig();
        const result = await resolveListings(config, {
          listing_id,
          ebay_url,
          query,
          limit
        });

        const messageParts: string[] = [];
        if (result.not_found) {
          messageParts.push("Nessun match trovato");
        } else if (result.ambiguous) {
          messageParts.push(`${result.total} match (ambigui)`);
        } else {
          messageParts.push(`1 match: ${result.matches[0]?.listing.slug}`);
        }

        return okResult(
          {
            current_env: config.ebayEnv,
            ...result
          },
          messageParts.join(" — ")
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
        item_specifics_set: z
          .record(z.string(), z.union([z.string(), z.array(z.string().min(1)).min(1)]))
          .optional()
          .describe(
            "Map di specifics da impostare. Valori possono essere string (single-value) o string[] (multi-value: es. ['Italiano','Inglese']). I multi-value vengono persisti come stringa joinata con ' | ' nel draft e splittati in aspects[] durante la build per eBay."
          ),
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
    "sellbot_listing_publish_if_ready",
    {
      title: "Publish Listing If Ready",
      description:
        "Workflow guardato: esegue prepare_for_publish (enrich+intake+build+preflight) e, SE la listing risulta ready_to_publish, chiama sellbot_listing_publish. Altrimenti si ferma e restituisce blockers e check falliti senza toccare eBay. Pensato per agenti che devono pubblicare in un solo turno quando i dati sono completi, e ricevere un feedback chiaro quando manca qualcosa.",
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
        const preflightAllOk = preflight.checks.every((check) => check.level !== "KO");
        const readyToPublish =
          intake.report.summary.publish_blockers.length === 0 && preflightAllOk;

        if (!readyToPublish) {
          const snapshot = await getListingSnapshot(config, folder);
          return okResult(
            {
              published: false,
              ready_to_publish: false,
              next_step: "resolve_missing_data_or_preflight_issues",
              intake: intake.report,
              preflight: {
                all_ok: preflightAllOk,
                checks: preflight.checks
              },
              snapshot
            },
            "Listing non pronta: pubblicazione saltata"
          );
        }

        await runPublish(folder, { yes: true });
        const snapshot = await getListingSnapshot(config, folder);

        return okResult(
          {
            published: true,
            ready_to_publish: true,
            next_step: "monitor_or_revise",
            intake: intake.report,
            preflight: {
              all_ok: preflightAllOk,
              checks: preflight.checks
            },
            snapshot
          },
          "Listing pronta e pubblicata su eBay"
        );
      })
  );

  server.registerTool(
    "sellbot_listing_end_on_ebay",
    {
      title: "End Listing On eBay",
      description:
        "Ritira la pubblicazione di una listing da eBay chiamando withdrawOffer sull'env attivo. La cartella locale resta intatta (la listing torna in stato 'draft' e puo' essere ripubblicata). Se delete_offer=true elimina anche l'offer record da Inventory API. Richiede confirm=true. Se la listing non ha offer_id registrato fallisce con OFFER_MISSING. Per cancellare anche la cartella locale, usa dopo sellbot_listing_delete (force=true non sara' piu' richiesto perche' lo stato sara' tornato a 'draft').",
      inputSchema: {
        folder: z.string().min(1).describe("Slug della listing o path assoluto."),
        confirm: z
          .literal(true)
          .describe("Conferma esplicita richiesta: passa true solo dopo conferma dall'utente."),
        delete_offer: z
          .boolean()
          .optional()
          .describe(
            "Se true elimina anche l'offer record da Inventory API dopo il withdraw (operazione separata: il withdraw rende non visibile la listing, il delete rimuove l'offer dal sistema)."
          )
      },
      outputSchema: resultSchema
    },
    async ({ folder, confirm, delete_offer }) =>
      withTool(async () => {
        if (confirm !== true) {
          throw new Error(
            "Per ritirare la pubblicazione da eBay serve confirm=true (conferma esplicita dall'utente)."
          );
        }
        const config = await loadRuntimeConfig();
        const result = await endListingOnEbay(config, folder, { delete_offer });

        const messageParts: string[] = [];
        if (result.withdrawn) {
          messageParts.push(`Listing ${result.slug} ritirata da eBay (${result.ebay_env})`);
        } else {
          messageParts.push(`Listing ${result.slug}: nessun withdraw eseguito`);
        }
        if (result.offer_deleted) {
          messageParts.push("offer record eliminata");
        }
        if (result.warnings.length > 0) {
          messageParts.push(`avvisi: ${result.warnings.length}`);
        }

        return okResult(result, messageParts.join(" — "));
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
    "sellbot_inbox_add_photo",
    {
      title: "Inbox Add Photo",
      description:
        "Salva una foto in un'inbox temporanea (ToSell/_inbox/<session_id>/photos/) prima della creazione della listing. Pensato per client che ricevono immagini da chat (es. Telegram): non serve conoscere lo slug. Le inbox abbandonate vengono purgate automaticamente dopo 24h.\n\nGESTIONE CONTESTO: la response include 'recent_promotion' se nella stessa session_id e' stata appena promossa una listing (entro ~60 min). Quando presente, NON chiamare automaticamente sellbot_listing_create_from_inbox: chiedi all'utente se la nuova foto appartiene alla listing esistente (es. retro/dettaglio) — in tal caso usa sellbot_listing_add_photo (slug=recent_promotion.slug) invece di creare una nuova listing.",
      inputSchema: {
        bytes_base64: z.string().min(1).describe("Contenuto del file immagine codificato base64"),
        mime: z
          .string()
          .min(1)
          .describe("MIME type. Accettati: image/jpeg, image/png, image/heic (heif/jpg sono mappati)"),
        session_id: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            "Identificatore della sessione di upload (default: 'default'). Per Telegram passa di solito chat_id."
          ),
        filename: z
          .string()
          .min(1)
          .optional()
          .describe("Filename desiderato. Se omesso viene auto-generato (photo-<ts>.<ext>).")
      },
      outputSchema: resultSchema
    },
    async ({ bytes_base64, mime, session_id, filename }) =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        const toSellRoot = getToSellRoot(config.cwd);
        const purge = await purgeStaleInboxSessions(toSellRoot);
        if (purge.purged.length > 0) {
          logger.info(`[inbox] purgate sessioni stale: ${purge.purged.join(", ")}`);
        }

        const session = getInboxSession(toSellRoot, session_id);
        const result = await saveInboxPhoto(session, {
          bytesBase64: bytes_base64,
          mime,
          filename
        });

        const recentPromotion = await lookupRecentPromotionForResponse(config, session.sessionId);

        const baseMessage = `Foto salvata in inbox (${result.totalPhotos} totali per la sessione)`;
        const message = recentPromotion
          ? `${baseMessage}. Attenzione: la sessione ${session.sessionId} ha appena promosso la listing '${recentPromotion.slug}' (~${recentPromotion.age_seconds}s fa). Chiedi all'utente se questa foto e' del retro/dettaglio di quella listing prima di creare un nuovo articolo.`
          : baseMessage;

        return okResult(
          {
            session_id: session.sessionId,
            photo_path: result.photoPath,
            filename: result.filename,
            bytes: result.bytes,
            total_photos: result.totalPhotos,
            purged_sessions: purge.purged,
            recent_promotion: recentPromotion
          },
          message
        );
      })
  );

  server.registerTool(
    "sellbot_listing_create_from_inbox",
    {
      title: "Create Listing From Inbox",
      description:
        "Promuove le foto di un'inbox a una listing vera: identifica il titolo via vision (per moduli book/auto), genera lo slug dal titolo, sposta la cartella sotto ToSell/<slug>/ ed esegue enrichment. Restituisce snapshot e foto identificata come copertina. Se vision non identifica il libro e non passi title_override/slug_override fallisce con TITLE_REQUIRED esponendo i candidati.\n\nIMPORTANTE: NON chiamare questo tool quando la response di sellbot_inbox_add_photo include 'recent_promotion' senza prima aver chiesto all'utente se la nuova foto appartiene alla listing appena creata. In quel caso, usa sellbot_listing_add_photo per aggiungere la foto alla listing esistente; chiama sellbot_inbox_clear sulla sessione (per ripulire l'inbox in cui e' finita la foto del retro) e poi richiedi conferma esplicita prima di partire con un secondo articolo.",
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe("Identificatore della sessione di upload (default: 'default')."),
        module: z
          .enum(["auto", "book", "generic"])
          .optional()
          .describe("Modulo enrichment. 'auto' = autodetect (default)."),
        title_override: z
          .string()
          .min(1)
          .optional()
          .describe("Forza il titolo (lo slug verra' derivato da qui se slug_override non e' passato)."),
        slug_override: z
          .string()
          .min(1)
          .optional()
          .describe("Forza lo slug della cartella (lowercase a-z, 0-9, trattini; salta vision se passato)."),
        cover_filename: z
          .string()
          .min(1)
          .optional()
          .describe("Filename della foto da usare come copertina (default: prima in ordine alfabetico)."),
        hint: z
          .string()
          .optional()
          .describe("Suggerimento testuale passato al modello vision (es. 'romanzo italiano anni '80').")
      },
      outputSchema: resultSchema
    },
    async ({ session_id, module, title_override, slug_override, cover_filename, hint }) =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        const result = await createListingFromInbox(config, {
          sessionId: session_id,
          module,
          titleOverride: title_override,
          slugOverride: slug_override,
          coverFilename: cover_filename,
          hint
        });
        return okResult(result, `Listing ${result.slug} creata dall'inbox`);
      })
  );

  server.registerTool(
    "sellbot_book_identify_from_photo",
    {
      title: "Identify Book From Photo",
      description:
        "Identifica titolo/autore/ISBN di un libro a partire da una foto di copertina usando il modello vision Ollama (default gemma4:e4b). Se l'identificazione e' incerta restituisce candidates vuoti: l'agente puo' decidere di chiedere all'utente.\n\nGESTIONE CONTESTO: se passi session_id, la response include 'recent_promotion' (se nella stessa sessione e' stata appena creata una listing, entro ~60 min). Se presente, valuta se la foto identificata e' del retro/dettaglio di quella listing prima di creare un nuovo articolo.",
      inputSchema: {
        photo_path: z
          .string()
          .min(1)
          .describe("Path del file immagine (assoluto o relativo a cwd del processo)"),
        hint: z
          .string()
          .optional()
          .describe("Suggerimento testuale opzionale dell'utente, es. 'romanzo italiano anni '80'"),
        session_id: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            "Identificatore della sessione inbox associata. Se presente, la response include recent_promotion (listing creata di recente nella stessa sessione)."
          )
      },
      outputSchema: resultSchema
    },
    async ({ photo_path, hint, session_id }) =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        const resolvedPath = path.isAbsolute(photo_path)
          ? photo_path
          : path.resolve(config.cwd, photo_path);

        const result = await identifyBookFromPhoto({
          photoPath: resolvedPath,
          backend: resolveVisionBackend(config.vision),
          hint
        });

        const recentPromotion = session_id
          ? await lookupRecentPromotionForResponse(config, session_id)
          : null;

        const baseMessage =
          result.match === "none"
            ? result.reason
              ? `Nessuna corrispondenza affidabile (${result.reason}): valuta di chiedere all'utente`
              : "Nessuna corrispondenza affidabile: valuta di chiedere all'utente"
            : `Candidati libro identificati (match=${result.match})`;

        const message = recentPromotion
          ? `${baseMessage}. Attenzione: la sessione ${session_id} ha promosso la listing '${recentPromotion.slug}' (~${recentPromotion.age_seconds}s fa): la foto potrebbe essere del retro/dettaglio di quella listing.`
          : baseMessage;

        return okResult(
          {
            photo_path: resolvedPath,
            model: result.model,
            match: result.match,
            candidates: result.candidates,
            elapsed_ms: result.elapsed_ms,
            reason: result.reason ?? null,
            recent_promotion: recentPromotion
          },
          message
        );
      })
  );

  server.registerTool(
    "sellbot_listing_add_photo",
    {
      title: "Add Photo To Listing",
      description:
        "Aggiunge una foto a una listing gia' creata sotto ToSell/<slug>/photos/. Usa questo tool quando l'utente conferma che una nuova foto e' del retro/dettaglio di una listing esistente (vedi 'recent_promotion' nella response di sellbot_inbox_add_photo). Per spostare in blocco le foto gia' presenti in un'inbox usa invece sellbot_listing_adopt_inbox_photos.",
      inputSchema: {
        folder: z.string().min(1).describe("Slug della listing (es. il-nome-della-rosa) o path assoluto."),
        bytes_base64: z.string().min(1).describe("Contenuto del file immagine codificato base64."),
        mime: z
          .string()
          .min(1)
          .describe("MIME type. Accettati: image/jpeg, image/png, image/heic."),
        filename: z
          .string()
          .min(1)
          .optional()
          .describe("Filename desiderato. Se omesso viene auto-generato (photo-<ts>.<ext>).")
      },
      outputSchema: resultSchema
    },
    async ({ folder, bytes_base64, mime, filename }) =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        const result = await addPhotoToListing(config, folder, {
          bytesBase64: bytes_base64,
          mime,
          filename
        });
        return okResult(
          {
            slug: result.slug,
            listing_dir: result.listing_dir,
            photo_path: result.photoPath,
            filename: result.filename,
            bytes: result.bytes,
            total_photos: result.totalPhotos
          },
          `Foto aggiunta a ${result.slug} (${result.totalPhotos} totali)`
        );
      })
  );

  server.registerTool(
    "sellbot_listing_adopt_inbox_photos",
    {
      title: "Adopt Inbox Photos Into Listing",
      description:
        "Sposta tutte le foto di una sessione inbox dentro la cartella photos/ di una listing esistente, poi rimuove la sessione inbox. Usa questo tool nel flusso 'foto del retro inviata DOPO la creazione del libro': l'utente ha appena confermato che le foto in arrivo appartengono alla listing 'recent_promotion' segnalata da sellbot_inbox_add_photo.",
      inputSchema: {
        folder: z.string().min(1).describe("Slug della listing destinazione o path assoluto."),
        session_id: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe("Identificatore della sessione inbox sorgente (default: 'default').")
      },
      outputSchema: resultSchema
    },
    async ({ folder, session_id }) =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        const result = await adoptInboxPhotosToListing(config, folder, session_id);
        return okResult(
          {
            slug: result.slug,
            listing_dir: result.listing_dir,
            source_session_id: result.source_session_id,
            moved_filenames: result.moved_filenames,
            total_photos_after: result.total_photos_after
          },
          `Spostate ${result.moved_filenames.length} foto in ${result.slug} (sessione ${result.source_session_id} ripulita)`
        );
      })
  );

  server.registerTool(
    "sellbot_inbox_status",
    {
      title: "Inbox Status",
      description:
        "Ispeziona lo stato corrente di una sessione inbox e l'eventuale promozione recente associata. Usa questo tool prima di decidere se trattare nuove foto come 'retro/dettaglio' di una listing appena creata o come nuovo articolo: la response include il numero di foto attualmente in inbox e, se presente, la listing promossa di recente (entro ~60 min) per quella session_id.",
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe("Identificatore della sessione (default: 'default').")
      },
      outputSchema: resultSchema
    },
    async ({ session_id }) =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        const toSellRoot = getToSellRoot(config.cwd);
        await removeStalePromotions(toSellRoot);
        const status = await getInboxSessionStatus(toSellRoot, session_id);
        const recentPromotion = await lookupRecentPromotionForResponse(config, status.sessionId);
        const messageParts = [
          `Inbox ${status.sessionId}: ${status.exists ? `${status.photos.length} foto` : "vuota"}`
        ];
        if (recentPromotion) {
          messageParts.push(
            `promozione recente: ${recentPromotion.slug} (~${recentPromotion.age_seconds}s fa)`
          );
        }
        return okResult(
          {
            session_id: status.sessionId,
            exists: status.exists,
            dir: status.dir,
            photos: status.photos,
            recent_promotion: recentPromotion
          },
          messageParts.join(" — ")
        );
      })
  );

  server.registerTool(
    "sellbot_inbox_clear",
    {
      title: "Inbox Clear",
      description:
        "Cancella tutte le foto e la cartella di una sessione inbox (ToSell/_inbox/<session_id>/). Usa questo tool per scartare upload sbagliati prima di promuovere a listing, oppure per ripulire l'inbox dopo aver capito che le foto in arrivo erano del retro della listing 'recent_promotion'.",
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe("Identificatore della sessione da cancellare (default: 'default').")
      },
      outputSchema: resultSchema
    },
    async ({ session_id }) =>
      withTool(async () => {
        const config = await loadRuntimeConfig();
        const toSellRoot = getToSellRoot(config.cwd);
        const cleared = await clearInboxSession(toSellRoot, session_id);
        await clearRecentPromotion(toSellRoot, cleared.sessionId);
        const message = cleared.existed
          ? `Inbox '${cleared.sessionId}' rimossa: ${cleared.removedPhotos} foto cancellate.`
          : `Nessuna inbox da rimuovere per session_id='${cleared.sessionId}' (non era presente).`;
        return okResult(
          {
            session_id: cleared.sessionId,
            existed: cleared.existed,
            dir: cleared.dir,
            removed_photos: cleared.removedPhotos
          },
          message
        );
      })
  );

  server.registerTool(
    "sellbot_listings_delete_bulk",
    {
      title: "Delete Listings In Bulk",
      description:
        "Cancella in blocco le bozze locali sotto ToSell/. Di default tocca solo gli stati 'draft', 'ready', 'error': le listing 'published' vengono SEMPRE saltate salvo include_published=true (e anche in quel caso la pubblicazione su eBay non viene ritirata). Comodo per ripulire una sessione di prove. Ritorna gli slug cancellati e quelli saltati con motivo.",
      inputSchema: {
        confirm: z
          .literal(true)
          .describe("Conferma esplicita richiesta: passa true solo dopo conferma dall'utente."),
        states: z
          .array(z.enum(["draft", "ready", "error", "published"]))
          .min(1)
          .optional()
          .describe(
            "Stati da includere. Default: ['draft', 'ready', 'error']. Per cancellare anche le 'published' usa include_published=true."
          ),
        include_published: z
          .boolean()
          .optional()
          .describe(
            "Se true cancella anche le listing 'published' (la pubblicazione su eBay resta attiva)."
          )
      },
      outputSchema: resultSchema
    },
    async ({ confirm, states, include_published }) =>
      withTool(async () => {
        if (confirm !== true) {
          throw new Error("Per la cancellazione in blocco serve confirm=true (conferma esplicita dall'utente).");
        }
        const config = await loadRuntimeConfig();
        const stateSet = states && states.length > 0
          ? new Set<DeletableState>(states as DeletableState[])
          : DEFAULT_BULK_DELETE_STATES;
        const result = await deleteListingsBulk(config, {
          states: stateSet,
          includePublished: include_published
        });
        const message = `Cancellate ${result.deleted.length} bozze su ${result.total_scanned} totali (${result.skipped.length} saltate).`;
        return okResult(
          {
            deleted: result.deleted,
            skipped: result.skipped,
            total_scanned: result.total_scanned,
            states_used: Array.from(stateSet),
            include_published: Boolean(include_published)
          },
          message
        );
      })
  );

  server.registerTool(
    "sellbot_listing_delete",
    {
      title: "Delete Listing",
      description:
        "Cancella una listing locale (cartella ToSell/<slug>/ con foto, draft, intake, enrichment, status). Operazione irreversibile, NON ritira la pubblicazione su eBay: se la listing e' in stato 'published' il tool rifiuta a meno di force=true. Usa per ripulire bozze a meta' opera o duplicati.",
      inputSchema: {
        folder: z.string().min(1).describe("Slug della listing o path assoluto."),
        confirm: z
          .literal(true)
          .describe("Conferma esplicita richiesta: passa true solo dopo aver avuto conferma dall'utente."),
        force: z
          .boolean()
          .optional()
          .describe("Se true cancella anche listing in stato 'published' (la pubblicazione su eBay resta attiva).")
      },
      outputSchema: resultSchema
    },
    async ({ folder, confirm, force }) =>
      withTool(async () => {
        if (confirm !== true) {
          throw new Error("Per cancellare una listing serve confirm=true (conferma esplicita dall'utente).");
        }
        const config = await loadRuntimeConfig();
        const result = await deleteListing(config, folder, { force });
        const warning = result.was_published
          ? ` Attenzione: la listing era 'published' (offer_id=${result.ebay_offer_id ?? "?"}, listing_id=${result.ebay_listing_id ?? "?"}): cartella locale rimossa ma la pubblicazione su eBay e' ancora attiva.`
          : "";
        return okResult(
          {
            slug: result.slug,
            dir: result.dir,
            was_published: result.was_published,
            ebay_offer_id: result.ebay_offer_id,
            ebay_listing_id: result.ebay_listing_id
          },
          `Listing ${result.slug} cancellata localmente.${warning}`
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
