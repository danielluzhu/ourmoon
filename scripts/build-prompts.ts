/**
 * Generate public/prompts-data.js from prompts.json.
 *
 * In-person mode draws questions in the browser, so the library has to reach
 * the client somehow. Fetching prompts.json is surprisingly easy to break: a
 * catch-all route answers with index.html and a 200, a static host guesses the
 * wrong content type, a stale server serves neither. Shipping it as a module
 * instead means it loads through the same import the rest of the code uses --
 * no parsing, no routing, and it works offline and from file:// too.
 *
 * prompts.json stays the single source of truth; this file is generated.
 */
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = join(root, "prompts.json");
const target = join(root, "public", "prompts-data.js");

const library = await Bun.file(source).json();

const banner = "// Generated from prompts.json by scripts/build-prompts.ts — do not edit.\n" +
  "// Run `bun run prompts` after changing prompts.json.\n\n";

await Bun.write(target, `${banner}export default ${JSON.stringify(library, null, 2)};\n`);

console.log(`prompts-data.js ← prompts.json (${library.prompts.length} prompts)`);
