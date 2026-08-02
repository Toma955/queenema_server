import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID, timingSafeEqual } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const mediaDir = path.join(dataDir, "media");
const storePath = path.join(dataDir, "store.json");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

/**
 * Slider 0–100
 * 0  = crno — briše razgovor
 * <40 = limity (broj poruka + znakovi)
 * 40–59 = sredina, bez limity
 * ≥60 = glas
 * ≥75 = poziv + video
 * 100 = poziv na kavu
 */
export const PATIENCE = {
  MIN: 0,
  MID: 50,
  MAX: 100,
  WIPE: 0,
  LIMIT_MAX: 39,
  FREE_TEXT: 40,
  VOICE: 60,
  CALL: 75,
  COFFEE: 100,
};

export const EMA = {
  username: "ema",
  password: "ema",
  name: "Ema",
};

function defaultStore() {
  return {
    settings: { acceptNewConversations: false },
    requests: [],
    conversations: [],
    messages: [],
    nextId: 1,
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
    return {
      ...defaultStore(),
      ...parsed,
      settings: { ...defaultStore().settings, ...(parsed.settings || {}) },
      requests: parsed.requests || [],
      conversations: parsed.conversations || [],
      messages: parsed.messages || [],
      nextId: parsed.nextId || 1,
    };
  } catch {
    const store = defaultStore();
    saveStore(store);
    return store;
  }
}

function saveStore(s) {
  fs.writeFileSync(storePath, JSON.stringify(s, null, 2));
}

let store = loadStore();

