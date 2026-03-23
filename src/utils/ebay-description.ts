const HTML_TAG_PATTERN = /<\/?[a-z][^>]*>/i;

const escapeHtml = (value: string): string => {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const isBulletLine = (line: string): boolean => /^[*-]\s+/.test(line.trim());

const stripBulletPrefix = (line: string): string => line.trim().replace(/^[*-]\s+/, "");

const renderBulletList = (lines: string[]): string => {
  const items = lines.map((line) => `<li>${escapeHtml(stripBulletPrefix(line))}</li>`).join("");
  return `<ul>${items}</ul>`;
};

const renderParagraph = (lines: string[]): string => {
  return `<p>${lines.map((line) => escapeHtml(line.trim())).join("<br>")}</p>`;
};

const renderBlock = (lines: string[]): string => {
  if (lines.length === 0) {
    return "";
  }

  if (lines.every(isBulletLine)) {
    return renderBulletList(lines);
  }

  if (lines.length > 1 && /:$/.test(lines[0].trim()) && lines.slice(1).every(isBulletLine)) {
    const heading = escapeHtml(lines[0].trim().slice(0, -1));
    return `<p><strong>${heading}</strong></p>${renderBulletList(lines.slice(1))}`;
  }

  return renderParagraph(lines);
};

// eBay Inventory API createOffer/updateOffer docs explicitly allow HTML in listingDescription.
// https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/createOffer
export const renderEbayListingDescription = (input: string): string => {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  if (HTML_TAG_PATTERN.test(trimmed)) {
    return trimmed;
  }

  const blocks: string[][] = [];
  let currentBlock: string[] = [];

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock);
        currentBlock = [];
      }
      continue;
    }

    currentBlock.push(line);
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock);
  }

  return `<div>${blocks.map(renderBlock).join("")}</div>`;
};
