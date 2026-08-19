/**
 * Drawing prompts, in the browser.
 *
 * The server does this in src/prompts.ts. Two client paths need it too — the
 * serverless demo backend and in-person mode — so the rules live here once
 * rather than three times: skip prompts a group has already had, only use
 * {member} prompts when there are names to fill them with, and reshuffle
 * instead of refusing to deal when the deck runs dry.
 */

let libraryHandle;

/** prompts.json sits next to the page, so resolve it against the document. */
export function loadLibrary() {
  // A failed load must not be remembered: caching the rejected promise would
  // turn one flaky request into a mode that never draws again until reload.
  libraryHandle ??= fetch(new URL("prompts.json", document.baseURI).href)
    .then((res) => {
      if (!res.ok) throw new Error(`Could not load the questions (${res.status}).`);
      return res.json();
    })
    .catch((err) => {
      libraryHandle = undefined;
      throw err;
    });
  return libraryHandle;
}

const pick = (items) => items[Math.floor(Math.random() * items.length)];

/** Weighted category pick, so the light-hearted categories come up most often. */
function pickCategory(pool, categories) {
  const available = new Set(pool.map((p) => p.category));
  const entries = Object.entries(categories).filter(([key]) => available.has(key));
  const total = entries.reduce((sum, [, c]) => sum + c.weight, 0);
  let roll = Math.random() * total;
  for (const [key, c] of entries) {
    roll -= c.weight;
    if (roll <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

export function drawPrompt(library, { usedIds = [], memberNames = [], category } = {}) {
  const used = new Set(usedIds);
  const canNameSomeone = memberNames.length >= 2;

  let pool = library.prompts.filter((p) => {
    if (category && p.category !== category) return false;
    if (!canNameSomeone && p.text.includes("{member}")) return false;
    return true;
  });
  if (pool.length === 0) pool = library.prompts.filter((p) => !p.text.includes("{member}"));

  // Deck runs out -> reshuffle rather than refuse to deal.
  const fresh = pool.filter((p) => !used.has(p.id));
  const deck = fresh.length > 0 ? fresh : pool;

  const chosen = category ?? pickCategory(deck, library.categories);
  const inCategory = deck.filter((p) => p.category === chosen);
  const prompt = pick(inCategory.length > 0 ? inCategory : deck);

  return {
    prompt,
    text: prompt.text.replace("{member}", () => pick(memberNames)),
    exhausted: fresh.length === 0,
  };
}
