import type { Draft } from "../types.js";
import {
  buildFallbackTitleFromSlug,
  buildPriceTriple,
  clampTitle,
  extractPriceFromNotes,
  extractSpecifics,
  inferCondition,
  normalizeLines,
  type DraftSeedInput
} from "../enrichment/shared.js";
import { parseBookShippingFactsFromNotes } from "../shipping/book-logistics.js";

export const generateDraftFromNotes = (input: DraftSeedInput): Draft => {
  const notesLines = normalizeLines(input.notes);
  const fallbackTitle = buildFallbackTitleFromSlug(input.slug);
  const title = clampTitle(notesLines[0] ?? fallbackTitle);

  const basePrice = extractPriceFromNotes(input.notes) ?? 50;
  const shippingFacts = parseBookShippingFactsFromNotes(input.notes);

  const descriptionLines: string[] = [];
  if (notesLines.length > 0) {
    descriptionLines.push(...notesLines);
  } else {
    descriptionLines.push(`Oggetto: ${fallbackTitle}`);
  }

  descriptionLines.push("");
  descriptionLines.push("Le foto mostrano l'oggetto effettivamente in vendita.");
  descriptionLines.push("Verificare dettagli, condizioni e accessori inclusi prima della pubblicazione.");

  return {
    title,
    description: descriptionLines.join("\n"),
    ...(shippingFacts.weight_g !== undefined ||
    shippingFacts.thickness_cm !== undefined ||
    shippingFacts.pages !== undefined ||
    shippingFacts.binding !== undefined
      ? {
          shipping: {
            ...(shippingFacts.weight_g !== undefined ? { weight_g: shippingFacts.weight_g } : {}),
            ...(shippingFacts.thickness_cm !== undefined ? { thickness_cm: shippingFacts.thickness_cm } : {}),
            ...(shippingFacts.pages !== undefined ? { pages: shippingFacts.pages } : {}),
            ...(shippingFacts.binding !== undefined ? { binding: shippingFacts.binding } : {})
          }
        }
      : {}),
    condition: inferCondition(input.notes),
    price: buildPriceTriple(basePrice),
    category_hint: fallbackTitle,
    item_specifics: extractSpecifics(input.notes)
  };
};
