import { describe, expect, it } from "vitest";
import { renderEbayListingDescription } from "../src/utils/ebay-description.js";

describe("renderEbayListingDescription", () => {
  it("renders paragraphs and bullet lists from plain text", () => {
    const html = renderEbayListingDescription(
      [
        "Libro usato in condizioni pari al nuovo.",
        "",
        "Dettagli principali:",
        "- Autore: Cal Newport",
        "- ISBN: 9788836201631"
      ].join("\n")
    );

    expect(html).toBe(
      "<div><p>Libro usato in condizioni pari al nuovo.</p><p><strong>Dettagli principali</strong></p><ul><li>Autore: Cal Newport</li><li>ISBN: 9788836201631</li></ul></div>"
    );
  });

  it("passes through existing html descriptions", () => {
    const html = "<p>Gia' formattato</p>";
    expect(renderEbayListingDescription(html)).toBe(html);
  });
});
