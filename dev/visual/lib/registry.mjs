import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SURFACES as REGISTERED_SURFACES } from "../surfaces/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");

function validateSurface(id, surface) {
  if (typeof surface.source !== "string" || surface.source.length === 0) {
    throw new Error(`Visual surface "${id}" requires a source path`);
  }
  if (!existsSync(resolve(REPO, surface.source))) {
    throw new Error(`Visual surface "${id}" source does not exist: ${surface.source}`);
  }
  return surface;
}

export const SURFACES = Object.fromEntries(
  Object.entries(REGISTERED_SURFACES).map(([id, surface]) => [
    id,
    validateSurface(id, surface),
  ]),
);
