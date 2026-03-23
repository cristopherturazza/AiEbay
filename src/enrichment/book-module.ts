import type { Draft, EnrichmentReport } from "../types.js";
import {
  buildFallbackTitleFromSlug,
  buildPriceTriple,
  clampTitle,
  extractPriceFromNotes,
  inferCondition,
  normalizeLines
} from "./shared.js";
import type { EnrichmentConfidence, EnrichmentContext, EnrichmentModule } from "./modules.js";
import {
  assessBookShipping,
  normalizeBookBinding,
  parseBookShippingFactsFromNotes
} from "../shipping/book-logistics.js";

interface ExtractedBookMetadata {
  title?: string;
  subtitle?: string;
  author?: string;
  publisher?: string;
  publicationYear?: string;
  language?: string;
  format?: string;
  isbn?: string;
  subject?: string;
  pages?: string;
}

const formatConditionLabel = (condition: string): string => {
  switch (condition.trim().toLowerCase()) {
    case "like new":
    case "come nuovo":
      return "Come nuovo";
    case "used":
    case "usato":
      return "Usato";
    case "new":
    case "nuovo":
      return "Nuovo";
    default:
      return condition;
  }
};

const BOOK_KEYWORDS = [
  "libro",
  "libri",
  "isbn",
  "autore",
  "author",
  "editore",
  "publisher",
  "romanzo",
  "copertina",
  "paperback",
  "hardcover"
];

const FORMAT_PATTERNS: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /\b(copertina rigida|rigido|rilegato|hardcover)\b/i, value: "Copertina rigida" },
  { pattern: /\b(brossura|copertina flessibile|paperback)\b/i, value: "Brossura" }
];

const LANGUAGE_PATTERNS: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /\bitaliano\b/i, value: "Italiano" },
  { pattern: /\binglese\b/i, value: "Inglese" },
  { pattern: /\bfrancese\b/i, value: "Francese" },
  { pattern: /\btedesco\b/i, value: "Tedesco" },
  { pattern: /\bspagnolo\b/i, value: "Spagnolo" }
];

const normalizeIsbn = (raw: string): string | null => {
  const compact = raw.replace(/[^0-9X]/gi, "").toUpperCase();
  return compact.length === 10 || compact.length === 13 ? compact : null;
};

const extractIsbn = (notes: string): string | undefined => {
  const match = notes.match(/\b(?:97[89][\s-]*)?[0-9][0-9\s-]{7,}[0-9X]\b/i);
  if (!match) {
    return undefined;
  }

  return normalizeIsbn(match[0]) ?? undefined;
};

const firstValueByPatterns = (lines: string[], patterns: RegExp[]): string | undefined => {
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match?.[1]?.trim()) {
        return match[1].trim();
      }
    }
  }

  return undefined;
};

const extractTitle = (context: EnrichmentContext, lines: string[]): string => {
  const explicit = firstValueByPatterns(lines, [
    /^titolo:\s*(.+)$/i,
    /^title:\s*(.+)$/i,
    /^book title:\s*(.+)$/i
  ]);

  if (explicit) {
    return clampTitle(explicit);
  }

  for (const line of lines) {
    if (/^(autore|author|editore|publisher|isbn|lingua|language|anno|year|formato|format):/i.test(line)) {
      continue;
    }

    if (line.length >= 4) {
      return clampTitle(line);
    }
  }

  return clampTitle(buildFallbackTitleFromSlug(context.slug));
};

const extractBookMetadata = (context: EnrichmentContext): ExtractedBookMetadata => {
  const lines = normalizeLines(context.notes);
  const joined = [context.notes, ...context.photoFiles].join("\n");

  const publicationYear =
    firstValueByPatterns(lines, [/^(?:anno|year|publication year):\s*([12][0-9]{3})$/i]) ??
    joined.match(/\b(19[0-9]{2}|20[0-3][0-9])\b/)?.[1];

  const author = firstValueByPatterns(lines, [
    /^autore:\s*(.+)$/i,
    /^author:\s*(.+)$/i,
    /^di\s+(.+)$/i
  ]);
  const subtitle = firstValueByPatterns(lines, [
    /^sottotitolo:\s*(.+)$/i,
    /^subtitle:\s*(.+)$/i
  ]);

  const publisher = firstValueByPatterns(lines, [
    /^editore:\s*(.+)$/i,
    /^publisher:\s*(.+)$/i,
    /^published by:\s*(.+)$/i
  ]);

  const subject = firstValueByPatterns(lines, [/^(?:argomento|subject|topic|genere):\s*(.+)$/i]);
  const pages = firstValueByPatterns(lines, [/^(?:pagine|pages?):\s*([0-9]{1,5})$/i]);
  const format =
    firstValueByPatterns(lines, [/^(?:formato|format):\s*(.+)$/i]) ??
    FORMAT_PATTERNS.find(({ pattern }) => pattern.test(joined))?.value;
  const language =
    firstValueByPatterns(lines, [/^(?:lingua|language):\s*(.+)$/i]) ??
    LANGUAGE_PATTERNS.find(({ pattern }) => pattern.test(joined))?.value;

  return {
    title: extractTitle(context, lines),
    subtitle,
    author,
    publisher,
    publicationYear,
    language,
    format,
    isbn: extractIsbn(context.notes),
    subject,
    pages
  };
};

