import type { Draft } from "../types.js";

export type BookBinding = "paperback" | "hardcover";
export type BookShippingProfile = "book" | "book_heavy";

export interface BookShippingFacts {
  weight_g?: number;
  thickness_cm?: number;
  pages?: number;
  binding?: BookBinding;
}

export interface BookShippingAssessment {
  profile?: BookShippingProfile;
  confidence: "low" | "medium" | "high";
  reasons: string[];
  missing_inputs: Array<"weight_g" | "thickness_cm" | "pages" | "binding">;
  should_ask_user: boolean;
}

const roundMoneyless = (value: number): number => Number(value.toFixed(2));

const normalizePositiveNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = Number.parseFloat(value.replace(",", ".").trim());
  return Number.isFinite(normalized) && normalized > 0 ? normalized : undefined;
};

const parsePageCount = (value: unknown): number | undefined => {
  const parsed = normalizePositiveNumber(value);
  if (!parsed) {
    return undefined;
  }

  return Number.isInteger(parsed) ? parsed : Math.round(parsed);
};

export const normalizeBookBinding = (value: string | undefined): BookBinding | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (/(paperback|brossura|copertina flessibile|softcover)/i.test(normalized)) {
    return "paperback";
  }

  if (/(hardcover|copertina rigida|rilegato|cartonato)/i.test(normalized)) {
    return "hardcover";
  }

  return undefined;
};

export const parseBookShippingFactsFromNotes = (
  notes: string,
  fallback?: {
    format?: string;
    pages?: string;
  }
): BookShippingFacts => {
  const weightMatch = notes.match(
    /(?:^|\b)(?:peso|weight)\s*[:=]?\s*(\d{1,5}(?:[.,]\d{1,2})?)\s*(kg|g)\b/im
  );
  const thicknessMatch = notes.match(
    /(?:^|\b)(?:spessore|thickness)\s*[:=]?\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*(cm|mm)\b/im
  );
  const pagesMatch = notes.match(/(?:^|\b)(?:pagine|pages?)\s*[:=]?\s*(\d{1,5})\b/im);
  const bindingMatch = notes.match(
    /(?:^|\b)(?:rilegatura|binding|formato)\s*[:=]?\s*(paperback|brossura|copertina flessibile|softcover|hardcover|copertina rigida|rilegato|cartonato)\b/im
  );

  const weightValue = weightMatch ? normalizePositiveNumber(weightMatch[1]) : undefined;
  const weightUnit = weightMatch?.[2]?.toLowerCase();
  const thicknessValue = thicknessMatch ? normalizePositiveNumber(thicknessMatch[1]) : undefined;
  const thicknessUnit = thicknessMatch?.[2]?.toLowerCase();

  return {
    weight_g:
      weightValue !== undefined
        ? roundMoneyless(weightUnit === "kg" ? weightValue * 1000 : weightValue)
        : undefined,
    thickness_cm:
      thicknessValue !== undefined
        ? roundMoneyless(thicknessUnit === "mm" ? thicknessValue / 10 : thicknessValue)
        : undefined,
    pages: parsePageCount(pagesMatch?.[1] ?? fallback?.pages),
    binding: normalizeBookBinding(bindingMatch?.[1] ?? fallback?.format)
  };
};

const getSpecificValue = (draft: Draft, keys: string[]): string | undefined => {
  for (const key of keys) {
    const direct = draft.item_specifics[key];
    if (direct?.trim()) {
      return direct.trim();
    }
  }

  const lowerLookup = new Map(
    Object.entries(draft.item_specifics).map(([key, value]) => [key.trim().toLowerCase(), value])
  );
  for (const key of keys) {
    const match = lowerLookup.get(key.trim().toLowerCase());
    if (match?.trim()) {
      return match.trim();
    }
  }

  return undefined;
};

