import { readFile } from "node:fs/promises";

import { validateDecisionRows } from "./lib/review-decisions.mjs";

const rows = JSON.parse(
  await readFile(new URL("../review-decisions.json", import.meta.url), "utf8"),
);
const failures = validateDecisionRows(rows);
if (failures.length > 0) {
  console.error(`Review decision validation failed (${failures.length})`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Validated ${rows.length} review decision rows.`);
}
