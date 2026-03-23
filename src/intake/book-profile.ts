import type { Draft, IntakeReport } from "../types.js";
import type { IntakeProfile } from "./modules.js";
import {
  detectConditionBucket,
  extractReferenceNewPrice,
  extractStructuredValue,
  hasDefectPhotoHint,
  makePriceSuggestion,
  pickFieldValue,
  summarizeCompleteness
} from "./shared.js";
import {
  assessBookShipping,
  extractBookShippingFactsFromDraft,
  normalizeBookBinding
} from "../shipping/book-logistics.js";

const buildSearchQueries = (
  draft: Draft,
  field: string,
  fallbackTitle?: string,
  author?: string,
  isbn?: string
): string[] => {
  const title = draft.title || fallbackTitle || "";
  const base = [title, author].filter(Boolean).join(" ").trim();
  const byIsbn = isbn ? [isbn] : [];

  switch (field) {
    case "isbn":
      return [...byIsbn, `${base} ISBN`, `${base} editore ISBN`].filter(Boolean);
    case "publisher":
      return [...byIsbn, `${base} editore`, `${base} publisher`].filter(Boolean);
    case "publication_year":
      return [...byIsbn, `${base} anno pubblicazione`, `${base} publication year`].filter(Boolean);
    case "format":
      return [...byIsbn, `${base} copertina flessibile`, `${base} paperback`].filter(Boolean);
    case "pages":
      return [...byIsbn, `${base} numero pagine`, `${base} pages`].filter(Boolean);
    case "binding":
      return [...byIsbn, `${base} copertina flessibile`, `${base} copertina rigida`, `${base} binding`].filter(
        Boolean
      );
    case "reference_new_price":
      return [...byIsbn, `${base} prezzo nuovo`, `${base} prezzo copertina`].filter(Boolean);
    default:
      return [...byIsbn, base].filter(Boolean);
  }
};

