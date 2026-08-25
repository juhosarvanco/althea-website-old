// Netlify build step: decide whether this deployment should be indexable.
//
// While the site still lives on its temporary *.netlify.app address it must
// stay out of search results — an unfinished page with [HINTA A] placeholders
// is not what should surface for "Althea retriitti", and a temporary domain
// that gets indexed later competes with the real one for the same content.
//
// This keys off the primary URL Netlify provides rather than a flag someone
// has to remember to flip, so pointing a real domain at the site lifts the
// block on the next deploy. Forgetting to remove a launch-day noindex is a
// classic and expensive mistake; this cannot make it.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "site");

let host = "";
try { host = new URL(process.env.URL || "").hostname; } catch { /* local run */ }

const temporary = !host || host.endsWith(".netlify.app");
const context = process.env.CONTEXT || "local";

if (temporary) {
  await writeFile(join(SITE, "robots.txt"),
    "# Temporary address — not for indexing.\nUser-agent: *\nDisallow: /\n");
  await writeFile(join(SITE, "_headers"),
    "/*\n  X-Robots-Tag: noindex, nofollow\n");
} else {
  await writeFile(join(SITE, "robots.txt"),
    `User-agent: *\nAllow: /\nDisallow: /admin/\n\nHost: ${host}\n`);
  await writeFile(join(SITE, "_headers"),
    "/admin/*\n  X-Robots-Tag: noindex, nofollow\n");
}

console.log(
  `[prepare-deploy] context=${context} host=${host || "(none)"} -> ` +
  (temporary ? "noindex (temporary address)" : "indexable"));
