import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const voiceDir = path.join(dataDir, "voice");
const storePath = path.join(dataDir, "store.json");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(voiceDir)) fs.mkdirSync(voiceDir, { recursive: true });

export const ROLES = {
  toma: { role: "toma", name: "Toma", label: "Admin (desktop)" },
  ema: { role: "ema", name: "Ema", label: "Mobile" },
};

export const MODES = ["update", "sleep", "chat"];

function defaultStore() {
  return {
    users: [
      { id: 1, name: "Toma", role: "toma", created_at: new Date().toISOString() },
      { id: 2, name: "Ema", role: "ema", created_at: new Date().toISOString() },
    ],
    messages: [],
    settings: { mode: "chat" },
    nextMessageId: 1,
  };
}

function loadStore() {
  if (!fs.existsSync(storePath)) {
    const store = defaultStore();
    saveStore(store);
    return store;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    if (!parsed.users?.length) parsed.users = defaultStore().users;
    if (!parsed.settings) parsed.settings = { mode: "chat" };
    if (!Array.isArray(parsed.messages)) parsed.messages = [];
    if (!parsed.nextMessageId) parsed.nextMessageId = 1;
    return parsed;
  } catch {
    const store = defaultStore();
    saveStore(store);
    return store;
  }
}

function saveStore(store) {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

let store = loadStore();

export function getMode() {
  return store.settings.mode || "chat";
}

export function setMode(mode) {
  if (!MODES.includes(mode)) return { ok: false, error: "Nepoznat mode." };
  store.settings.mode = mode;
  saveStore(store);
  return { ok: true, mode };
}

export function listUsers() {
  return store.users
    .filter((u) => u.role === "toma" || u.role === "ema")
    .sort((a, b) => (a.role === "toma" ? -1 : 1));
}

export function getUserById(id) {
  return store.users.find((u) => u.id === Number(id)) || null;
}

export function getUserByRole(role) {
  return store.users.find((u) => u.role === role) || null;
}

export function joinAsRole(roleKey) {
  const fixed = ROLES[roleKey];
  if (!fixed) return { ok: false, error: "Samo Toma i Ema." };
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
  return store.messages.slice(-limit).map(mapMessage);
}

export function createTextMessage(userId, text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { ok: false, error: "Poruka je prazna." };
  if (trimmed.length > 2000) return { ok: false, error: "Poruka je preduga." };
  const user = getUserById(userId);
  if (!user) return { ok: false, error: "Korisnik nije pronađen." };

  const message = {
    id: store.nextMessageId++,
    user_id: user.id,
    user_name: user.name,
    user_role: user.role,
    type: "text",
    text: trimmed,
    media_path: null,
    created_at: new Date().toISOString(),
  };
  store.messages.push(message);
  saveStore(store);
  return { ok: true, message: mapMessage(message) };
}

export function createVoiceMessage(userId, base64Audio, mime = "audio/webm") {
  const user = getUserById(userId);
  if (!user) return { ok: false, error: "Korisnik nije pronađen." };
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

  const message = {
    id: store.nextMessageId++,
    user_id: user.id,
    user_name: user.name,
    user_role: user.role,
    type: "voice",
    text: "",
    media_path: fullPath,
    created_at: new Date().toISOString(),
  };
  store.messages.push(message);
  saveStore(store);
  return { ok: true, message: mapMessage(message) };
}

export function resolveVoiceFile(filename) {
  const safe = path.basename(filename);
  const full = path.join(voiceDir, safe);
  if (!full.startsWith(voiceDir) || !fs.existsSync(full)) return null;
  return full;
}

export function clearMessages() {
  for (const m of store.messages) {
    try {
      if (m.media_path && fs.existsSync(m.media_path)) fs.unlinkSync(m.media_path);
    } catch {
      /* ignore */
    }
  }
  store.messages = [];
  saveStore(store);
}
