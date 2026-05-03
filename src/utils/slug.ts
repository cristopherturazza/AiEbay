const MAX_SLUG_LENGTH = 60;
const MIN_TRUNCATE_BREAK = 30;

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

export const slugifyTitle = (title: string): string => {
  const normalized = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (normalized.length === 0) {
    return "listing";
  }

  if (normalized.length <= MAX_SLUG_LENGTH) {
    return normalized;
  }

  const truncated = normalized.slice(0, MAX_SLUG_LENGTH);
  const lastDash = truncated.lastIndexOf("-");
  if (lastDash >= MIN_TRUNCATE_BREAK) {
    return truncated.slice(0, lastDash);
  }

  return truncated.replace(/-+$/, "");
};

export const isValidSlug = (slug: string): boolean => SLUG_PATTERN.test(slug);