export const looksLikeBookDraft = (draft: Draft): boolean => {
  const haystack = [
    draft.category_hint,
    draft.title,
    draft.item_specifics["Book Title"],
    draft.item_specifics.Author,
    draft.item_specifics.Publisher,
    draft.item_specifics.ISBN
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /\b(libro|libri|book|books|isbn|autore|author|publisher|editore)\b/i.test(haystack);
};

export const extractBookShippingFactsFromDraft = (draft: Draft): BookShippingFacts => {
  const shipping = draft.shipping;
  const format = getSpecificValue(draft, ["Format", "formato", "Binding", "binding"]);
  const pages = getSpecificValue(draft, ["Pages", "Number of Pages", "Pagine", "Numero di pagine"]);

  return {
    weight_g: shipping?.weight_g,
    thickness_cm: shipping?.thickness_cm,
    pages: shipping?.pages ?? parsePageCount(pages),
    binding: shipping?.binding ?? normalizeBookBinding(format)
  };
};

export const assessBookShipping = (facts: BookShippingFacts): BookShippingAssessment => {
  const reasons: string[] = [];
  const missing_inputs: Array<"weight_g" | "thickness_cm" | "pages" | "binding"> = [];

  if (!facts.weight_g) {
    missing_inputs.push("weight_g");
  }
  if (!facts.thickness_cm) {
    missing_inputs.push("thickness_cm");
  }
  if (!facts.pages) {
    missing_inputs.push("pages");
  }
  if (!facts.binding) {
    missing_inputs.push("binding");
  }

  if (facts.thickness_cm !== undefined && facts.thickness_cm > 2.5) {
    reasons.push("spessore oltre 2.5 cm: supera il limite tipico del profilo book / IT_Posta1");
    return {
      profile: "book_heavy",
      confidence: "high",
      reasons,
      missing_inputs,
      should_ask_user: false
    };
  }

  if (facts.weight_g !== undefined && facts.weight_g > 500) {
    reasons.push("peso oltre 500 g: prudenzialmente gestito come book_heavy");
    return {
      profile: "book_heavy",
      confidence: "high",
      reasons,
      missing_inputs,
      should_ask_user: false
    };
  }

  if (facts.weight_g !== undefined && facts.thickness_cm !== undefined) {
    reasons.push("peso e spessore dentro soglia standard");
    return {
      profile: "book",
      confidence: "high",
      reasons,
      missing_inputs,
      should_ask_user: false
    };
  }

  if (facts.binding === "hardcover") {
    reasons.push("copertina rigida: prudenzialmente gestito come book_heavy");
    return {
      profile: "book_heavy",
      confidence: facts.pages ? "medium" : "low",
      reasons,
      missing_inputs,
      should_ask_user: facts.weight_g === undefined || facts.thickness_cm === undefined
    };
  }

  if (facts.pages !== undefined && facts.pages >= 450) {
    reasons.push("numero pagine elevato: probabile volume pesante");
    return {
      profile: "book_heavy",
      confidence: facts.binding ? "medium" : "low",
      reasons,
      missing_inputs,
      should_ask_user: facts.weight_g === undefined || facts.thickness_cm === undefined
    };
  }

  if (facts.pages !== undefined && facts.pages <= 320 && facts.binding === "paperback") {
    reasons.push("paperback con paginazione contenuta: probabile profilo book");
    return {
      profile: "book",
      confidence: "medium",
      reasons,
      missing_inputs,
      should_ask_user: facts.weight_g === undefined && facts.thickness_cm === undefined
    };
  }

  return {
    confidence: "low",
    reasons,
    missing_inputs,
    should_ask_user: true
  };
};

export const deriveDraftShippingProfile = (draft: Draft): string | undefined => {
  if (draft.shipping_profile?.trim()) {
    return draft.shipping_profile.trim();
  }

  if (!looksLikeBookDraft(draft)) {
    return undefined;
  }

  return assessBookShipping(extractBookShippingFactsFromDraft(draft)).profile;
};
