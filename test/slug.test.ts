import { describe, expect, it } from "vitest";
import { isValidSlug, slugifyTitle } from "../src/utils/slug.js";

describe("slugifyTitle", () => {
  it("normalizza titolo semplice", () => {
    expect(slugifyTitle("Il Nome della Rosa")).toBe("il-nome-della-rosa");
  });

  it("rimuove accenti", () => {
    expect(slugifyTitle("Perché un buon caffè")).toBe("perche-un-buon-caffe");
  });

  it("collassa caratteri non alfanumerici", () => {
    expect(slugifyTitle("100% — guida (2024)!!!")).toBe("100-guida-2024");
  });

  it("ritorna 'listing' per titolo vuoto/non sluggable", () => {
    expect(slugifyTitle("")).toBe("listing");
    expect(slugifyTitle("   ")).toBe("listing");
    expect(slugifyTitle("---")).toBe("listing");
    expect(slugifyTitle("???")).toBe("listing");
  });

  it("tronca su trattino quando supera 60 char", () => {
    const longTitle = "Un titolo molto lungo che supera abbondantemente i sessanta caratteri previsti";
    const result = slugifyTitle(longTitle);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.endsWith("-")).toBe(false);
    expect(result.startsWith("-")).toBe(false);
  });

  it("non spezza nel mezzo di una parola se possibile", () => {
    const longTitle = "alfa beta gamma delta epsilon zeta eta theta iota kappa lambda";
    const result = slugifyTitle(longTitle);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.split("-").every((part) => part.length > 0)).toBe(true);
  });
});

describe("isValidSlug", () => {
  it("accetta slug minuscoli alfanumerici con trattini", () => {
    expect(isValidSlug("il-nome-della-rosa")).toBe(true);
    expect(isValidSlug("libro1")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
  });

  it("rifiuta slug con caratteri speciali, spazi o maiuscole", () => {
    expect(isValidSlug("Il-Nome")).toBe(false);
    expect(isValidSlug("nome rosa")).toBe(false);
    expect(isValidSlug("nome/rosa")).toBe(false);
    expect(isValidSlug("nome..rosa")).toBe(false);
  });

  it("rifiuta slug con trattini iniziali o finali", () => {
    expect(isValidSlug("-libro")).toBe(false);
    expect(isValidSlug("libro-")).toBe(false);
  });

  it("rifiuta slug troppo lunghi", () => {
    expect(isValidSlug("a".repeat(61))).toBe(false);
    expect(isValidSlug("a".repeat(60))).toBe(true);
  });
});
