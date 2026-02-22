import type { Draft } from "../types.js";

export interface DraftSeedInput {
  slug: string;
  notes: string;
  photoFiles: string[];
}

const extractPriceFromNotes = (notes: string): number | null => {
  const match = notes.match(/(?:€|eur\s*)?(\d{1,4}(?:[\.,]\d{1,2})?)/i);
  if (!match) {
    return null;
  }

  const raw = match[1].replace(",", ".");
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
};

const extractSpecifics = (notes: string): Record<string, string> => {
  const specifics: Record<string, string> = {};
  const lines = notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const pair = line.match(/^([A-Za-zÀ-ÿ0-9\s\-_]{2,40}):\s*(.{1,120})$/);
    if (!pair) {
      continue;
    }

    const key = pair[1].trim();
    const value = pair[2].trim();
    specifics[key] = value;
  }

  return specifics;
};

const inferCondition = (notes: string): string => {
  const normalized = notes.toLowerCase();

  if (normalized.includes("nuovo") || normalized.includes("new")) {
    return "New";
  }

  if (normalized.includes("ricambi") || normalized.includes("for parts")) {
    return "For parts";
  }

  return "Used";
};

export const generateDraftFromNotes = (input: DraftSeedInput): Draft => {
  const notesLines = input.notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const fallbackTitle = input.slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const titleRaw = notesLines[0] ?? fallbackTitle;
  const title = titleRaw.length > 80 ? titleRaw.slice(0, 80).trimEnd() : titleRaw;

  const basePrice = extractPriceFromNotes(input.notes) ?? 50;
  const quickSale = Math.max(1, Number((basePrice * 0.9).toFixed(2)));
  const floor = Math.max(1, Number((basePrice * 0.8).toFixed(2)));

  const descriptionLines: string[] = [];
  if (notesLines.length > 0) {
    descriptionLines.push(...notesLines);
  } else {
    descriptionLines.push(`Oggetto: ${fallbackTitle}`);
  }

  descriptionLines.push("");
  descriptionLines.push(`Foto disponibili: ${input.photoFiles.join(", ")}`);
  descriptionLines.push("Inserzione generata automaticamente, verificare dettagli e prezzo prima della pubblicazione.");

  return {
    title,
    description: descriptionLines.join("\n"),
    condition: inferCondition(input.notes),
    price: {
      target: Number(basePrice.toFixed(2)),
      quick_sale: Number(quickSale.toFixed(2)),
      floor: Number(floor.toFixed(2)),
      currency: "EUR"
    },
    category_hint: fallbackTitle,
    item_specifics: extractSpecifics(input.notes)
  };
};
