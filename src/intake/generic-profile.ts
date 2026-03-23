import type { IntakeReport } from "../types.js";
import type { IntakeProfile } from "./modules.js";
import {
  detectConditionBucket,
  extractReferenceNewPrice,
  makePriceSuggestion,
  summarizeCompleteness
} from "./shared.js";

export const genericIntakeProfile: IntakeProfile = {
  id: "generic",
  label: "Generic object",
  buildReport(context) {
    const referenceNewPrice = extractReferenceNewPrice(context.notes);

    const fields: IntakeReport["fields"] = [
      {
        field: "title",
        label: "Titolo",
        status: context.currentDraft.title ? "present" : "missing",
        importance: "required",
        value: context.currentDraft.title || undefined,
        source: context.currentDraft.title ? "draft" : undefined,
        acquisition: {
          primary: "ask_user"
        }
      },
      {
        field: "condition",
        label: "Condizione reale",
        status: context.currentDraft.condition ? "present" : "missing",
        importance: "required",
        value: context.currentDraft.condition || undefined,
        source: context.currentDraft.condition ? "draft" : undefined,
        note: "La condizione reale va confermata dal venditore.",
        acquisition: {
          primary: "ask_user"
        }
      },
      {
        field: "category_hint",
        label: "Category hint",
        status: context.currentDraft.category_hint ? "present" : "missing",
        importance: "required",
        value: context.currentDraft.category_hint || undefined,
        source: context.currentDraft.category_hint ? "draft" : undefined,
        acquisition: {
          primary: "ask_user"
        }
      },
      {
        field: "shipping_profile",
        label: "Profilo spedizione",
        status: context.currentDraft.shipping_profile ? "present" : "missing",
        importance: "recommended",
        value: context.currentDraft.shipping_profile || undefined,
        source: context.currentDraft.shipping_profile ? "draft" : undefined,
        note: "Usato per selezionare la fulfillment policy corretta in publish/revise.",
        acquisition: {
          primary: "ask_user"
        }
      },
      {
        field: "reference_new_price",
        label: "Prezzo del nuovo",
        status: referenceNewPrice ? "present" : "missing",
        importance: "recommended",
        value: referenceNewPrice?.toFixed(2),
        source: referenceNewPrice ? "notes" : undefined,
        note: "Serve per proporre un prezzo consigliato automatico.",
        acquisition: {
          primary: "search_web",
          fallback: "ask_user"
        }
      },
      {
        field: "photos",
        label: "Foto",
        status: context.photoFiles.length > 0 ? "present" : "missing",
        importance: "required",
        value: context.photoFiles.length > 0 ? String(context.photoFiles.length) : undefined,
        source: context.photoFiles.length > 0 ? "derived" : undefined,
        acquisition: {
          primary: "ask_user"
        }
      }
    ];

    const searchFirst = fields
      .filter((field) => field.status !== "present" && field.acquisition.primary === "search_web")
      .map((field) => field.label);
    const askUser = fields
      .filter((field) => field.status !== "present" && field.acquisition.primary === "ask_user")
      .map((field) => field.label);
    const publishBlockers = fields
      .filter((field) => field.importance === "required" && field.status !== "present")
      .map((field) => field.label);

    const { bucket, discountPercent } = detectConditionBucket(context.currentDraft, context.notes);
    const currency = context.currentDraft.price.currency;
    const currentTarget = context.currentDraft.price.target;
    const suggestedTarget = referenceNewPrice
      ? referenceNewPrice * ((100 - discountPercent) / 100)
      : undefined;

    const priceSuggestion = suggestedTarget ? makePriceSuggestion(suggestedTarget, currency) : undefined;

    return {
      version: 1,
      generated_at: new Date().toISOString(),
      profile: "generic",
      fields,
      actions: [
        ...searchFirst.map((label) => ({
          kind: "search_web" as const,
          field: label,
          prompt: `Recupera dal web '${label}' e aggiornalo nel draft o nelle note.`,
          rationale: "Strategia predefinita: search first, ask user if incomplete.",
          search_queries: []
        })),
        ...askUser.map((label) => ({
          kind: "ask_user" as const,
          field: label,
          prompt: `Chiedi all'utente '${label}'.`,
          rationale: "Campo che dipende dalla conoscenza diretta del venditore.",
          search_queries: []
        }))
      ],
      pricing: {
        strategy: "reference_new_price_discount",
        condition_bucket: bucket,
        discount_percent: discountPercent,
        reference_new_price: referenceNewPrice,
        current_target: currentTarget,
        suggested_target: priceSuggestion?.suggested_target,
        suggested_quick_sale: priceSuggestion?.suggested_quick_sale,
        suggested_floor: priceSuggestion?.suggested_floor,
        delta_to_current_target:
          priceSuggestion?.suggested_target !== undefined
            ? Number((currentTarget - priceSuggestion.suggested_target).toFixed(2))
            : undefined,
        currency,
        ready: Boolean(priceSuggestion),
        note: priceSuggestion
          ? "Prezzo suggerito calcolato come prezzo del nuovo meno sconto condizione."
          : "Manca il prezzo del nuovo: cercalo prima sul web, poi chiedilo all'utente se non reperibile.",
        missing_inputs: priceSuggestion ? [] : ["reference_new_price"]
      },
      summary: {
        completeness: summarizeCompleteness(searchFirst, askUser, publishBlockers),
        search_first: searchFirst,
        ask_user: askUser,
        publish_blockers: publishBlockers
      }
    };
  }
};
