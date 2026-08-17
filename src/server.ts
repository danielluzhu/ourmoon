import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { AUDIO_DIR, db, joinCode, uid } from "./db";
import { CATEGORIES, drawPrompt } from "./prompts";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const COOKIE = "ft_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 180; // 180 days — families should not have to log in again
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 2000;
const MAX_DURATION_MS = 120_000;

/** Recording containers we accept, mapped to the extension we store them under. */
const AUDIO_TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};
const EXT_TO_MIME: Record<string, string> = {
  webm: "audio/webm",
  ogg: "audio/ogg",
  mp4: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

/** Drop codec parameters, and treat the video/* containers as their audio-only twin. */
function normalizeMime(raw: string): string {
  const base = raw.split(";")[0].trim().toLowerCase();
  return base.startsWith("video/") ? base.replace("video/", "audio/") : base;
}

type Member = { id: string; table_id: string; name: string; hue: number; created_at: number };
type Table = { id: string; name: string; join_code: string; created_at: number };

// ---------------------------------------------------------------- helpers

const json = (data: unknown, init: ResponseInit = {}) =>
  Response.json(data, { ...init, headers: { "cache-control": "no-store", ...init.headers } });

const fail = (status: number, message: string) => json({ error: message }, { status });

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function sessionCookie(token: string, secure: boolean): string {
  const flags = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE}`,
  ];
  if (secure) flags.push("Secure");
  return flags.join("; ");
}

function isSecure(req: Request): boolean {
  return req.headers.get("x-forwarded-proto") === "https" || new URL(req.url).protocol === "https:";
}

function cleanName(raw: unknown, max = 40): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

// ---------------------------------------------------------------- queries

const q = {
  tableByCode: db.query<Table, [string]>("SELECT * FROM tables WHERE join_code = ?"),
  tableById: db.query<Table, [string]>("SELECT * FROM tables WHERE id = ?"),
  insertTable: db.query(
    "INSERT INTO tables (id, name, join_code, created_at) VALUES (?, ?, ?, ?)",
  ),
  insertMember: db.query(
    "INSERT INTO members (id, table_id, name, hue, created_at) VALUES (?, ?, ?, ?, ?)",
  ),
  membersOf: db.query<Member, [string]>(
    "SELECT * FROM members WHERE table_id = ? ORDER BY created_at",
  ),
  memberBySession: db.query<Member, [string]>(
    "SELECT m.* FROM members m JOIN sessions s ON s.member_id = m.id WHERE s.token = ?",
  ),
  insertSession: db.query("INSERT INTO sessions (token, member_id, created_at) VALUES (?, ?, ?)"),
  deleteSession: db.query("DELETE FROM sessions WHERE token = ?"),
  insertRound: db.query(
    `INSERT INTO rounds (id, table_id, prompt_id, category, prompt_text, prompt_alt, opened_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  roundsOf: db.query<any, [string]>(
    "SELECT * FROM rounds WHERE table_id = ? ORDER BY created_at DESC",
  ),
  roundById: db.query<any, [string]>("SELECT * FROM rounds WHERE id = ?"),
  usedPromptIds: db.query<{ prompt_id: string }, [string]>(
    "SELECT prompt_id FROM rounds WHERE table_id = ?",
  ),
  responsesOfTable: db.query<any, [string]>(
    `SELECT r.* FROM responses r JOIN rounds rd ON rd.id = r.round_id
     WHERE rd.table_id = ? ORDER BY r.created_at`,
  ),
  responseByMemberRound: db.query<any, [string, string]>(
    "SELECT * FROM responses WHERE round_id = ? AND member_id = ?",
  ),
  insertResponse: db.query(
    `INSERT INTO responses (id, round_id, member_id, kind, text, audio_file, audio_mime, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  responseById: db.query<any, [string]>("SELECT * FROM responses WHERE id = ?"),
  deleteResponse: db.query("DELETE FROM responses WHERE id = ?"),
};

function currentMember(req: Request): Member | null {
  const token = readCookie(req, COOKIE);
  return token ? (q.memberBySession.get(token) ?? null) : null;
}

function createSession(memberId: string): string {
  const token = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
  q.insertSession.run(token, memberId, Date.now());
  return token;
}

/**
 * Keep the readable stem, re-roll the tail until the code is free. If a name is
 * genuinely crowded (twenty "Smiths" already), widen the tail rather than spin.
 */
function uniqueJoinCode(tableName: string): string {
  for (let tailLength = 2; ; tailLength++) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = joinCode(tableName, tailLength);
      if (!q.tableByCode.get(code)) return code;
    }
  }
}

function nextHue(tableId: string): number {
  // Spread member colors around the wheel by golden angle, offset per table size.
  return (q.membersOf.all(tableId).length * 137 + 20) % 360;
}

/** Everything the client needs to render the table, in one shot. */
function tableState(member: Member) {
  const table = q.tableById.get(member.table_id)!;
  const members = q.membersOf.all(member.table_id);
  const rounds = q.roundsOf.all(member.table_id);
  const responses = q.responsesOfTable.all(member.table_id);

  const byRound = new Map<string, any[]>();
  for (const r of responses) {
    if (!byRound.has(r.round_id)) byRound.set(r.round_id, []);
    byRound.get(r.round_id)!.push({
      id: r.id,
      memberId: r.member_id,
      kind: r.kind,
      text: r.text,
      audioUrl: r.audio_file ? `/media/${r.audio_file}` : null,
      durationMs: r.duration_ms,
      createdAt: r.created_at,
      mine: r.member_id === member.id,
    });
  }

  return {
    me: { id: member.id, name: member.name, hue: member.hue },
    table: { id: table.id, name: table.name, joinCode: table.join_code },
    // Ordered by when they sat down, so the first row is whoever set the table.
    members: members.map((m, i) => ({
      id: m.id,
      name: m.name,
      hue: m.hue,
      joinedAt: m.created_at,
      host: i === 0,
    })),
    categories: CATEGORIES,
    rounds: rounds.map((r) => ({
      id: r.id,
      promptId: r.prompt_id,
      category: r.category,
      categoryLabel: CATEGORIES[r.category]?.label ?? r.category,
      text: r.prompt_text,
      alt: r.prompt_alt,
      openedBy: r.opened_by,
      createdAt: r.created_at,
      responses: byRound.get(r.id) ?? [],
    })),
  };
}

// ---------------------------------------------------------------- routes

async function handleApi(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  // --- create a table -----------------------------------------------------
  if (path === "/api/tables" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    const tableName = cleanName(body.tableName, 60);
    const memberName = cleanName(body.name);
    if (!tableName) return fail(400, "Give your table a name.");
    if (!memberName) return fail(400, "Tell us your name.");

    const now = Date.now();
    const tableId = uid();
    const code = uniqueJoinCode(tableName);

    const memberId = uid();
    db.transaction(() => {
      q.insertTable.run(tableId, tableName, code, now);
      q.insertMember.run(memberId, tableId, memberName, 20, now);
    })();

    return json({ ok: true, joinCode: code }, {
      headers: { "set-cookie": sessionCookie(createSession(memberId), isSecure(req)) },
    });
  }

  // --- join an existing table --------------------------------------------
  if (path === "/api/join" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    const code = cleanName(body.joinCode, 12).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const memberName = cleanName(body.name);
    if (!memberName) return fail(400, "Tell us your name.");

    const table = q.tableByCode.get(code);
    if (!table) return fail(404, "No table with that code.");

    const existing = q.membersOf
      .all(table.id)
      .find((m) => m.name.toLowerCase() === memberName.toLowerCase());

    // Rejoining from a new device should land you back on your own seat.
    const memberId = existing?.id ?? uid();
    if (!existing) {
      q.insertMember.run(memberId, table.id, memberName, nextHue(table.id), Date.now());
    }

    return json({ ok: true, rejoined: Boolean(existing) }, {
      headers: { "set-cookie": sessionCookie(createSession(memberId), isSecure(req)) },
    });
  }

  if (path === "/api/logout" && method === "POST") {
    const token = readCookie(req, COOKIE);
    if (token) q.deleteSession.run(token);
    return json({ ok: true }, {
      headers: { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` },
    });
  }

  // Everything past here needs a seat at a table.
  const me = currentMember(req);
  if (!me) return fail(401, "Not signed in.");

  if (path === "/api/state" && method === "GET") {
    return json(tableState(me));
  }

  // --- draw a new topic ---------------------------------------------------
  if (path === "/api/rounds" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    const category = typeof body.category === "string" && body.category in CATEGORIES
      ? body.category
      : undefined;

    const members = q.membersOf.all(me.table_id);
    const { prompt, text } = drawPrompt({
      usedIds: q.usedPromptIds.all(me.table_id).map((r) => r.prompt_id),
      memberNames: members.map((m) => m.name),
      category,
    });

    const roundId = uid();
    q.insertRound.run(
      roundId,
      me.table_id,
      prompt.id,
      prompt.category,
      text,
      prompt.alt ?? null,
      me.id,
      Date.now(),
    );
    return json({ ok: true, roundId });
  }

  // --- answer a topic -----------------------------------------------------
  if (path === "/api/responses" && method === "POST") {
    const form = await req.formData().catch(() => null);
    if (!form) return fail(400, "Expected a form upload.");

    const roundId = String(form.get("roundId") ?? "");
    const round = q.roundById.get(roundId);
    if (!round || round.table_id !== me.table_id) return fail(404, "No such topic.");

    if (q.responseByMemberRound.get(roundId, me.id)) {
      return fail(409, "You have already answered this one. Delete your answer to redo it.");
    }

    const durationMs = Math.min(Number(form.get("durationMs") ?? 0) || 0, MAX_DURATION_MS);
    const audio = form.get("audio");
    const text = cleanName(form.get("text"), MAX_TEXT_CHARS);

    let kind: "audio" | "text";
    let audioFile: string | null = null;
    let audioMime: string | null = null;

    if (audio instanceof Blob && audio.size > 0) {
      if (audio.size > MAX_AUDIO_BYTES) return fail(413, "That recording is too long.");
      // Browsers disagree on container: Chrome/Firefox give webm, Safari gives mp4.
      // The client tells us which; the blob's own type is only a fallback.
      const declared = String(form.get("mime") ?? "") || audio.type;
      const ext = AUDIO_TYPES[normalizeMime(declared)];
      if (!ext) return fail(415, "That audio format isn't supported.");
      kind = "audio";
      audioMime = EXT_TO_MIME[ext];
      audioFile = `${uid()}.${ext}`;
      await Bun.write(join(AUDIO_DIR, audioFile), audio);
    } else if (text) {
      kind = "text";
    } else {
      return fail(400, "Record something or write something.");
    }

    const id = uid();
    q.insertResponse.run(
      id,
      roundId,
      me.id,
      kind,
      kind === "text" ? text : (text || null),
      audioFile,
      audioMime,
      durationMs || null,
      Date.now(),
    );
    return json({ ok: true, id });
  }

  // --- take an answer back ------------------------------------------------
  const del = path.match(/^\/api\/responses\/([\w-]+)$/);
  if (del && method === "DELETE") {
    const response = q.responseById.get(del[1]);
    if (!response) return fail(404, "Already gone.");
    if (response.member_id !== me.id) return fail(403, "That one isn't yours.");

    q.deleteResponse.run(response.id);
    if (response.audio_file) {
      await unlink(join(AUDIO_DIR, response.audio_file)).catch(() => {});
    }
    return json({ ok: true });
  }

  return fail(404, "Unknown endpoint.");
}

