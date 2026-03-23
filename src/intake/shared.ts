import type { Draft, IntakeReport } from "../types.js";

export const roundMoney = (value: number): number => Number(value.toFixed(2));

export const makePriceSuggestion = (
  target: number,
  currency: string
): Pick<
  IntakeReport["pricing"],
  "suggested_target" | "suggested_quick_sale" | "suggested_floor" | "currency"
> => {
  return {
    suggested_target: roundMoney(target),
    suggested_quick_sale: roundMoney(Math.max(1, target * 0.9)),
    suggested_floor: roundMoney(Math.max(1, target * 0.8)),
    currency
  };
};

export const extractStructuredValue = (notes: string, labels: string[]): string | undefined => {
  const patterns = labels.map((label) => new RegExp(`^${label}:\\s*(.+)$`, "i"));
  for (const rawLine of notes.split(/\r?\n/)) {
    const line = rawLine.trim();
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match?.[1]?.trim()) {
        return match[1].trim();
      }
    }
  }

  return undefined;
};

export const extractReferenceNewPrice = (notes: string): number | undefined => {
  const patterns = [
    /(?:prezzo(?:\s+del)?\s+nuovo|prezzo nuovo|nuovo|listino|prezzo copertina|retail price)\s*[:=]?\s*(?:€|eur)?\s*(\d{1,4}(?:[\.,]\d{1,2})?)/i,
    /(?:€|eur)\s*(\d{1,4}(?:[\.,]\d{1,2})?)\s*(?:di\s+listino|del\s+nuovo|nuovo|copertina)\b/i
  ];

  for (const pattern of patterns) {
    const match = notes.match(pattern);
    if (!match) {
      continue;
    }

    const parsed = Number.parseFloat(match[1].replace(",", "."));
    if (Number.isFinite(parsed) && parsed > 0) {
      return roundMoney(parsed);
    }
  }

  return undefined;
};

export const detectConditionBucket = (
  draft: Draft,
  notes: string
): {
  bucket: "perfect" | "used" | "defect";
  discountPercent: 20 | 40 | 60;
} => {
  const haystack = `${draft.condition}\n${notes}`.toLowerCase();

  if (
    /\b(difett|strapp|macchi|piega|annotat|sottolineat|dann|rovinat|usurat|copertina rovinata|segni evidenti)\b/i.test(
      haystack
    ) ||
    /\bfor parts\b/i.test(haystack)
  ) {
    return { bucket: "defect", discountPercent: 60 };
  }

  if (/\b(like new|come nuovo|pari al nuovo|condizioni perfette|condizioni ottime|perfett[oaie])\b/i.test(haystack)) {
    return { bucket: "perfect", discountPercent: 20 };
  }

  return { bucket: "used", discountPercent: 40 };
};

export const hasDefectPhotoHint = (photoFiles: string[]): boolean => {
  return photoFiles.some((file) => /(difett|defect|damage|danno|rovin|usura|retro|back|detail)/i.test(file));
};

export const pickFieldValue = (
  ...candidates: Array<{
    value: string | undefined | null;
    source: "draft" | "notes" | "enrichment" | "derived";
  }>
): {
  value?: string;
  source?: "draft" | "notes" | "enrichment" | "derived";
} => {
  for (const candidate of candidates) {
    const value = candidate.value?.trim();
    if (!value) {
      continue;
    }

    return {
      value,
      source: candidate.source
    };
  }

  return {};
};

export const summarizeCompleteness = (
  searchFirst: string[],
  askUser: string[],
  blockers: string[]
): IntakeReport["summary"]["completeness"] => {
  if (blockers.length > 0) {
    return "blocked";
  }

  if (searchFirst.length > 0) {
    return "needs_search";
  }

  if (askUser.length > 0) {
    return "needs_user_input";
  }

  return "complete";
};
