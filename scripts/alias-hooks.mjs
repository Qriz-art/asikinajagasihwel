// Loader hook ESM untuk me-resolve alias "@/..." ke root proyek.
// Dipakai agar script standalone (mis. bot Telegram) bisa mengimpor
// modul yang memakai alias Next.js (lib/scrapr-service.js, dll).

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    let target = path.join(ROOT, specifier.slice(2));
    if (!path.extname(target)) {
      target += ".js";
    }
    return nextResolve(pathToFileURL(target).href, context);
  }

  return nextResolve(specifier, context);
}