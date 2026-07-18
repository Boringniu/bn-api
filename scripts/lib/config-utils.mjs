import { readFile, readdir } from "node:fs/promises";
import { basename, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = fileURLToPath(new URL("../..", import.meta.url));
export const CONFIG_DIR = fileURLToPath(new URL("../../config", import.meta.url));
export const SCHEMA_DIR = fileURLToPath(new URL("../../schema", import.meta.url));
export const DIST_DIR = fileURLToPath(new URL("../../dist", import.meta.url));

export function configName(filePath) {
  return basename(filePath, ".json").replace(/\.schema$/, "");
}

export async function listJsonFiles(directory) {
  return (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => new URL(name, `file://${directory}/`));
}

export async function readJson(fileUrl) {
  const filePath = fileURLToPath(fileUrl);
  const source = await readFile(fileUrl, "utf8");

  try {
    return {
      data: JSON.parse(source),
      filePath,
      source,
    };
  } catch (error) {
    throw new Error(`${relativePath(filePath)}: invalid JSON (${error.message})`);
  }
}

export async function loadJsonDirectory(directory) {
  const entries = await Promise.all(
    (await listJsonFiles(directory)).map(async (fileUrl) => {
      const value = await readJson(fileUrl);
      return [configName(value.filePath), value];
    }),
  );

  return new Map(entries);
}

export function normalizeAlias(value) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
}

export function relativePath(filePath) {
  return relative(ROOT_DIR, filePath);
}

export function formatAjvErrors(filePath, errors = []) {
  return errors.map((error) => {
    const location = error.instancePath || "/";
    const details = error.params?.additionalProperty
      ? `: ${error.params.additionalProperty}`
      : "";
    return `${relativePath(filePath)}${location}: ${error.message}${details}`;
  });
}

export function printFailures(title, failures) {
  console.error(`${title} (${failures.length})`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
}
