export const descriptionPreview = (description: string, lines = 3): string => {
  return description
    .split(/\r?\n/)
    .slice(0, Math.max(1, lines))
    .join("\n");
};
