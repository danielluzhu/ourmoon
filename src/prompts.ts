import { join } from "node:path";
import library from "../prompts.json";

export type Prompt = {
  id: string;
  category: string;
  text: string;
  alt?: string;
};

export const CATEGORIES: Record<string, { label: string; weight: number }> = library.categories;
export const PROMPTS: Prompt[] = library.prompts;

const BY_ID = new Map(PROMPTS.map((p) => [p.id, p]));

export function promptById(id: string): Prompt | undefined {
  return BY_ID.get(id);
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/** Weighted category pick, so the light-hearted categories come up most often. */
function pickCategory(pool: Prompt[]): string {
  const available = new Set(pool.map((p) => p.category));
  const entries = Object.entries(CATEGORIES).filter(([key]) => available.has(key));
  const total = entries.reduce((sum, [, c]) => sum + c.weight, 0);
  let roll = Math.random() * total;
  for (const [key, c] of entries) {
    roll -= c.weight;
    if (roll <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

/**
 * Draw a prompt for a table.
 *
 * - Prompts already used at this table are skipped until the deck runs dry.
 * - `{member}` prompts need at least two people at the table, and are resolved
 *   here so everyone sees the same name.
 */
export function drawPrompt(opts: {
  usedIds: string[];
  memberNames: string[];
  category?: string;
}): { prompt: Prompt; text: string } {
  const used = new Set(opts.usedIds);
  const canNameSomeone = opts.memberNames.length >= 2;

  let pool = PROMPTS.filter((p) => {
    if (opts.category && p.category !== opts.category) return false;
    if (!canNameSomeone && p.text.includes("{member}")) return false;
    return true;
  });
  if (pool.length === 0) pool = PROMPTS.filter((p) => !p.text.includes("{member}"));

  // Deck runs out -> reshuffle rather than refuse to deal.
  const fresh = pool.filter((p) => !used.has(p.id));
  const deck = fresh.length > 0 ? fresh : pool;

  const category = opts.category ?? pickCategory(deck);
  const inCategory = deck.filter((p) => p.category === category);
  const prompt = pick(inCategory.length > 0 ? inCategory : deck);

  const text = prompt.text.replace("{member}", () => pick(opts.memberNames));
  return { prompt, text };
}

export const PROMPTS_FILE = join(import.meta.dir, "..", "prompts.json");
