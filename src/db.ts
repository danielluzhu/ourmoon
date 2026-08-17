import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const DATA_DIR = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");
export const AUDIO_DIR = join(DATA_DIR, "audio");

mkdirSync(AUDIO_DIR, { recursive: true });

export const db = new Database(join(DATA_DIR, "familytable.sqlite"), { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS tables (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    join_code  TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS members (
    id         TEXT PRIMARY KEY,
    table_id   TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    hue        INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rounds (
    id          TEXT PRIMARY KEY,
    table_id    TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    prompt_id   TEXT NOT NULL,
    category    TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    prompt_alt  TEXT,
    opened_by   TEXT REFERENCES members(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS responses (
    id          TEXT PRIMARY KEY,
    round_id    TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('audio', 'text')),
    text        TEXT,
    audio_file  TEXT,
    audio_mime  TEXT,
    duration_ms INTEGER,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_members_table    ON members(table_id);
  CREATE INDEX IF NOT EXISTS idx_rounds_table     ON rounds(table_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_responses_round  ON responses(round_id, created_at);
`);

export function uid(): string {
  return crypto.randomUUID();
}

/** No vowels (so random runs never spell anything) and no 0/1/I/O (misread over the phone). */
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXYZ23456789";

function randomChars(count: number): string {
  if (count <= 0) return "";
  const bytes = crypto.getRandomValues(new Uint8Array(count));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/**
 * The readable part of a code, taken from the table's name.
 * "The Zhu Table" -> "ZHUTAB", "Café Müller" -> "CAFEMU", "陈家" -> "".
 */
export function codeStem(tableName: string): string {
  return tableName
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // fold accents rather than drop the letter
    .toUpperCase()
    .replace(/^THE\b/, "")
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

/**
 * A join code that reads like the table it belongs to, with a random tail so two
 * families with the same name do not collide — and so the code is not purely a
 * guess away for anyone who knows the family's name.
 */
export function joinCode(tableName: string, tailLength = 2): string {
  const stem = codeStem(tableName);
  // Names that survive as nothing (or almost nothing) still need something to hold on to.
  const padding = randomChars(Math.max(0, 3 - stem.length));
  return stem + padding + randomChars(tailLength);
}