// ---------------------------------------------------------------- serve

const server = Bun.serve({
  port: PORT,
  hostname: process.env.HOST ?? "0.0.0.0",
  maxRequestBodySize: MAX_AUDIO_BYTES + 1024 * 1024,

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, url);
      } catch (err) {
        console.error("api error", url.pathname, err);
        return fail(500, "Something went wrong on our end.");
      }
    }

    // Recorded audio. Names are server-generated UUIDs; anything else is refused.
    const media = url.pathname.match(/^\/media\/([0-9a-f-]{36})\.(webm|ogg|mp4|mp3|wav)$/);
    if (media) {
      if (!currentMember(req)) return fail(401, "Not signed in.");
      const file = Bun.file(join(AUDIO_DIR, `${media[1]}.${media[2]}`));
      if (!(await file.exists())) return fail(404, "Recording not found.");
      return new Response(file, {
        headers: {
          "content-type": EXT_TO_MIME[media[2]],
          "cache-control": "private, max-age=31536000",
        },
      });
    }

    if (url.pathname === "/healthz") return new Response("ok");

    const asset = url.pathname === "/" ? "/index.html" : url.pathname;
    if (/^\/[\w.-]+$/.test(asset)) {
      const file = Bun.file(join(PUBLIC_DIR, asset));
      if (await file.exists()) return new Response(file);
    }

    return new Response(Bun.file(join(PUBLIC_DIR, "index.html")), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`Family Table listening on http://${server.hostname}:${server.port}`);
