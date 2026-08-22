import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = process.env.VERSION_CHECK_REPO_ROOT
  ? path.resolve(process.env.VERSION_CHECK_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseRef = process.env.VERSION_CHECK_BASE_REF ?? "origin/main";

if (!hasGitRef(baseRef)) {
  console.log(`Version monotonicity check skipped: ${baseRef} is unavailable.`);
  process.exit(0);
}

const changedFiles = git(["diff", "--name-only", baseRef, "--", "config"])
  .split("\n")
  .filter(Boolean);

if (changedFiles.length === 0) {
  console.log("Version monotonicity check passed: config/ is unchanged.");
  process.exit(0);
}

const current = readCurrentVersion();
const baseline = readBaselineVersion(baseRef);

if (!isSemverGreater(current, baseline)) {
  console.error(
    `Version monotonicity check failed: config/ changed but config/version.json version must increase (base ${baseline}, current ${current}).`,
  );
  process.exit(1);
}

console.log(
  `Version monotonicity check passed: config/ changed and version increased from ${baseline} to ${current}.`,
);

function hasGitRef(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function readCurrentVersion() {
  return readVersion(JSON.parse(fs.readFileSync(path.join(rootDir, "config/version.json"), "utf8")));
}

function readBaselineVersion(ref) {
  let source;
  try {
    source = git(["show", `${ref}:config/version.json`]);
  } catch {
    console.error(`Version monotonicity check failed: ${ref} has no config/version.json.`);
    process.exit(1);
  }
  return readVersion(JSON.parse(source));
}

function readVersion(value) {
  const version = value?.release?.version ?? value?.config_version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("config/version.json must contain a semantic x.y.z release version");
  }
  return version;
}

function isSemverGreater(current, baseline) {
  const currentParts = current.split(".").map(Number);
  const baselineParts = baseline.split(".").map(Number);
  for (let index = 0; index < currentParts.length; index += 1) {
    if (currentParts[index] > baselineParts[index]) {
      return true;
    }
    if (currentParts[index] < baselineParts[index]) {
      return false;
    }
  }
  return false;
}

function git(args) {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
}
