export function normalizeCode(rawCode, searchConfig) {
  if (rawCode === undefined || rawCode === null || rawCode === "") {
    return null;
  }
  if (typeof rawCode !== "string") {
    throw new TypeError("code must be a string or null");
  }

  const rules = searchConfig?.code_search?.normalization;
  if (!rules) {
    throw new TypeError("searchConfig.code_search.normalization is required");
  }

  let candidate = rawCode.normalize("NFKC").trim();
  if (!candidate) {
    return null;
  }
  if (rules.normalize_hyphen) {
    candidate = candidate.replace(/[‐‑‒–—―−]/gu, "-");
  }
  if (rules.uppercase) {
    candidate = candidate.toLocaleUpperCase("en-US");
  }
  if (rules.remove_spaces) {
    candidate = candidate.replace(/\s+/gu, "");
  }
  if (rules.remove_underscores) {
    candidate = candidate.replace(/_/gu, "");
  }

  const match = new RegExp(rules.pattern, "u").exec(candidate);
  if (!match) {
    return {
      raw_code: rawCode,
      normalized_code: candidate,
      is_valid: false,
    };
  }

  const normalizedCode = rules.output_format.replace(
    /\$(\d+)/gu,
    (_, index) => match[Number(index)] ?? "",
  );

  return {
    raw_code: rawCode,
    normalized_code: normalizedCode,
    is_valid: true,
  };
}
