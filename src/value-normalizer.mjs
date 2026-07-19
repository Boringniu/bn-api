const SEPARATORS = /[-_./‐‑‒–—―−]/gu;

export function normalizeValue(value) {
  if (typeof value !== "string") {
    throw new TypeError("value must be a string");
  }

  return value
    .normalize("NFKC")
    .replace(SEPARATORS, " ")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
}