const inferBookCategoryHint = (metadata: ExtractedBookMetadata): string => {
  if (metadata.subject) {
    return `libri ${metadata.subject}`;
  }

  return "libri";
};

const buildBookSpecifics = (metadata: ExtractedBookMetadata): Record<string, string> => {
  const specifics: Record<string, string> = {};

  if (metadata.title) {
    specifics["Book Title"] = metadata.title;
  }
  if (metadata.author) {
    specifics.Author = metadata.author;
  }
  if (metadata.publisher) {
    specifics.Publisher = metadata.publisher;
  }
  if (metadata.language) {
    specifics.Language = metadata.language;
  }
  if (metadata.publicationYear) {
    specifics["Publication Year"] = metadata.publicationYear;
  }
  if (metadata.format) {
    specifics.Format = metadata.format;
  }
  if (metadata.isbn) {
    specifics.ISBN = metadata.isbn;
  }
  if (metadata.subject) {
    specifics.Topic = metadata.subject;
  }
  if (metadata.pages) {
    specifics.Pages = metadata.pages;
  }

  return specifics;
};

const estimateBookPrice = (context: EnrichmentContext, metadata: ExtractedBookMetadata): number => {
  const explicit = extractPriceFromNotes(context.notes);
  if (explicit) {
    return explicit;
  }

  if (metadata.format?.toLowerCase().includes("rigida") || metadata.format?.toLowerCase().includes("rilegato")) {
    return 18;
  }

  if (metadata.isbn) {
    return 14;
  }

  return 12;
};

const confidenceFromMetadata = (metadata: ExtractedBookMetadata): EnrichmentConfidence => {
  const populated = Object.values(metadata).filter(Boolean).length;

  if (populated >= 5) {
    return "high";
  }

  if (populated >= 3) {
    return "medium";
  }

  return "low";
};

const buildBookDescription = (
  metadata: ExtractedBookMetadata,
  fallbackTitle: string,
  condition: string
): string => {
  const label = formatConditionLabel(condition);
  const introParts = [
    metadata.title ?? fallbackTitle,
    metadata.author ? `di ${metadata.author}` : undefined
  ].filter(Boolean);

  const lines: string[] = [
    `${introParts.join(" ")}.`,
    label === "Come nuovo"
      ? "Libro usato in condizioni pari al nuovo, ben conservato e pronto per la lettura."
      : `Condizione del volume: ${label}.`
  ];

  const detailLines: string[] = [];
  if (metadata.subtitle) {
    detailLines.push(`Sottotitolo: ${metadata.subtitle}`);
  }
  if (metadata.publisher) {
    detailLines.push(`Editore: ${metadata.publisher}`);
  }
  if (metadata.publicationYear) {
    detailLines.push(`Anno di pubblicazione: ${metadata.publicationYear}`);
  }
  if (metadata.language) {
    detailLines.push(`Lingua: ${metadata.language}`);
  }
  if (metadata.format) {
    detailLines.push(`Formato: ${metadata.format}`);
  }
  if (metadata.isbn) {
    detailLines.push(`ISBN: ${metadata.isbn}`);
  }
  if (metadata.subject) {
    detailLines.push(`Argomento: ${metadata.subject}`);
  }

  if (detailLines.length > 0) {
    lines.push("");
    lines.push("Dettagli principali:");
    lines.push(...detailLines.map((detail) => `- ${detail}`));
  }

  lines.push("");
  lines.push("Le foto mostrano il libro effettivamente in vendita e fanno parte della descrizione.");

  return lines.join("\n");
};

const buildEvidence = (metadata: ExtractedBookMetadata, confidence: EnrichmentConfidence): EnrichmentReport["evidence"] => {
  const evidence: EnrichmentReport["evidence"] = [];

  const add = (
    field: string,
    value: string | undefined,
    source: "notes" | "derived" = "notes"
  ): void => {
    if (!value) {
      return;
    }

    evidence.push({ field, value, source, confidence });
  };

  add("title", metadata.title, "derived");
  add("subtitle", metadata.subtitle);
  add("author", metadata.author);
  add("publisher", metadata.publisher);
  add("publicationYear", metadata.publicationYear);
  add("language", metadata.language);
  add("format", metadata.format);
  add("isbn", metadata.isbn);
  add("subject", metadata.subject);
  add("pages", metadata.pages);

  return evidence;
};

