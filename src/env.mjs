// env.mjs — load a .env file if one sits next to package.json.
//
// Why this exists: the model key has to reach the process, and on a host we
// do not control the start command. Exporting it in a shell only works if the
// host runs a shell; a .env file next to the project works either way, and
// keeps the key out of the start command, the repository and the build log.
//
// Precedence: a real environment variable always wins over the file, so a host
// that injects MODEL_API_KEY still overrides anything committed by accident.
// No dependencies, ~20 lines, and it does nothing when the file is absent.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));

try {
  const text = readFileSync(ENV_PATH, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
} catch {
  // No .env is the normal case for a local run that exports its own variables.
}
