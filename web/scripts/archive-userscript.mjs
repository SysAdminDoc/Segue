import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";


const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = packageJson.version;
const sourcePath = join(root, "public", "segue-spotify.user.js");
const source = readFileSync(sourcePath, "utf8");
const metadataVersion = source.match(/^\/\/ @version\s+(\S+)/m)?.[1];

if (metadataVersion !== version) {
  throw new Error(`Userscript metadata ${metadataVersion || "missing"} does not match package ${version}`);
}

const archivePath = join(root, "public", "exporter", `v${version}`, "segue-spotify.user.js");
if (existsSync(archivePath)) {
  if (readFileSync(archivePath, "utf8") !== source) {
    throw new Error(`Refusing to overwrite immutable archive ${archivePath}`);
  }
  console.log(`Archive already current: ${archivePath}`);
} else {
  mkdirSync(dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, source, "utf8");
  console.log(`Archived userscript v${version}: ${archivePath}`);
}
