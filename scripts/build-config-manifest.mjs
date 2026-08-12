import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CONFIG_DIR,
  DIST_DIR,
  loadJsonDirectory,
  relativePath,
} from "./lib/config-utils.mjs";

const configs = await loadJsonDirectory(CONFIG_DIR);
const versionConfig = configs.get("version")?.data;

if (!versionConfig) {
  throw new Error("config/version.json is required to build the manifest");
}

const files = [];
for (const name of [...configs.keys()].sort()) {
  const entry = configs.get(name);
  const content = await readFile(entry.filePath);
  files.push({
    name,
    path: relativePath(entry.filePath),
    schema_path: `schema/${name}.schema.json`,
    // config_version: entry.data.config_version, // Removed per-file versioning
    sha256: createHash("sha256").update(content).digest("hex"),
    size_bytes: content.byteLength,
  });
}

const generatedAt = [...configs.values()]
  .map((entry) => entry.data.updated_at)
  .sort()
  .at(-1);

const manifest = {
  schema_version: versionConfig.schema_version,
  config_version: versionConfig.config_version,
  generated_at: generatedAt,
  release: versionConfig.release,
  files,
};

await mkdir(DIST_DIR, { recursive: true });
const outputPath = join(DIST_DIR, "config-manifest.json");
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Built ${relativePath(outputPath)} with ${files.length} entries.`);
