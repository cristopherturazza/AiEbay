#!/usr/bin/env node
import { Command } from "commander";
import { isSellbotError } from "./errors.js";
import { logger } from "./logger.js";
import { runAuth } from "./commands/auth.js";
import { runBuild } from "./commands/build.js";
import { runConfigTest } from "./commands/config-test.js";
import { runPublish } from "./commands/publish.js";
import { runScan } from "./commands/scan.js";

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
  .command("build")
  .description("Valida draft.json e genera ebay.json per una cartella")
  .argument("<folder>", "slug o path della cartella listing")
  .action(async (folder: string) => runCommand(() => runBuild(folder)));

program
  .command("auth")
  .description("Esegue OAuth2 con callback localhost e salva il token locale")
  .action(async () => runCommand(runAuth));

program
  .command("publish")
  .description("Pubblica una singola cartella listing su eBay")
  .argument("<folder>", "slug o path della cartella listing")
  .option("-y, --yes", "salta conferma interattiva")
  .action(async (folder: string, options: { yes?: boolean }) => runCommand(() => runPublish(folder, options)));

program
  .command("config:test")
  .description("Verifica token/config/policy/location con check read-only")
  .action(async () => runCommand(runConfigTest));

await program.parseAsync(process.argv);
