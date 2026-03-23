import type { Draft } from "../types.js";

export interface DraftSeedInput {
  slug: string;
  notes: string;
  photoFiles: string[];
}

export const normalizeLines = (input: string): string[] => {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
};

export const buildFallbackTitleFromSlug = (slug: string): string => {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

export const clampTitle = (value: string, maxLength = 80): string => {
  return value.length > maxLength ? value.slice(0, maxLength).trimEnd() : value;
};

export const extractPriceFromNotes = (notes: string): number | null => {
  const patterns = [
    /(?:prezzo(?:\s+target)?|price(?:\s+target)?|target|quick[_\s-]?sale|vendita veloce|floor)\s*[:=]?\s*(?:€|eur)?\s*(\d{1,4}(?:[\.,]\d{1,2})?)/i,
    /(?:€|eur)\s*(\d{1,4}(?:[\.,]\d{1,2})?)/i,
    /(\d{1,4}(?:[\.,]\d{1,2})?)\s*(?:€|eur)\b/i
  ];

  for (const pattern of patterns) {
    const match = notes.match(pattern);
    if (!match) {
      continue;
    }

    const raw = match[1].replace(",", ".");
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
};

export const extractSpecifics = (notes: string): Record<string, string> => {
  const specifics: Record<string, string> = {};

  for (const line of normalizeLines(notes)) {
    const pair = line.match(/^([A-Za-zÀ-ÿ0-9\s\-_]{2,40}):\s*(.{1,120})$/);
    if (!pair) {
      continue;
    }

    specifics[pair[1].trim()] = pair[2].trim();
  }

  return specifics;
};

export const inferCondition = (notes: string): Draft["condition"] => {
  const normalized = notes.toLowerCase();

  if (/\bcome nuovo\b/i.test(normalized) || /\blike new\b/i.test(normalized)) {
    return "Like New";
  }

  if (/\bnuov[oaie]?\b/i.test(normalized) || /\bnew\b/i.test(normalized)) {
    return "New";
  }

  if (/\bricambi\b/i.test(normalized) || /\bfor parts\b/i.test(normalized)) {
    return "For parts";
  }

  return "Used";
};

export const buildPriceTriple = (basePrice: number): Draft["price"] => {
  const quickSale = Math.max(1, Number((basePrice * 0.9).toFixed(2)));
  const floor = Math.max(1, Number((basePrice * 0.8).toFixed(2)));

  return {
    target: Number(basePrice.toFixed(2)),
    quick_sale: Number(quickSale.toFixed(2)),
    floor: Number(floor.toFixed(2)),
    currency: "EUR"
  };
};
