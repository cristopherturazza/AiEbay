const KNOWN_CONDITIONS = new Set([
  "NEW",
  "LIKE_NEW",
  "NEW_WITH_DEFECTS",
  "CERTIFIED_REFURBISHED",
  "SELLER_REFURBISHED",
  "USED_EXCELLENT",
  "USED_VERY_GOOD",
  "USED_GOOD",
  "USED_ACCEPTABLE",
  "FOR_PARTS_OR_NOT_WORKING"
]);

export const mapDraftConditionToInventoryCondition = (input: string): string => {
  const candidate = input.trim().toUpperCase().replace(/\s+/g, "_");
  if (KNOWN_CONDITIONS.has(candidate)) {
    return candidate;
  }

  const normalized = input.trim().toLowerCase();

  if (normalized.includes("like new") || normalized.includes("come nuovo")) {
    return "LIKE_NEW";
  }

  if (normalized === "new" || normalized.includes("nuovo")) {
    return "NEW";
  }

  if (normalized.includes("for parts") || normalized.includes("ricambi")) {
    return "FOR_PARTS_OR_NOT_WORKING";
  }

  if (normalized.includes("excellent") || normalized.includes("eccell")) {
    return "USED_EXCELLENT";
  }

  if (normalized.includes("very good") || normalized.includes("ottim")) {
    return "USED_VERY_GOOD";
  }

  if (normalized.includes("acceptable") || normalized.includes("accett")) {
    return "USED_ACCEPTABLE";
  }

  return "USED_GOOD";
};
