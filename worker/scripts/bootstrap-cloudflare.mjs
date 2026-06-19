#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dbName = process.argv[2] || process.env.SUPERDS_D1_NAME || "superdeepseek";
const configPath = resolve("wrangler.jsonc");

function runWrangler(args) {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function extractDatabaseId(output) {
  const tomlMatch = output.match(/database_id\s*=\s*"([^"]+)"/);
  if (tomlMatch) return tomlMatch[1];
  const jsonMatch = output.match(/"database_id"\s*:\s*"([^"]+)"/);
  if (jsonMatch) return jsonMatch[1];
  const uuidMatch = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuidMatch?.[0] ?? "";
}

function patchWrangler(databaseId) {
  const current = readFileSync(configPath, "utf8");
  const next = current.replace(
    /"database_id"\s*:\s*"[^"]*"/,
    `"database_id": "${databaseId}"`,
  );
  if (next === current) {
    throw new Error(`Could not find database_id in ${configPath}`);
  }
  writeFileSync(configPath, next);
}

try {
  console.log(`Creating D1 database '${dbName}'...`);
  const output = runWrangler(["d1", "create", dbName]);
  const databaseId = extractDatabaseId(output);
  if (!databaseId) {
    console.error(output);
    throw new Error("Wrangler did not print a database_id");
  }
  patchWrangler(databaseId);
  console.log(`Updated wrangler.jsonc with D1 database_id ${databaseId}`);
  console.log("Next steps:");
  console.log(`  npx wrangler d1 migrations apply ${dbName} --remote`);
  console.log("  npx wrangler secret put SUPERDS_LOCAL_API_KEY");
  console.log("  npm run deploy");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