const compactExtracted = (input: Record<string, string | undefined>): Record<string, string> => {
  const extracted: Record<string, string> = {};

  for (const [key, value] of Object.entries(input)) {
    if (!value) {
      continue;
    }

    extracted[key] = value;
  }

  return extracted;
};

export const bookEnrichmentModule: EnrichmentModule = {
  id: "book",
  label: "Book listing",
  canHandle(context): number {
    const haystack = [context.slug, context.notes, ...context.photoFiles].join(" ").toLowerCase();

    let score = 0;
    for (const keyword of BOOK_KEYWORDS) {
      if (haystack.includes(keyword)) {
        score += 0.15;
      }
    }

    if (extractIsbn(context.notes)) {
      score += 0.5;
    }

    return Math.min(score, 1);
  },
  enrich(context) {
    const metadata = extractBookMetadata(context);
    const fallbackTitle = buildFallbackTitleFromSlug(context.slug);
    const condition = inferCondition(context.notes);
    const price = buildPriceTriple(estimateBookPrice(context, metadata));
    const confidence = confidenceFromMetadata(metadata);
    const shippingFacts = parseBookShippingFactsFromNotes(context.notes, {
      format: metadata.format,
      pages: metadata.pages
    });
    const shippingAssessment = assessBookShipping({
      ...shippingFacts,
      binding: shippingFacts.binding ?? normalizeBookBinding(metadata.format)
    });

    const draft: Draft = {
      title: clampTitle(metadata.title ?? fallbackTitle),
      description: buildBookDescription(metadata, fallbackTitle, condition),
      shipping_profile: shippingAssessment.profile ?? "book",
      shipping: {
        ...(shippingFacts.weight_g !== undefined ? { weight_g: shippingFacts.weight_g } : {}),
        ...(shippingFacts.thickness_cm !== undefined ? { thickness_cm: shippingFacts.thickness_cm } : {}),
        ...(shippingFacts.pages !== undefined ? { pages: shippingFacts.pages } : {}),
        ...(shippingFacts.binding !== undefined ? { binding: shippingFacts.binding } : {})
      },
      condition,
      price,
      category_hint: inferBookCategoryHint(metadata),
      item_specifics: buildBookSpecifics(metadata)
    };

    const warnings: string[] = [];
    if (!metadata.isbn) {
      warnings.push("ISBN non rilevato: utile aggiungerlo manualmente o ricavarlo da foto fronte/retro/copyright.");
    }
    if (!metadata.author) {
      warnings.push("Autore non rilevato con confidenza sufficiente.");
    }
    if (!metadata.publisher || !metadata.publicationYear) {
      warnings.push("Editore o anno mancanti: controlla frontespizio o pagina copyright.");
    }
    if (shippingAssessment.profile === "book_heavy") {
      warnings.push(
        `Profilo spedizione suggerito: book_heavy (${shippingAssessment.reasons.join("; ")}).`
      );
    } else if (shippingAssessment.should_ask_user) {
      warnings.push(
        "Dati spedizione incompleti: misura peso e spessore se il libro rischia di uscire dal profilo standard."
      );
    }

    return {
      draft,
      report: {
        version: 1,
        generated_at: new Date().toISOString(),
        module: "book",
        confidence,
        extracted: compactExtracted({
          title: metadata.title,
          subtitle: metadata.subtitle,
          author: metadata.author,
          publisher: metadata.publisher,
          publicationYear: metadata.publicationYear,
          language: metadata.language,
          format: metadata.format,
          isbn: metadata.isbn,
          subject: metadata.subject,
          pages: metadata.pages,
          ...(shippingFacts.weight_g !== undefined ? { shippingWeightG: shippingFacts.weight_g.toFixed(0) } : {}),
          ...(shippingFacts.thickness_cm !== undefined
            ? { shippingThicknessCm: shippingFacts.thickness_cm.toFixed(2) }
            : {}),
          ...(shippingFacts.binding !== undefined ? { shippingBinding: shippingFacts.binding } : {}),
          ...(shippingAssessment.profile ? { shippingProfileSuggested: shippingAssessment.profile } : {})
        }),
        warnings,
        evidence: buildEvidence(metadata, confidence),
        draft_preview: draft
      }
    };
  }
};