export const bookIntakeProfile: IntakeProfile = {
  id: "book",
  label: "Book",
  buildReport(context) {
    const extracted = context.enrichmentReport.extracted;
    const author = pickFieldValue(
      { value: context.currentDraft.item_specifics.Author, source: "draft" },
      { value: extracted.author, source: "enrichment" }
    );
    const isbn = pickFieldValue(
      { value: context.currentDraft.item_specifics.ISBN, source: "draft" },
      { value: extracted.isbn, source: "enrichment" }
    );
    const publisher = pickFieldValue(
      { value: context.currentDraft.item_specifics.Publisher, source: "draft" },
      { value: extracted.publisher, source: "enrichment" }
    );
    const publicationYear = pickFieldValue(
      { value: context.currentDraft.item_specifics["Publication Year"], source: "draft" },
      { value: extracted.publicationYear, source: "enrichment" }
    );
    const language = pickFieldValue(
      { value: context.currentDraft.item_specifics.Language, source: "draft" },
      { value: extracted.language, source: "enrichment" }
    );
    const format = pickFieldValue(
      { value: context.currentDraft.item_specifics.Format, source: "draft" },
      { value: extracted.format, source: "enrichment" }
    );
    const topic = pickFieldValue(
      { value: context.currentDraft.item_specifics.Topic, source: "draft" },
      { value: extracted.subject, source: "enrichment" }
    );
    const subtitle = pickFieldValue({ value: extracted.subtitle, source: "enrichment" });
    const pages = pickFieldValue(
      { value: context.currentDraft.shipping?.pages?.toString(), source: "draft" },
      { value: context.currentDraft.item_specifics.Pages, source: "draft" },
      { value: extracted.pages, source: "enrichment" }
    );
    const binding = pickFieldValue(
      { value: context.currentDraft.shipping?.binding, source: "draft" },
      { value: normalizeBookBinding(context.currentDraft.item_specifics.Format)?.toString(), source: "derived" },
      { value: normalizeBookBinding(extracted.format)?.toString(), source: "derived" }
    );
    const weight = pickFieldValue({
      value: context.currentDraft.shipping?.weight_g?.toString(),
      source: "draft"
    });
    const thickness = pickFieldValue({
      value: context.currentDraft.shipping?.thickness_cm?.toString(),
      source: "draft"
    });
    const referenceNewPrice =
      extractReferenceNewPrice(context.notes) ??
      Number.parseFloat(extractStructuredValue(context.notes, ["Prezzo nuovo", "Prezzo del nuovo"]) ?? "");
    const defectText = extractStructuredValue(context.notes, ["Difetti", "Difetto", "Defects"]);
    const conditionProvided = Boolean(context.currentDraft.condition);
    const { bucket, discountPercent } = detectConditionBucket(context.currentDraft, context.notes);
    const currency = context.currentDraft.price.currency;
    const currentTarget = context.currentDraft.price.target;
    const suggestedTarget = Number.isFinite(referenceNewPrice)
      ? Number(referenceNewPrice) * ((100 - discountPercent) / 100)
      : undefined;
    const pricing = suggestedTarget ? makePriceSuggestion(suggestedTarget, currency) : undefined;
    const shippingFacts = extractBookShippingFactsFromDraft(context.currentDraft);
    const shippingAssessment = assessBookShipping(shippingFacts);
    const explicitShippingProfile = context.currentDraft.shipping_profile?.trim();
    const resolvedShippingProfile = explicitShippingProfile ?? shippingAssessment.profile;
    const shippingProfileStatus = explicitShippingProfile
      ? "present"
      : shippingAssessment.profile
        ? "uncertain"
        : "missing";
    const shippingProfileNote = explicitShippingProfile
      ? "Profilo impostato nel draft."
      : shippingAssessment.profile
        ? `Profilo suggerito: ${shippingAssessment.profile}. ${shippingAssessment.reasons.join(" ")}`
        : "Peso/spessore insufficienti per scegliere con confidenza tra book e book_heavy.";

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
        field: "author",
        label: "Autore",
        status: author.value ? "present" : "missing",
        importance: "required",
        value: author.value,
        source: author.source,
        acquisition: {
          primary: "search_web",
          fallback: "ask_user"
        }
      },
      {
        field: "condition",
        label: "Condizione reale",
        status: conditionProvided ? "present" : "missing",
        importance: "required",
        value: conditionProvided ? context.currentDraft.condition : undefined,
        source: conditionProvided ? "draft" : undefined,
        note: "La condizione reale va confermata dal venditore. Se c'e' un difetto, deve essere mostrato in foto.",
        acquisition: {
          primary: "ask_user"
        }
      },
      {
        field: "shipping_profile",
        label: "Profilo spedizione",
        status: shippingProfileStatus,
        importance: "recommended",
        value: resolvedShippingProfile,
        source: explicitShippingProfile ? "draft" : shippingAssessment.profile ? "derived" : undefined,
        note: shippingProfileNote,
        acquisition: {
          primary: explicitShippingProfile || shippingAssessment.profile ? "derive" : "ask_user"
        }
      },
      {
        field: "isbn",
        label: "ISBN",
        status: isbn.value ? "present" : "missing",
        importance: "recommended",
        value: isbn.value,
        source: isbn.source,
        acquisition: {
          primary: "search_web",
          fallback: "ask_user"
        }
      },
      {
        field: "publisher",
        label: "Editore",
        status: publisher.value ? "present" : "missing",
        importance: "recommended",
        value: publisher.value,
        source: publisher.source,
        acquisition: {
          primary: "search_web",
          fallback: "ask_user"
        }
      },
      {
        field: "publication_year",
        label: "Anno di pubblicazione",
        status: publicationYear.value ? "present" : "missing",
        importance: "recommended",
        value: publicationYear.value,
        source: publicationYear.source,
        acquisition: {
          primary: "search_web",
          fallback: "ask_user"
        }
      },
      {
        field: "language",
        label: "Lingua",
        status: language.value ? "present" : "missing",
        importance: "recommended",
        value: language.value,
        source: language.source,
        acquisition: {
          primary: "search_web",
          fallback: "ask_user"
        }
      },
      {
        field: "format",
        label: "Formato",
        status: format.value ? "present" : "missing",
        importance: "recommended",
        value: format.value,
        source: format.source,
        acquisition: {
          primary: "search_web",
          fallback: "ask_user"
        }
      },
      {
        field: "binding",
        label: "Rilegatura",
        status: binding.value ? "present" : "missing",
        importance: "recommended",
        value: binding.value,
        source: binding.source,
        note: "Serve come indizio logistico: hardcover tende verso profilo book_heavy.",
        acquisition: {
          primary: "search_web",
          fallback: "ask_user"
        }
      },
      {
        field: "pages",
        label: "Numero pagine",
        status: pages.value ? "present" : "missing",
        importance: "recommended",
        value: pages.value,
        source: pages.source,
        note: "Utile per stimare peso e scegliere il profilo spedizione quando mancano misure dirette.",
        acquisition: {
          primary: "search_web",
          fallback: "ask_user"
        }
      },
      {
        field: "weight_g",
        label: "Peso (g)",
        status: weight.value ? "present" : shippingAssessment.profile ? "uncertain" : "missing",
        importance: "recommended",
        value: weight.value,
        source: weight.source,
        note: "Misura reale utile se il libro e' vicino alla soglia tra book e book_heavy.",
        acquisition: {
          primary: shippingAssessment.should_ask_user ? "ask_user" : "derive"
        }
      },
      {
        field: "thickness_cm",
        label: "Spessore (cm)",
        status: thickness.value ? "present" : shippingAssessment.profile ? "uncertain" : "missing",
        importance: "recommended",
        value: thickness.value,
        source: thickness.source,
        note: "IT_Posta1 ha una soglia pratica a 2.5 cm: oltre conviene usare book_heavy.",
        acquisition: {
          primary: shippingAssessment.should_ask_user ? "ask_user" : "derive"
        }
      },
      {
        field: "topic",
        label: "Argomento",
        status: topic.value ? "present" : "missing",
        importance: "recommended",
        value: topic.value,
        source: topic.source,
        acquisition: {
          primary: "search_web",
          fallback: "ask_user"
        }
      },
      {
        field: "subtitle",
        label: "Sottotitolo",
        status: subtitle.value ? "present" : "missing",
        importance: "optional",
        value: subtitle.value,
        source: subtitle.source,
        acquisition: {
          primary: "search_web",
          fallback: "ask_user"
        }
      },
      {
        field: "reference_new_price",
        label: "Prezzo del nuovo",
        status: Number.isFinite(referenceNewPrice) ? "present" : "missing",
        importance: "recommended",
        value: Number.isFinite(referenceNewPrice) ? Number(referenceNewPrice).toFixed(2) : undefined,
        source: Number.isFinite(referenceNewPrice) ? "notes" : undefined,
        note: "Usato per suggerire il prezzo target con sconto standard.",
        acquisition: {
          primary: "search_web",
          fallback: "ask_user"
        }
      },
      {
        field: "defect_details",
        label: "Difetti presenti",
        status: bucket === "defect" ? "present" : "uncertain",
        importance: "recommended",
        value: defectText ?? (bucket === "defect" ? "Segnalati nei metadati/condizione." : undefined),
        source: defectText ? "notes" : bucket === "defect" ? "derived" : undefined,
        note: bucket === "defect" ? "Serve una foto chiara del difetto." : "Se il libro e' davvero come nuovo, nessun difetto da documentare.",
        acquisition: {
          primary: "ask_user"
        }
      }
    ];

    const searchActions = fields
      .filter((field) => field.status === "missing" && field.acquisition.primary === "search_web")
      .map((field) => ({
        kind: "search_web" as const,
        field: field.field,
        prompt: `Recupera '${field.label}' prima dal web, poi aggiorna draft/note se verificato.`,
        rationale: "Strategia predefinita: search first, ask user if incomplete.",
        search_queries: buildSearchQueries(
          context.currentDraft,
          field.field,
          extracted.title,
          author.value,
          isbn.value
        )
      }));

    const askActions = fields
      .filter((field) => field.status !== "present" && field.acquisition.primary === "ask_user")
      .map((field) => ({
        kind: "ask_user" as const,
        field: field.field,
        prompt: `Chiedi all'utente '${field.label}'.`,
        rationale: field.note,
        search_queries: []
      }));

    const defectPhotoNeeded = bucket === "defect" && !hasDefectPhotoHint(context.photoFiles);
    const actions: IntakeReport["actions"] = [
      ...searchActions,
      ...askActions,
      ...(searchActions.some((action) => action.field === "reference_new_price")
        ? [
            {
              kind: "ask_user" as const,
              field: "reference_new_price",
              prompt: "Se il prezzo del nuovo non emerge dal web, chiedilo all'utente.",
              rationale: "Serve per proporre il prezzo consigliato automatico.",
              search_queries: []
            }
          ]
        : []),
      ...(defectPhotoNeeded
        ? [
            {
              kind: "add_photo" as const,
              field: "defect_photo",
              prompt: "Aggiungi almeno una foto ravvicinata del difetto prima della pubblicazione.",
              rationale: "La strategia prezzo -60% richiede difetto visibile e documentato.",
              search_queries: []
            }
          ]
        : [])
    ];

    const searchFirst = actions.filter((action) => action.kind === "search_web").map((action) => action.field);
    const askUser = actions
      .filter((action) => action.kind === "ask_user" || action.kind === "add_photo")
      .map((action) => action.field);
    const publishBlockers = [
      ...(context.photoFiles.length === 0 ? ["photos"] : []),
      ...fields
        .filter((field) => field.importance === "required" && field.status !== "present")
        .map((field) => field.field),
      ...(defectPhotoNeeded ? ["defect_photo"] : []),
      ...(shippingProfileStatus === "missing" ? ["shipping_profile"] : [])
    ];

    return {
      version: 1,
      generated_at: new Date().toISOString(),
      profile: "book",
      fields,
      actions,
      pricing: {
        strategy: "reference_new_price_discount",
        condition_bucket: bucket,
        discount_percent: discountPercent,
        reference_new_price: Number.isFinite(referenceNewPrice) ? Number(referenceNewPrice) : undefined,
        current_target: currentTarget,
        suggested_target: pricing?.suggested_target,
        suggested_quick_sale: pricing?.suggested_quick_sale,
        suggested_floor: pricing?.suggested_floor,
        delta_to_current_target:
          pricing?.suggested_target !== undefined
            ? Number((currentTarget - pricing.suggested_target).toFixed(2))
            : undefined,
        currency,
        ready: Boolean(pricing),
        note: pricing
          ? `Prezzo suggerito: nuovo - ${discountPercent}% in base alla condizione '${bucket}'. L'utente puo' comunque impostare un target diverso.`
          : "Manca il prezzo del nuovo: cerca prima sul web, poi chiedilo all'utente se non reperibile.",
        missing_inputs: pricing ? [] : ["reference_new_price"]
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
