/**
 * Static demo backend.
 *
 * GitHub Pages serves files, not servers, so on a Pages deploy there is no
 * Bun process and no SQLite behind /api/*. This module stands in for the
 * server by intercepting fetch and answering the same routes with the same
 * shapes, backed by localStorage (records) and IndexedDB (recordings).
 *
 * It is a demo, not the app: everything lives in one browser, so a table
 * cannot actually be shared with anyone. The real server is src/server.ts.
 *
 * Inactive on a real backend — see ACTIVE below.
 */
(() => {
  const ACTIVE =
    /\.github\.io$/.test(location.hostname) ||
    location.protocol === "file:" ||
    new URLSearchParams(location.search).has("demo");
  if (!ACTIVE) return;

  const nativeFetch = window.fetch.bind(window);
  const KEY = "ourmoon-demo-v1";
  const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
  const MAX_TEXT_CHARS = 2000;
  const MAX_DURATION_MS = 120_000;

  const AUDIO_TYPES = {
    "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4",
    "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
  };
  const EXT_TO_MIME = {
    webm: "audio/webm", ogg: "audio/ogg", mp4: "audio/mp4",
    mp3: "audio/mpeg", wav: "audio/wav",
  };
  const normalizeMime = (raw) => {
    const base = String(raw).split(";")[0].trim().toLowerCase();
    return base.startsWith("video/") ? base.replace("video/", "audio/") : base;
  };

  // ------------------------------------------------------------- storage

  const blank = () => ({ tables: [], members: [], rounds: [], responses: [], session: null });
  let db;
  try {
    db = JSON.parse(localStorage.getItem(KEY)) || blank();
  } catch {
    db = blank();
  }
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch {
      /* quota — the session still works, it just will not survive a reload */
    }
  };

  /** Recordings are far too big for localStorage, so they go to IndexedDB. */
  let idbHandle;
  function idb() {
    idbHandle ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("ourmoon-demo", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("audio");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return idbHandle;
  }
  async function audioStore(mode, run) {
    const conn = await idb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction("audio", mode);
      const req = run(tx.objectStore("audio"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const putAudio = (k, blob) => audioStore("readwrite", (s) => s.put(blob, k));
  const getAudio = (k) => audioStore("readonly", (s) => s.get(k));
  const delAudio = (k) => audioStore("readwrite", (s) => s.delete(k));

  // ------------------------------------------------------------- prompts

  let promptsHandle;
  function library() {
    promptsHandle ??= nativeFetch(new URL("prompts.json", document.baseURI).href).then((r) => {
      if (!r.ok) throw new Error("prompts.json missing");
      return r.json();
    });
    return promptsHandle;
  }

  const pick = (items) => items[Math.floor(Math.random() * items.length)];

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

  /** Port of drawPrompt in src/prompts.ts — same skip-used, same {member} rules. */
  function drawPrompt(lib, { usedIds, memberNames, category }) {
    const used = new Set(usedIds);
    const canNameSomeone = memberNames.length >= 2;

    let pool = lib.prompts.filter((p) => {
      if (category && p.category !== category) return false;
      if (!canNameSomeone && p.text.includes("{member}")) return false;
      return true;
    });
    if (pool.length === 0) pool = lib.prompts.filter((p) => !p.text.includes("{member}"));

    const fresh = pool.filter((p) => !used.has(p.id));
    const deck = fresh.length > 0 ? fresh : pool;

    const chosen = category ?? pickCategory(deck, lib.categories);
    const inCategory = deck.filter((p) => p.category === chosen);
    const prompt = pick(inCategory.length > 0 ? inCategory : deck);

    return { prompt, text: prompt.text.replace("{member}", () => pick(memberNames)) };
  }

  // ------------------------------------------------------------- helpers

  const uid = () => crypto.randomUUID();
  const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXYZ23456789";
  const randomChars = (count) =>
    count <= 0 ? "" :
      Array.from(crypto.getRandomValues(new Uint8Array(count)),
        (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");

  const codeStem = (name) =>
    name.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
      .replace(/^THE\b/, "").replace(/[^A-Z0-9]/g, "").slice(0, 6);

  function uniqueJoinCode(tableName) {
    for (let tail = 2; ; tail++) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const stem = codeStem(tableName);
        const code = stem + randomChars(Math.max(0, 3 - stem.length)) + randomChars(tail);
        if (!db.tables.some((t) => t.joinCode === code)) return code;
      }
    }
  }

  const cleanName = (raw, max = 40) =>
    typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, max) : "";

  const membersOf = (tableId) => db.members.filter((m) => m.tableId === tableId);
  const nextHue = (tableId) => (membersOf(tableId).length * 137 + 20) % 360;
  const currentMember = () => db.members.find((m) => m.id === db.session) ?? null;

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  const fail = (status, message) => json({ error: message }, status);

  async function readJson(init) {
    const body = init?.body;
    if (typeof body === "string") { try { return JSON.parse(body); } catch { return {}; } }
    return {};
  }

  // -------------------------------------------------------------- state

  function tableState(me) {
    const table = db.tables.find((t) => t.id === me.tableId);
    const members = membersOf(me.tableId).sort((a, b) => a.createdAt - b.createdAt);
    const rounds = db.rounds.filter((r) => r.tableId === me.tableId)
      .sort((a, b) => b.createdAt - a.createdAt);
    const roundIds = new Set(rounds.map((r) => r.id));
    const responses = db.responses.filter((r) => roundIds.has(r.roundId))
      .sort((a, b) => a.createdAt - b.createdAt);

    const byRound = new Map();
    for (const r of responses) {
      if (!byRound.has(r.roundId)) byRound.set(r.roundId, []);
      byRound.get(r.roundId).push({
        id: r.id,
        memberId: r.memberId,
        kind: r.kind,
        text: r.text,
        audioUrl: r.audioFile ? `/media/${r.audioFile}` : null,
        durationMs: r.durationMs,
        createdAt: r.createdAt,
        mine: r.memberId === me.id,
      });
    }

    return {
      me: { id: me.id, name: me.name, hue: me.hue },
      table: { id: table.id, name: table.name, joinCode: table.joinCode },
      members: members.map((m, i) => ({
        id: m.id, name: m.name, hue: m.hue, joinedAt: m.createdAt, host: i === 0,
      })),
      categories: promptCategories,
      rounds: rounds.map((r) => ({
        id: r.id,
        promptId: r.promptId,
        category: r.category,
        categoryLabel: promptCategories[r.category]?.label ?? r.category,
        text: r.promptText,
        alt: r.promptAlt,
        openedBy: r.openedBy,
        createdAt: r.createdAt,
        responses: byRound.get(r.id) ?? [],
      })),
    };
  }

  let promptCategories = {};

  // ------------------------------------------------------------- routing

  async function handle(route, method, init) {
    if (route === "/api/tables" && method === "POST") {
      const body = await readJson(init);
      const tableName = cleanName(body.tableName, 60);
      const memberName = cleanName(body.name);
      if (!tableName) return fail(400, "Give your table a name.");
      if (!memberName) return fail(400, "Tell us your name.");

      const now = Date.now();
      const table = { id: uid(), name: tableName, joinCode: uniqueJoinCode(tableName), createdAt: now };
      const member = { id: uid(), tableId: table.id, name: memberName, hue: 20, createdAt: now };
      db.tables.push(table);
      db.members.push(member);
      db.session = member.id;
      save();
      return json({ ok: true, joinCode: table.joinCode });
    }

    if (route === "/api/join" && method === "POST") {
      const body = await readJson(init);
      const code = cleanName(body.joinCode, 12).toUpperCase().replace(/[^A-Z0-9]/g, "");
      const memberName = cleanName(body.name);
      if (!memberName) return fail(400, "Tell us your name.");

      const table = db.tables.find((t) => t.joinCode === code);
      if (!table) return fail(404, "No table with that code.");

      const existing = membersOf(table.id)
        .find((m) => m.name.toLowerCase() === memberName.toLowerCase());
      const member = existing ?? {
        id: uid(), tableId: table.id, name: memberName,
        hue: nextHue(table.id), createdAt: Date.now(),
      };
      if (!existing) db.members.push(member);
      db.session = member.id;
      save();
      return json({ ok: true, rejoined: Boolean(existing) });
    }

    if (route === "/api/logout" && method === "POST") {
      db.session = null;
      save();
      return json({ ok: true });
    }

    const me = currentMember();
    if (!me) return fail(401, "Not signed in.");

    if (route === "/api/state" && method === "GET") {
      promptCategories = (await library()).categories;
      return json(tableState(me));
    }

    if (route === "/api/rounds" && method === "POST") {
      const lib = await library();
      promptCategories = lib.categories;
      const body = await readJson(init);
      const category = typeof body.category === "string" && body.category in lib.categories
        ? body.category
        : undefined;

      const { prompt, text } = drawPrompt(lib, {
        usedIds: db.rounds.filter((r) => r.tableId === me.tableId).map((r) => r.promptId),
        memberNames: membersOf(me.tableId).map((m) => m.name),
        category,
      });

      const round = {
        id: uid(), tableId: me.tableId, promptId: prompt.id, category: prompt.category,
        promptText: text, promptAlt: prompt.alt ?? null, openedBy: me.id, createdAt: Date.now(),
      };
      db.rounds.push(round);
      save();
      return json({ ok: true, roundId: round.id });
    }

    if (route === "/api/responses" && method === "POST") {
      const form = init?.body;
      if (!(form instanceof FormData)) return fail(400, "Expected a form upload.");

      const roundId = String(form.get("roundId") ?? "");
      const round = db.rounds.find((r) => r.id === roundId);
      if (!round || round.tableId !== me.tableId) return fail(404, "No such topic.");
      if (db.responses.some((r) => r.roundId === roundId && r.memberId === me.id)) {
        return fail(409, "You have already answered this one. Delete your answer to redo it.");
      }

      const durationMs = Math.min(Number(form.get("durationMs") ?? 0) || 0, MAX_DURATION_MS);
      const audio = form.get("audio");
      const text = cleanName(form.get("text"), MAX_TEXT_CHARS);

      let kind, audioFile = null, audioMime = null;
      if (audio instanceof Blob && audio.size > 0) {
        if (audio.size > MAX_AUDIO_BYTES) return fail(413, "That recording is too long.");
        const ext = AUDIO_TYPES[normalizeMime(String(form.get("mime") ?? "") || audio.type)];
        if (!ext) return fail(415, "That audio format isn't supported.");
        kind = "audio";
        audioMime = EXT_TO_MIME[ext];
        audioFile = `${uid()}.${ext}`;
        try {
          await putAudio(audioFile, audio);
        } catch {
          return fail(507, "This browser ran out of room for recordings.");
        }
      } else if (text) {
        kind = "text";
      } else {
        return fail(400, "Record something or write something.");
      }

      const response = {
        id: uid(), roundId, memberId: me.id, kind,
        text: kind === "text" ? text : (text || null),
        audioFile, audioMime, durationMs: durationMs || null, createdAt: Date.now(),
      };
      db.responses.push(response);
      save();
      return json({ ok: true, id: response.id });
    }

    const del = route.match(/^\/api\/responses\/([\w-]+)$/);
    if (del && method === "DELETE") {
      const response = db.responses.find((r) => r.id === del[1]);
      if (!response) return fail(404, "Already gone.");
      if (response.memberId !== me.id) return fail(403, "That one isn't yours.");
      db.responses = db.responses.filter((r) => r.id !== response.id);
      save();
      if (response.audioFile) await delAudio(response.audioFile).catch(() => {});
      return json({ ok: true });
    }

    return fail(404, "Unknown endpoint.");
  }

  async function handleMedia(route) {
    if (!currentMember()) return fail(401, "Not signed in.");
    const match = route.match(/^\/media\/([0-9a-f-]{36})\.(webm|ogg|mp4|mp3|wav)$/);
    if (!match) return fail(404, "Recording not found.");
    const blob = await getAudio(`${match[1]}.${match[2]}`);
    if (!blob) return fail(404, "Recording not found.");
    return new Response(blob, { headers: { "content-type": EXT_TO_MIME[match[2]] } });
  }

  window.fetch = async (input, init) => {
    const href = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(href, location.href);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

    // Pages serves the app from /<repo>/, so match on the suffix, not the whole path.
    for (const prefix of ["/api/", "/media/"]) {
      const at = pathname.indexOf(prefix);
      if (at === -1) continue;
      const route = pathname.slice(at);
      try {
        return prefix === "/api/" ? await handle(route, method, init) : await handleMedia(route);
      } catch (err) {
        console.error("demo backend error", route, err);
        return fail(500, "Something went wrong in the demo.");
      }
    }
    return nativeFetch(input, init);
  };

  // Say plainly that nothing here leaves the browser.
  addEventListener("DOMContentLoaded", () => {
    const note = document.createElement("div");
    note.id = "demo-note";
    note.textContent =
      "Demo — this runs with no server, so answers stay in this browser and the table cannot be shared.";
    document.body.prepend(note);
  });
})();
