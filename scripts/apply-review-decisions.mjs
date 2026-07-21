import { readFile, writeFile } from "node:fs/promises";

import { applyReviewDecisions } from "./lib/review-decisions.mjs";

const ROOT = new URL("../", import.meta.url);
const decisions = await readJson(new URL("review-decisions.json", ROOT));
if (decisions.length === 0) {
  console.log("No review decisions to apply.");
  process.exit(0);
}

const workerUrl = process.env.WORKER_URL ?? "https://bn-api.niu900326.workers.dev";
const reviewToken = process.env.REVIEW_TOKEN_EDITOR;
if (!reviewToken) {
  throw new Error("REVIEW_TOKEN_EDITOR is required");
}

const reviewItems = await fetchPendingReviews(workerUrl, reviewToken);
const actorConfig = await readJson(new URL("config/actor_dictionary.json", ROOT));
const tagConfig = await readJson(new URL("config/tag_dictionary.json", ROOT));
const ignoredConfig = await readJson(new URL("config/ignored.json", ROOT));
const versionConfig = await readJson(new URL("config/version.json", ROOT));
const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");

const result = applyReviewDecisions({
  actorConfig,
  decisions,
  ignoredConfig,
  reviewItems,
  tagConfig,
  timestamp,
  versionConfig,
});
const changelog = await readFile(new URL("docs/CHANGELOG.md", ROOT), "utf8");

await Promise.all([
  writeJson("config/actor_dictionary.json", actorConfig),
  writeJson("config/tag_dictionary.json", tagConfig),
  writeJson("config/ignored.json", ignoredConfig),
  writeJson("config/version.json", versionConfig),
  writeJson("review-decisions.json", []),
  writeFile(
    new URL("docs/CHANGELOG.md", ROOT),
    addChangelogEntry(changelog, result),
    "utf8",
  ),
]);

console.log(JSON.stringify(result, null, 2));

async function fetchPendingReviews(baseUrl, token) {
  const items = [];
  let page = 1;
  while (true) {
    const response = await fetch(
      `${baseUrl}/v1/review?status=pending&page=${page}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      throw new Error(`review queue request failed: HTTP ${response.status}`);
    }
    const body = await response.json();
    const data = body.data;
    items.push(...(data.results ?? []));
    if (items.length >= data.total) {
      return items;
    }
    page += 1;
  }
}

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

async function writeJson(relativePath, value) {
  await writeFile(
    new URL(relativePath, ROOT),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

function addChangelogEntry(source, result) {
  const marker = "\n## ";
  const index = source.indexOf(marker);
  const summary = result.applied
    .map((item) => `\`${item.term}\`=${item.decision}`)
    .join("、");
  const entry =
    `\n## [${result.version}] - ${new Date().toISOString().slice(0, 10)}\n\n` +
    `- 通过 \`review-decisions.json\` 应用人工决定：${summary}。\n` +
    "- 自动重新编目受影响数据并刷新频道置顶索引。\n";
  return index === -1
    ? `${source.trimEnd()}\n${entry}`
    : `${source.slice(0, index)}${entry}${source.slice(index)}`;
}