function nextId() {
  const id = store.nextId++;
  saveStore(store);
  return id;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function limitsForPatience(patience) {
  const p = Number(patience) || 0;
  if (p <= PATIENCE.WIPE) {
    return { wipe: true, maxMessages: 0, maxChars: 0 };
  }
  if (p <= PATIENCE.LIMIT_MAX) {
    const t = p / PATIENCE.FREE_TEXT; // 0..~1
    return {
      wipe: false,
      maxMessages: Math.max(3, Math.round(3 + t * 47)),
      maxChars: Math.max(24, Math.round(24 + t * 176)),
    };
  }
  return { wipe: false, maxMessages: null, maxChars: null };
}

export function featuresForPatience(patience) {
  const p = Number(patience) || 0;
  const limits = limitsForPatience(p);
  return {
    wipe: p <= PATIENCE.WIPE,
    limited: p > PATIENCE.WIPE && p < PATIENCE.FREE_TEXT,
    voice: p >= PATIENCE.VOICE,
    call: p >= PATIENCE.CALL,
    video: p >= PATIENCE.CALL,
    coffee: p >= PATIENCE.COFFEE,
    maxMessages: limits.maxMessages,
    maxChars: limits.maxChars,
  };
}

export function getSettings() {
  return { ...store.settings };
}

export function setAcceptNewConversations(value) {
  store.settings.acceptNewConversations = Boolean(value);
  saveStore(store);
  return getSettings();
}

export function loginEma(username, password) {
  const u = String(username || "").trim().toLowerCase();
  const p = String(password || "");
  if (u !== EMA.username || !safeEqual(p, EMA.password)) {
    return { ok: false, error: "Pogrešan username ili password." };
  }
  return {
    ok: true,
    user: { role: "ema", name: EMA.name, username: EMA.username },
  };
}

function countMessages(conversationId, from) {
  return store.messages.filter(
    (m) => m.conversation_id === Number(conversationId) && (!from || m.from === from)
  ).length;
}

function publicConversation(c) {
  const guestSent = countMessages(c.id, "guest");
  const emaSent = countMessages(c.id, "ema");
  return {
    id: c.id,
    guestName: c.guestName,
    guestBio: c.guestBio || "",
    guestAvatar: c.guestAvatar || null,
    meta: c.meta || null,
    status: c.status,
    patience: c.patience,
    features: featuresForPatience(c.patience),
    score: c.patience,
    guestMessages: guestSent,
    emaMessages: emaSent,
    totalMessages: guestSent + emaSent,
    created_at: c.created_at,
    ended_at: c.ended_at || null,
    end_reason: c.end_reason || null,
    coffeeInvited: Boolean(c.coffeeInvited),
  };
}

export function getLeaderboard() {
  const rows = store.conversations.map((c) => publicConversation(c));
  return {
    byScore: [...rows].sort((a, b) => b.score - a.score || b.totalMessages - a.totalMessages),
    byMessages: [...rows].sort((a, b) => b.totalMessages - a.totalMessages || b.score - a.score),
  };
}

export function getStateForEma() {
  return {
    settings: getSettings(),
    requests: store.requests.filter((r) => r.status === "pending"),
    conversations: store.conversations
      .filter((c) => c.status === "active")
      .map(publicConversation),
    leaderboard: getLeaderboard(),
  };
}

export function getPublicAvailability() {
  return { acceptNewConversations: store.settings.acceptNewConversations };
}

function saveAvatar(avatar, mimeHint = "image/jpeg") {
  if (!avatar || typeof avatar !== "string") return null;
  let mime = mimeHint;
  let raw = avatar;
  const match = avatar.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (match) {
    mime = match[1];
    raw = match[2];
  } else {
    raw = avatar.replace(/^data:image\/[\w+.-]+;base64,/, "");
  }
  let buf;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  if (buf.length < 100 || buf.length > 3_000_000) return null;
  const ext = mime.includes("png")
    ? "png"
    : mime.includes("webp")
      ? "webp"
      : "jpg";
  const filename = `avatar-${randomUUID()}.${ext}`;
  const full = path.join(mediaDir, filename);
  fs.writeFileSync(full, buf);
  return `/api/media/${filename}`;
}

export function createRequest({ name, bio, avatar, avatarMime, meta, guestToken }) {
  if (!store.settings.acceptNewConversations) {
    return { ok: false, error: "Ema trenutno ne prima nove razgovore." };
  }
  if (!meta?.cookiesAccepted) {
    return { ok: false, error: "Cookies privola je obavezna." };
  }

  // Jedan chat po korisniku: postojeći token / aktivni ili pending
  const existingToken = String(guestToken || "").trim();
  if (existingToken) {
    const active = getConversationByGuestToken(existingToken);
    if (active?.status === "active") {
      return {
        ok: false,
        error: "Već imaš aktivan razgovor.",
        code: "already_active",
        guestToken: existingToken,
      };
    }
    const pending = getRequestByToken(existingToken);
    if (pending?.status === "pending") {
      return {
        ok: false,
        error: "Zahtjev već čeka Emine odgovor.",
        code: "already_pending",
        guestToken: existingToken,
        request: {
          id: pending.id,
          guestName: pending.guestName,
          guestBio: pending.guestBio,
          guestAvatar: pending.guestAvatar,
          meta: pending.meta,
          guestToken: pending.guestToken,
          status: pending.status,
          created_at: pending.created_at,
        },
      };
    }
  }

  const ip = String(meta?.ip || "").slice(0, 64);
  if (ip) {
    const busyConv = store.conversations.find(
      (c) => c.status === "active" && c.meta?.ip === ip
    );
    if (busyConv) {
      return { ok: false, error: "Već imaš aktivan razgovor s ove adrese.", code: "already_active" };
    }
    const busyReq = store.requests.find(
      (r) => r.status === "pending" && r.meta?.ip === ip
    );
    if (busyReq) {
      return {
        ok: false,
        error: "Već imaš zahtjev na čekanju.",
        code: "already_pending",
        guestToken: busyReq.guestToken,
      };
    }
  }

  const guestName = String(name || "").trim().slice(0, 32);
  if (!guestName) return { ok: false, error: "Ime je obavezno." };
  const guestBio = String(bio || "").trim().slice(0, 500);
  if (!guestBio) return { ok: false, error: "Opis je obavezan." };
  const guestAvatar = saveAvatar(avatar, avatarMime || "image/jpeg");
  if (!guestAvatar) return { ok: false, error: "Slika je obavezna (jpg/png)." };

  const request = {
    id: nextId(),
    guestName,
    guestBio,
    guestAvatar,
    meta: {
      device: meta?.device === "mobile" ? "mobile" : "desktop",
      ip,
      userAgent: String(meta?.userAgent || "").slice(0, 240),
      cookiesAccepted: Boolean(meta?.cookiesAccepted),
      at: new Date().toISOString(),
    },
    guestToken: randomUUID(),
    status: "pending",
    created_at: new Date().toISOString(),
  };
  store.requests.push(request);
  saveStore(store);
  return {
    ok: true,
    guestToken: request.guestToken,
    request: {
      id: request.id,
      guestName: request.guestName,
      guestBio: request.guestBio,
      guestAvatar: request.guestAvatar,
      meta: request.meta,
      guestToken: request.guestToken,
      status: request.status,
      created_at: request.created_at,
    },
  };
}

export function respondToRequest(requestId, accept) {
  const request = store.requests.find(
    (r) => r.id === Number(requestId) && r.status === "pending"
  );
  if (!request) return { ok: false, error: "Zahtjev nije pronađen." };

  if (!accept) {
    request.status = "rejected";
    saveStore(store);
    return { ok: true, rejected: true, requestId: request.id, guestToken: request.guestToken };
  }

  request.status = "accepted";
  const alreadyActive = store.conversations.find(
    (c) => c.status === "active" && c.guestToken === request.guestToken
  );
  if (alreadyActive) {
    saveStore(store);
    return {
      ok: true,
      conversation: publicConversation(alreadyActive),
      guestToken: request.guestToken,
    };
  }

  const conversation = {
    id: nextId(),
    guestName: request.guestName,
    guestBio: request.guestBio,
    guestAvatar: request.guestAvatar,
    meta: request.meta,
    guestToken: request.guestToken,
    status: "active",
    patience: PATIENCE.MID,
    coffeeInvited: false,
    created_at: new Date().toISOString(),
    ended_at: null,
    end_reason: null,
  };
  store.conversations.push(conversation);
  saveStore(store);
  return {
    ok: true,
    conversation: publicConversation(conversation),
    guestToken: request.guestToken,
  };
}

export function getConversation(id) {
  return store.conversations.find((c) => c.id === Number(id)) || null;
}

export function getConversationByGuestToken(token) {
  return store.conversations.find((c) => c.guestToken === token) || null;
}

export function getRequestByToken(token) {
  return store.requests.find((r) => r.guestToken === token) || null;
}

/** Briše razgovor i poruke (gost više ne vidi ništa) */
export function wipeConversation(conversationId) {
  const c = getConversation(conversationId);
  if (!c) return { ok: false, error: "Razgovor nije pronađen." };

  const msgs = store.messages.filter((m) => m.conversation_id === c.id);
  for (const m of msgs) {
    try {
      if (m.media_path && fs.existsSync(m.media_path)) fs.unlinkSync(m.media_path);
    } catch {
      /* ignore */
    }
  }
  store.messages = store.messages.filter((m) => m.conversation_id !== c.id);
  store.conversations = store.conversations.filter((x) => x.id !== c.id);
  saveStore(store);
  return {
    ok: true,
    wiped: true,
    conversationId: c.id,
    guestToken: c.guestToken,
  };
}

export function setPatience(conversationId, patience) {
  const c = getConversation(conversationId);
  if (!c || c.status !== "active") return { ok: false, error: "Razgovor nije aktivan." };

  const next = Math.max(PATIENCE.MIN, Math.min(PATIENCE.MAX, Math.round(Number(patience))));
  c.patience = next;

  if (next >= PATIENCE.COFFEE) c.coffeeInvited = true;
  saveStore(store);

  if (next <= PATIENCE.WIPE) {
    return wipeConversation(c.id);
  }

  return { ok: true, conversation: publicConversation(c) };
}

export function endConversation(conversationId, reason = "manual") {
  const c = getConversation(conversationId);
  if (!c) return { ok: false, error: "Razgovor nije pronađen." };
  if (c.status === "ended") return { ok: true, conversation: publicConversation(c) };
  c.status = "ended";
  c.ended_at = new Date().toISOString();
  c.end_reason = reason;
  saveStore(store);
  return { ok: true, conversation: publicConversation(c) };
}

function mapMessage(m) {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    from: m.from,
    type: m.type,
    text: m.text || "",
    media_url: m.media_path ? `/api/media/${path.basename(m.media_path)}` : null,
    created_at: m.created_at,
  };
}

