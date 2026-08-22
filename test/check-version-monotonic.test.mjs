import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checker = path.join(rootDir, "scripts/check-version-monotonic.mjs");

function createFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "bn-version-check-"));
  fs.mkdirSync(path.join(fixture, "config"));
  fs.writeFileSync(
    path.join(fixture, "config/version.json"),
    JSON.stringify(
      {
        schema_version: "1.0",
        config_version: "1.0.0",
        release: { version: "1.0.0", release_date: "2026-01-01", description: "base" },
      },
      null,
      2,
    ) + "\n",
  );
  fs.writeFileSync(path.join(fixture, "config/search.json"), "{}\n");
  runGit(fixture, ["init", "-b", "main"]);
  runGit(fixture, ["config", "user.email", "test@example.com"]);
  runGit(fixture, ["config", "user.name", "Test"]);
  runGit(fixture, ["add", "config"]);
  runGit(fixture, ["commit", "-m", "base"]);
  return fixture;
}

function runChecker(fixture, extraEnv = {}) {
  return spawnSync(process.execPath, [checker], {
    cwd: fixture,
    encoding: "utf8",
    env: {
      ...process.env,
      VERSION_CHECK_REPO_ROOT: fixture,
      VERSION_CHECK_BASE_REF: "HEAD",
      ...extraEnv,
    },
  });
}

function writeVersion(fixture, version) {
  fs.writeFileSync(
    path.join(fixture, "config/version.json"),
    JSON.stringify(
      {
        schema_version: "1.0",
        config_version: version,
        release: { version, release_date: "2026-01-02", description: "changed" },
      },
      null,
      2,
    ) + "\n",
  );
}

function runGit(fixture, args) {
  return execFileSync("git", args, { cwd: fixture, encoding: "utf8" });
}

function withFixture(callback) {
  const fixture = createFixture();
  try {
    return callback(fixture);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

test("skips when the configured baseline ref is unavailable", () => {
  withFixture((fixture) => {
    const result = runChecker(fixture, { VERSION_CHECK_BASE_REF: "origin/main" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /skipped/);
  });
});

test("passes when config files are unchanged from the baseline", () => {
  withFixture((fixture) => {
    const result = runChecker(fixture);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /config\/ is unchanged/);
  });
});

test("fails when config changes do not increase the release version", () => {
  withFixture((fixture) => {
    fs.writeFileSync(path.join(fixture, "config/search.json"), '{"changed":true}\n');
    const result = runChecker(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /version must increase/);
  });
});

test("passes when config changes increase the release version", () => {
  withFixture((fixture) => {
    fs.writeFileSync(path.join(fixture, "config/search.json"), '{"changed":true}\n');
    writeVersion(fixture, "1.0.1");
    const result = runChecker(fixture);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /increased from 1\.0\.0 to 1\.0\.1/);
  });
});
