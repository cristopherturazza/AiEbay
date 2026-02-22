const SKU_MAX_LENGTH = 50;

export const makeSku = (slug: string): string => {
  const normalized = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, SKU_MAX_LENGTH - 3);

  const base = normalized.length > 0 ? normalized : `${Date.now()}`;
  return `sb-${base}`.slice(0, SKU_MAX_LENGTH);
};