export function getMessages(conversationId, limit = 500) {
  return store.messages
    .filter((m) => m.conversation_id === Number(conversationId))
    .slice(-limit)
    .map(mapMessage);
}

export function createTextMessage(conversationId, from, text) {
  const c = getConversation(conversationId);
  if (!c || c.status !== "active") return { ok: false, error: "Razgovor nije aktivan." };

  const feats = featuresForPatience(c.patience);
  const trimmed = String(text || "").trim();
  if (!trimmed) return { ok: false, error: "Poruka je prazna." };

  if (feats.maxChars != null && trimmed.length > feats.maxChars) {
    return {
      ok: false,
      error: `Previše znakova (max ${feats.maxChars}) — strpljenje je lijevo.`,
    };
  }

  if (feats.maxMessages != null && from === "guest") {
    const guestCount = countMessages(c.id, "guest");
    if (guestCount >= feats.maxMessages) {
      return {
        ok: false,
        error: `Limit poruka (${feats.maxMessages}) — Ema mora pomaknuti strpljenje desno.`,
      };
    }
  }

  const message = {
    id: nextId(),
    conversation_id: c.id,
    from,
    type: "text",
    text: trimmed,
    media_path: null,
    created_at: new Date().toISOString(),
  };
  store.messages.push(message);
  saveStore(store);

  return {
    ok: true,
    message: mapMessage(message),
    conversation: publicConversation(c),
  };
}

export function createVoiceMessage(conversationId, from, base64Audio, mime = "audio/webm") {
  const c = getConversation(conversationId);
  if (!c || c.status !== "active") return { ok: false, error: "Razgovor nije aktivan." };
  if (!featuresForPatience(c.patience).voice) {
    return { ok: false, error: "Glasovne još nisu otključane." };
  }

  const clean = String(base64Audio || "").replace(/^data:audio\/\w+;base64,/, "");
  let buffer;
  try {
    buffer = Buffer.from(clean, "base64");
  } catch {
    return { ok: false, error: "Audio nije valjan." };
  }
  if (buffer.length < 100 || buffer.length > 3_000_000) {
    return { ok: false, error: "Audio nije prihvatljiv." };
  }

  const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
  const fullPath = path.join(mediaDir, `${randomUUID()}.${ext}`);
  fs.writeFileSync(fullPath, buffer);

  const message = {
    id: nextId(),
    conversation_id: c.id,
    from,
    type: "voice",
    text: "",
    media_path: fullPath,
    created_at: new Date().toISOString(),
  };
  store.messages.push(message);
  saveStore(store);
  return { ok: true, message: mapMessage(message), conversation: publicConversation(c) };
}

export function resolveMediaFile(filename) {
  const safe = path.basename(filename);
  const full = path.join(mediaDir, safe);
  if (!full.startsWith(mediaDir) || !fs.existsSync(full)) return null;
  return full;
}
