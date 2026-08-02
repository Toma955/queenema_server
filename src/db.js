import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const voiceDir = path.join(dataDir, "voice");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(voiceDir)) fs.mkdirSync(voiceDir, { recursive: true });

const db = new Database(path.join(dataDir, "queenema.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    text TEXT NOT NULL DEFAULT '',
    media_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const msgCols = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
if (!msgCols.includes("type")) db.exec("ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'");
if (!msgCols.includes("media_path")) db.exec("ALTER TABLE messages ADD COLUMN media_path TEXT");

const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userCols.includes("role")) db.exec("ALTER TABLE users ADD COLUMN role TEXT");

export const ROLES = {
  toma: { role: "toma", name: "Toma", label: "Admin (desktop)" },
  ema: { role: "ema", name: "Ema", label: "Mobile" },
};

export const MODES = ["update", "sleep", "chat"];

function ensureFixedUsers() {
  for (const fixed of Object.values(ROLES)) {
    const byRole = db.prepare("SELECT id FROM users WHERE role = ?").get(fixed.role);
    if (byRole) continue;
    const byName = db
      .prepare("SELECT id FROM users WHERE name = ? COLLATE NOCASE")
      .get(fixed.name);
    if (byName) {
      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(fixed.role, byName.id);
    } else {
      db.prepare("INSERT INTO users (name, role) VALUES (?, ?)").run(fixed.name, fixed.role);
    }
  }
}

function ensureSettings() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'mode'").get();
  if (!row) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('mode', 'chat')").run();
  }
}

ensureFixedUsers();
ensureSettings();

export function getMode() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'mode'").get();
  return row?.value || "chat";
}

export function setMode(mode) {
  if (!MODES.includes(mode)) {
    return { ok: false, error: "Nepoznat mode." };
  }
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(mode);
  return { ok: true, mode };
}

export function listUsers() {
  return db
    .prepare(
      `SELECT id, name, role, created_at FROM users
       WHERE role IN ('toma', 'ema')
       ORDER BY CASE role WHEN 'toma' THEN 0 ELSE 1 END`
    )
    .all();
}

export function getUserById(id) {
  return db.prepare("SELECT id, name, role, created_at FROM users WHERE id = ?").get(id);
}

export function getUserByRole(role) {
  return db.prepare("SELECT id, name, role, created_at FROM users WHERE role = ?").get(role);
}

export function joinAsRole(roleKey) {
  const fixed = ROLES[roleKey];
  if (!fixed) {
    return { ok: false, error: "Samo Toma i Ema." };
  }
  ensureFixedUsers();
  const user = getUserByRole(fixed.role);
  if (!user) return { ok: false, error: "Korisnik nije pronađen." };
  return { ok: true, user };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type || "text",
    text: row.text || "",
    media_url: row.media_path ? `/api/voice/${path.basename(row.media_path)}` : null,
    created_at: row.created_at,
    user_id: row.user_id,
    user_name: row.user_name,
    user_role: row.user_role,
  };
}

export function getMessages(limit = 500) {
  const rows = db
    .prepare(
      `
      SELECT m.id, m.type, m.text, m.media_path, m.created_at,
             u.id AS user_id, u.name AS user_name, u.role AS user_role
      FROM messages m
      JOIN users u ON u.id = m.user_id
      ORDER BY m.id ASC
      LIMIT ?
    `
    )
    .all(limit);
  return rows.map(mapMessage);
}

export function createTextMessage(userId, text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { ok: false, error: "Poruka je prazna." };
  if (trimmed.length > 2000) return { ok: false, error: "Poruka je preduga." };
  if (!getUserById(userId)) return { ok: false, error: "Korisnik nije pronađen." };

  const result = db
    .prepare("INSERT INTO messages (user_id, type, text) VALUES (?, 'text', ?)")
    .run(userId, trimmed);

  return { ok: true, message: getMessageById(result.lastInsertRowid) };
}

export function createVoiceMessage(userId, base64Audio, mime = "audio/webm") {
  if (!getUserById(userId)) return { ok: false, error: "Korisnik nije pronađen." };
  if (!base64Audio || typeof base64Audio !== "string") {
    return { ok: false, error: "Nema audia." };
  }

  const clean = base64Audio.replace(/^data:audio\/\w+;base64,/, "");
  let buffer;
  try {
    buffer = Buffer.from(clean, "base64");
  } catch {
    return { ok: false, error: "Audio nije valjan." };
  }

  if (buffer.length < 100) return { ok: false, error: "Audio je prekratak." };
  if (buffer.length > 3_000_000) return { ok: false, error: "Audio je prevelik." };

  const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
  const filename = `${randomUUID()}.${ext}`;
  const fullPath = path.join(voiceDir, filename);
  fs.writeFileSync(fullPath, buffer);

  const result = db
    .prepare(
      "INSERT INTO messages (user_id, type, text, media_path) VALUES (?, 'voice', '', ?)"
    )
    .run(userId, fullPath);

  return { ok: true, message: getMessageById(result.lastInsertRowid) };
}

function getMessageById(id) {
  const row = db
    .prepare(
      `
      SELECT m.id, m.type, m.text, m.media_path, m.created_at,
             u.id AS user_id, u.name AS user_name, u.role AS user_role
      FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.id = ?
    `
    )
    .get(id);
  return mapMessage(row);
}

export function resolveVoiceFile(filename) {
  const safe = path.basename(filename);
  const full = path.join(voiceDir, safe);
  if (!full.startsWith(voiceDir) || !fs.existsSync(full)) return null;
  return full;
}

export function clearMessages() {
  const files = db.prepare("SELECT media_path FROM messages WHERE media_path IS NOT NULL").all();
  for (const f of files) {
    try {
      if (f.media_path && fs.existsSync(f.media_path)) fs.unlinkSync(f.media_path);
    } catch {
      /* ignore */
    }
  }
  db.prepare("DELETE FROM messages").run();
}
