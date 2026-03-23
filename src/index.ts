#!/usr/bin/env node
import { Command } from "commander";
import { isSellbotError } from "./errors.js";
import { logger } from "./logger.js";
import { runAuth } from "./commands/auth.js";
import { runBuild } from "./commands/build.js";
import { runCategoryConditions } from "./commands/category-conditions.js";
import { runCategorySuggest } from "./commands/category-suggest.js";
import { runConfigTest } from "./commands/config-test.js";
import { runEnrich } from "./commands/enrich.js";
import { runIntakeCheck } from "./commands/intake-check.js";
import { runNotificationsServe } from "./commands/notifications-serve.js";
import { runOpen } from "./commands/open.js";
import { runPublishPreflight } from "./commands/publish-preflight.js";
import { runPublish } from "./commands/publish.js";
import { runRevise } from "./commands/revise.js";
import { runScan } from "./commands/scan.js";
import { runShippingServices } from "./commands/shipping-services.js";
import type { EnrichmentModuleId } from "./enrichment/modules.js";
import { runMcpHttpServer } from "./mcp/http-server.js";
import { runMcpServer } from "./mcp/server.js";

const runCommand = async (fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (error) {
    if (isSellbotError(error)) {
      logger.error(`${error.code}: ${error.message}`);
      if (error.details) {
        logger.error(`details: ${JSON.stringify(error.details)}`);
      }
    } else if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error(String(error));
    }

    process.exitCode = 1;
  }
};

const program = new Command();

program.name("sellbot").description("CLI per pubblicare inserzioni eBay da cartelle locali").version("0.1.0");

program
  .command("scan")
  .description("Scansiona ToSell/* e crea/aggiorna draft/status senza pubblicare")
  .action(async () => runCommand(runScan));

program
  .command("mcp")
  .description("Avvia il server MCP su stdio")
  .action(async () => runCommand(runMcpServer));

program
  .command("mcp:http")
  .description("Avvia il server MCP via Streamable HTTP")
  .option("--host <host>", "host di bind HTTP", "127.0.0.1")
  .option("--port <port>", "porta HTTP; default dal config attivo")
  .action(async (options: { host?: string; port?: string }) =>
    runCommand(() =>
      runMcpHttpServer({
        host: options.host,
        port: options.port ? Number.parseInt(options.port, 10) : undefined
      })
    )
  );

program
  .command("build")
  .description("Valida draft.json e genera ebay.json per una cartella")
  .argument("<folder>", "slug o path della cartella listing")
  .action(async (folder: string) => runCommand(() => runBuild(folder)));

program
  .command("category:suggest")
  .description("Mostra categorie suggerite da Taxonomy API e opzionalmente salva draft.category_id")
  .argument("<folder>", "slug o path della cartella listing")
  .option("--query <text>", "query esplicita al posto di draft.category_hint")
  .option("--top <n>", "numero massimo di suggerimenti da mostrare", "5")
  .option("--pick <rank>", "salva nel draft la suggestion alla posizione indicata (1-based)")
  .action(async (folder: string, options: { query?: string; top?: string; pick?: string }) =>
    runCommand(() => runCategorySuggest(folder, options))
  );

program
  .command("category:conditions")
  .description("Mostra le condizioni supportate da una categoria per il marketplace corrente")
  .argument("<categoryId>", "ID categoria eBay")
  .action(async (categoryId: string) => runCommand(() => runCategoryConditions(categoryId)));

program
  .command("shipping:services")
  .description("Legge i servizi di spedizione disponibili via Metadata API")
  .option("--marketplace <id>", "marketplace REST, default dal config attivo")
  .option("--carrier <code>", "filtra per shipping carrier code")
  .option("--service <code>", "filtra per shipping service code")
  .option("--category <code>", "filtra per shipping category")
  .option("--domestic", "mostra solo servizi domestici")
  .option("--international", "mostra solo servizi internazionali")
  .option("--all", "include anche servizi non validi per il selling flow")
  .option("--json", "stampa output machine-readable")
  .option("--accept-language <locale>", "imposta header Accept-Language se richiesto dal marketplace")
  .option("--limit <n>", "limita il numero di risultati")
  .action(
    async (options: {
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
    }) => runCommand(() => runShippingServices(options))
  );

program
  .command("enrich")
  .description("Genera enrichment.json e, se necessario, draft.json con un modulo dedicato")
  .argument("<folder>", "slug o path della cartella listing")
  .option("--module <module>", "modulo enrichment da usare: auto|generic|book", "auto")
  .option("--force", "rigenera draft.json anche se esiste gia'")
  .action(async (folder: string, options: { module?: EnrichmentModuleId; force?: boolean }) =>
    runCommand(() => runEnrich(folder, options))
  );

program
  .command("intake:check")
  .description("Genera un report agent-friendly con dati mancanti, search-first/ask-user e suggerimento prezzo")
  .argument("<folder>", "slug o path della cartella listing")
  .option("--module <module>", "profilo intake da usare: auto|generic|book", "auto")
  .option("--json", "stampa il report completo in JSON")
  .option("--no-save", "non salvare intake.json nella cartella listing")
  .action(
    async (
      folder: string,
      options: { module?: EnrichmentModuleId; json?: boolean; save?: boolean }
    ) => runCommand(() => runIntakeCheck(folder, options))
  );

program
  .command("auth")
  .description("Esegue OAuth2 (callback locale o inserimento manuale code) e salva il token locale")
  .action(async () => runCommand(runAuth));

program
  .command("notifications:serve")
  .description("Espone localmente l'endpoint eBay per account deletion notifications")
  .option("--host <host>", "host locale di bind", "127.0.0.1")
  .option("--port <port>", "porta locale di bind", "8080")
  .action(async (options: { host?: string; port?: string }) =>
    runCommand(() => runNotificationsServe(options))
  );

program
  .command("publish")
  .description("Pubblica una singola cartella listing su eBay")
  .argument("<folder>", "slug o path della cartella listing")
  .option("-y, --yes", "salta conferma interattiva")
  .action(async (folder: string, options: { yes?: boolean }) => runCommand(() => runPublish(folder, options)));

program
  .command("publish:preflight")
  .description("Verifica categoria, condition policy, aspects e config prima del publish")
  .argument("<folder>", "slug o path della cartella listing")
  .action(async (folder: string) => runCommand(() => runPublishPreflight(folder)));

program
  .command("revise")
  .description("Aggiorna una listing già pubblicata (descrizione/foto/prezzo) via API")
  .argument("<folder>", "slug o path della cartella listing")
  .option("-y, --yes", "salta conferma interattiva")
  .action(async (folder: string, options: { yes?: boolean }) => runCommand(() => runRevise(folder, options)));

program
  .command("open")
  .description("Stampa e apre nel browser la URL eBay di una listing pubblicata")
  .argument("<folder>", "slug o path della cartella listing")
  .option("--print-only", "stampa solo l'URL senza aprire il browser")
  .action(async (folder: string, options: { printOnly?: boolean }) => runCommand(() => runOpen(folder, options)));

program
  .command("config:test")
  .description("Verifica token/config/policy/location con check read-only")
  .action(async () => runCommand(runConfigTest));

await program.parseAsync(process.argv);
