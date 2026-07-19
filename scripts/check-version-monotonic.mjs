import { execFileSync } from "node:child_process";

import {
  CONFIG_DIR,
  loadJsonDirectory,
  printFailures,
} from "./lib/config-utils.mjs";

const BASE_REF = process.env.CONFIG_BASE_REF || "origin/main";
const failures = [];

const configs = await loadJsonDirectory(CONFIG_DIR);

let baseAvailable = true;
try {
  execFileSync("git", ["rev-parse", "--verify", `${BASE_REF}^{commit}`], {
    stdio: "pipe",
  });
} catch {
  baseAvailable = false;
}

if (!baseAvailable) {
  console.log(`Base ref ${BASE_REF} is unavailable; skipping version comparison.`);
  process.exit(0);
}

const baseFiles = new Map();
for (const name of configs.keys()) {
  const path = `config/${name}.json`;
  try {
    const source = execFileSync("git", ["show", `${BASE_REF}:${path}`], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    baseFiles.set(name, { data: JSON.parse(source), source });
  } catch {
    // New file on this branch; no baseline to compare against.
  }
}

for (const [name, current] of configs) {
  const base = baseFiles.get(name);
  if (!base) {
    continue;
  }

  const currentVersion = current.data.config_version;
  const baseVersion = base.data.config_version;

  if (compareSemver(currentVersion, baseVersion) < 0) {
    failures.push(
      `config/${name}.json: config_version ${currentVersion} is lower than ${baseVersion} on ${BASE_REF}`,
    );
  }

  if (current.source !== base.source && currentVersion === baseVersion) {
    failures.push(
      `config/${name}.json: content changed but config_version is still ${baseVersion}; bump the version`,
    );
  }
}

const versionConfig = configs.get("version")?.data;
const baseVersionConfig = baseFiles.get("version")?.data;
if (versionConfig && baseVersionConfig) {
  if (
    compareSemver(versionConfig.config_version, baseVersionConfig.config_version) <
    0
  ) {
    failures.push(
      `config/version.json: release version ${versionConfig.config_version} is lower than ${baseVersionConfig.config_version} on ${BASE_REF}`,
    );
  }
}

if (failures.length > 0) {
  printFailures("Version monotonicity check failed", failures);
} else {
  console.log(
    `Checked ${baseFiles.size} configuration files against ${BASE_REF}; versions are monotonic.`,
  );
}

function compareSemver(left, right) {
  const parse = (value) => value.split(".").map(Number);
  const [lMajor, lMinor, lPatch] = parse(left);
  const [rMajor, rMinor, rPatch] = parse(right);
  return lMajor - rMajor || lMinor - rMinor || lPatch - rPatch;
}
