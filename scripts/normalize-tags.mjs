import { createTagNormalizer } from "../src/tag-normalizer.mjs";
import {
  CONFIG_DIR,
  loadJsonDirectory,
} from "./lib/config-utils.mjs";

try {
  const rawTags = await readInput();
  const configs = await loadJsonDirectory(CONFIG_DIR);
  const normalizer = createTagNormalizer({
    aliasConfig: requireConfig(configs, "alias"),
    categoryConfig: requireConfig(configs, "category"),
    tagDictionaryConfig: requireConfig(configs, "tag_dictionary"),
    versionConfig: requireConfig(configs, "version"),
  });

  console.log(JSON.stringify(normalizer.normalize(rawTags), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function readInput() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length > 0) {
    return argumentsList;
  }

  const source = await readStdin();
  if (!source.trim()) {
    throw new Error(
      "provide tags as arguments or JSON on stdin (array or {\"raw_tags\": [...]})",
    );
  }

  const input = JSON.parse(source);
  if (Array.isArray(input)) {
    return input;
  }
  if (input && typeof input === "object" && Array.isArray(input.raw_tags)) {
    return input.raw_tags;
  }
  throw new TypeError(
    "stdin JSON must be an array or an object with a raw_tags array",
  );
}

async function readStdin() {
  process.stdin.setEncoding("utf8");
  let source = "";
  for await (const chunk of process.stdin) {
    source += chunk;
  }
  return source;
}

function requireConfig(configs, name) {
  const config = configs.get(name)?.data;
  if (!config) {
    throw new Error(`config/${name}.json is required`);
  }
  return config;
}
