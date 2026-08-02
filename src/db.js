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
 * Slider 0–100 — unlockovi po redoslijedu ikona (honeycomb L→D).
 * Lijevo od ∞: limiti + like + smile (kumulativno se ne gase).
 * Desno od ∞: voice → photo → call → video → heart → coffee.
 * Ispod ∞ (p < 50): desni unlockovi se gase; limiti vrijede.
 */
const STEP = 100 / 6;

export const PATIENCE = {
  MIN: 0,
  MID: 50,
  MAX: 100,
  WIPE: 0,
  /** Zone limitu do ∞ — granice = pozicije soft / mid chipova */
  HARSH_MAX: Math.round(STEP * 1) - 1, // < soft (~17)
  SOFT_MAX: Math.round(STEP * 1.5) - 1, // < mid (25)
  LIMIT_MAX: 49,
  FREE_TEXT: 50,
  LIKE: Math.round(STEP * 2), // ~33
  SMILE: Math.round(STEP * 2.5), // ~42
  VOICE: Math.round(STEP * 3.5), // ~58
  PHOTO: Math.round(STEP * 4), // ~67
  CALL: Math.round(STEP * 4.5), // 75
  VIDEO: Math.round(STEP * 5), // ~83
  HEART: Math.round(STEP * 5.5), // ~92
  COFFEE: 100,
};

export const EMA_DEFAULTS = {
  username: "ema",
  password: "ema",
  name: "Ema",
};

export const ADMIN_DEFAULTS = {
  username: "admin",
  password: "admin",
  name: "Admin",
};

/** @deprecated use getEmaProfile() — kept for health payload */
export const EMA = EMA_DEFAULTS;

function defaultStore() {
  return {
    settings: { acceptNewConversations: false },
    profile: { ...EMA_DEFAULTS },
    adminProfile: { ...ADMIN_DEFAULTS },
    invites: [],
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
      profile: { ...EMA_DEFAULTS, ...(parsed.profile || {}) },
      adminProfile: { ...ADMIN_DEFAULTS, ...(parsed.adminProfile || {}) },
      invites: parsed.invites || [],
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
    return { wipe: true, maxMessages: 0, maxChars: 0, daily: 0 };
  }
  if (p <= PATIENCE.HARSH_MAX) {
    return { wipe: false, maxMessages: 1, maxChars: 50, daily: 1 };
  }
  if (p <= PATIENCE.SOFT_MAX) {
    return { wipe: false, maxMessages: 10, maxChars: 250, daily: 10 };
  }
  if (p < PATIENCE.FREE_TEXT) {
    return { wipe: false, maxMessages: 20, maxChars: 250, daily: 20 };
  }
  return { wipe: false, maxMessages: null, maxChars: null, daily: null };
}

export function featuresForPatience(patience) {
  const p = Number(patience) || 0;
  const limits = limitsForPatience(p);
  return {
    wipe: p <= PATIENCE.WIPE,
    limited: p > PATIENCE.WIPE && p < PATIENCE.FREE_TEXT,
    smile: p >= PATIENCE.SMILE,
    voice: p >= PATIENCE.VOICE,
    like: p >= PATIENCE.LIKE,
    photo: p >= PATIENCE.PHOTO,
    call: p >= PATIENCE.CALL,
    video: p >= PATIENCE.VIDEO,
    heart: p >= PATIENCE.HEART,
    coffee: p >= PATIENCE.COFFEE,
    maxMessages: limits.maxMessages,
    maxChars: limits.maxChars,
    daily: limits.daily,
  };
}

/** Gost ne smije slati smile / like / srce dok nije otključano */
const GUEST_GATES = [
  {
    feature: "smile",
    label: "smajlić",
    re: /[\u{1F600}-\u{1F60F}\u{1F61C}-\u{1F61D}\u{1F642}\u{1F917}\u{1F92A}\u{1F970}\u{1F972}\u{263A}\u{FE0F}]/u,
  },
  {
    feature: "like",
    label: "lajk",
    re: /[\u{1F44D}\u{1F44E}]|\u{1F44D}[\u{1F3FB}-\u{1F3FF}]?/u,
  },
  {
    feature: "heart",
    label: "srce",
    re: /[\u{2764}\u{FE0F}]|[\u{1F495}-\u{1F49F}\u{1F9E1}\u{1FA75}-\u{1FA77}\u{2665}]/u,
  },
];

export function guestContentBlocked(text, features) {
  const t = String(text || "");
  for (const gate of GUEST_GATES) {
    if (gate.re.test(t) && !features?.[gate.feature]) {
      return `Nemaš otključan ${gate.label} — Ema mora podići strpljenje.`;
    }
  }
  return null;
}

const REACTION_KIND = {
  smile: { feature: "smile", text: "😊", label: "smajlić" },
  like: { feature: "like", text: "👍", label: "lajk" },
  heart: { feature: "heart", text: "❤️", label: "srce" },
};

const CALL_KIND = {
  call: { feature: "call", text: "📞 Poziv", label: "poziv", type: "call" },
  video: { feature: "video", text: "📹 Videopoziv", label: "videopoziv", type: "video" },
};

export function getSettings() {
  return { ...store.settings };
}

export function setAcceptNewConversations(value) {
  store.settings.acceptNewConversations = Boolean(value);
  saveStore(store);
  return getSettings();
}

export function getEmaProfile() {
  return {
    username: store.profile.username,
    name: store.profile.name,
  };
}

export function loginEma(username, password) {
  const u = String(username || "").trim().toLowerCase();
  const p = String(password || "");
  const profile = store.profile || EMA_DEFAULTS;
  if (u !== String(profile.username).toLowerCase() || !safeEqual(p, profile.password)) {
    return { ok: false, error: "Pogrešan username ili password." };
  }
  return {
    ok: true,
    user: {
      role: "ema",
      name: profile.name,
      username: profile.username,
    },
  };
}

export function loginAdmin(username, password) {
  const u = String(username || "").trim().toLowerCase();
  const p = String(password || "");
  const profile = store.adminProfile || ADMIN_DEFAULTS;
  if (u !== String(profile.username).toLowerCase() || !safeEqual(p, profile.password)) {
    return { ok: false, error: "Pogrešan username ili password." };
  }
  return {
    ok: true,
    user: {
      role: "admin",
      name: profile.name,
      username: profile.username,
    },
  };
}

export function getAdminProfile() {
  const profile = store.adminProfile || ADMIN_DEFAULTS;
  return {
    username: profile.username,
    name: profile.name,
  };
}

export function updateAdminProfile({ name, username, password, currentPassword }) {
  const profile = store.adminProfile || { ...ADMIN_DEFAULTS };
  if (!safeEqual(String(currentPassword || ""), profile.password)) {
    return { ok: false, error: "Trenutna lozinka nije točna." };
  }
  const nextName = String(name ?? profile.name).trim().slice(0, 40);
  const nextUser = String(username ?? profile.username).trim().toLowerCase().slice(0, 32);
  if (!nextUser) return { ok: false, error: "Username je obavezan." };
  profile.name = nextName || profile.name;
  profile.username = nextUser;
  if (password) {
    const nextPass = String(password);
    if (nextPass.length < 3) return { ok: false, error: "Nova lozinka je prekratka." };
    profile.password = nextPass;
  }
  store.adminProfile = profile;
  saveStore(store);
  return {
    ok: true,
    user: { role: "admin", name: profile.name, username: profile.username },
  };
}

/** Admin može resetirati Emine podatke (bez Emine trenutne lozinke). */
export function adminUpdateEmaProfile({ name, username, password }) {
  const profile = store.profile || { ...EMA_DEFAULTS };
  const nextName = String(name ?? profile.name).trim().slice(0, 40);
  const nextUser = String(username ?? profile.username).trim().toLowerCase().slice(0, 32);
  if (!nextUser) return { ok: false, error: "Username je obavezan." };
  profile.name = nextName || profile.name;
  profile.username = nextUser;
  if (password) {
    const nextPass = String(password);
    if (nextPass.length < 3) return { ok: false, error: "Nova lozinka je prekratka." };
    profile.password = nextPass;
  }
  store.profile = profile;
  saveStore(store);
  return {
    ok: true,
    ema: { name: profile.name, username: profile.username },
  };
}

export function updateEmaProfile({ name, username, password, currentPassword }) {
  const profile = store.profile || { ...EMA_DEFAULTS };
  if (!safeEqual(String(currentPassword || ""), profile.password)) {
    return { ok: false, error: "Trenutna lozinka nije točna." };
  }

  const nextName = String(name ?? profile.name).trim().slice(0, 40);
  const nextUser = String(username ?? profile.username).trim().toLowerCase().slice(0, 32);
  if (!nextName) return { ok: false, error: "Ime je obavezno." };
  if (!nextUser) return { ok: false, error: "Username je obavezan." };

  profile.name = nextName;
  profile.username = nextUser;
  if (password != null && String(password).length) {
    const nextPass = String(password);
    if (nextPass.length < 3) return { ok: false, error: "Nova lozinka min. 3 znaka." };
    profile.password = nextPass;
  }
  store.profile = profile;
  saveStore(store);
  return {
    ok: true,
    user: { role: "ema", name: profile.name, username: profile.username },
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

/** Pun admin pregled — sve zahtjeve, sve razgovore, Emine podatke. */
export function getStateForAdmin() {
  return {
    settings: getSettings(),
    availability: getPublicAvailability(),
    ema: getEmaProfile(),
    admin: getAdminProfile(),
    requests: [...store.requests]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 100)
      .map((r) => ({
        id: r.id,
        guestName: r.guestName,
        guestBio: r.guestBio,
        guestAvatar: r.guestAvatar,
        status: r.status,
        meta: r.meta,
        created_at: r.created_at,
      })),
    conversations: store.conversations
      .map(publicConversation)
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))),
    leaderboard: getLeaderboard(),
  };
}

export function getPublicAvailability() {
  const hasActive = store.conversations.some((c) => c.status === "active");
  const hasPending = store.requests.some((r) => r.status === "pending");
  const occupied = hasActive || hasPending;
  const open = Boolean(store.settings.acceptNewConversations) && !occupied;
  return {
    acceptNewConversations: open,
    occupied,
    hasActive,
    hasPending,
  };
}

/** Otvori gost link — fiksni URL, bez UUID-a. */
export function createInvite() {
  store.settings.acceptNewConversations = true;
  saveStore(store);
  const url =
    (process.env.GUEST_URL || "https://queenema.art").replace(/\/$/, "");
  return { ok: true, url };
}

export function getInvite(token) {
  // Stari token linkovi više nisu potrebni — guest ide na /guest
  if (!token) return { ok: false, error: "Link nije valjan." };
  const avail = getPublicAvailability();
  if (!avail.acceptNewConversations) {
    return {
      ok: false,
      error: avail.occupied
        ? "Mjesto je zauzeto — netko već čeka ili razgovara s Emom."
        : "Prijava trenutno nije otvorena.",
    };
  }
  return { ok: true, invite: { token: "open", status: "open" } };
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

export function createRequest({
  name,
  firstName,
  lastName,
  bio,
  avatar,
  avatarMime,
  meta,
  guestToken,
  inviteToken,
}) {
  const avail = getPublicAvailability();
  if (!avail.acceptNewConversations) {
    return {
      ok: false,
      error: avail.occupied
        ? "Mjesto je zauzeto — netko već čeka ili razgovara s Emom."
        : "Ema trenutno ne prima nove razgovore.",
      code: avail.occupied ? "occupied" : "closed",
    };
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

  const first = String(firstName || "").trim().slice(0, 32);
  const last = String(lastName || "").trim().slice(0, 32);
  const fromLegacy = String(name || "").trim().slice(0, 48);
  let finalName = "";
  if (first || last || firstName != null || lastName != null) {
    if (!first) return { ok: false, error: "Ime je obavezno." };
    if (!last) return { ok: false, error: "Prezime je obavezno." };
    finalName = `${first} ${last}`.slice(0, 64);
  } else {
    finalName = fromLegacy;
    if (!finalName) return { ok: false, error: "Ime i prezime su obavezni." };
  }
  const guestBio = String(bio || "").trim().slice(0, 500);
  if (!guestBio) return { ok: false, error: "Opis je obavezan." };

  let guestAvatar = null;
  if (avatar) {
    guestAvatar = saveAvatar(avatar, avatarMime || "image/jpeg");
    if (!guestAvatar) {
      return { ok: false, error: "Slika nije valjana (jpg/png)." };
    }
  }

  const request = {
    id: nextId(),
    guestName: finalName,
    guestBio,
    guestAvatar,
    inviteToken: String(inviteToken || "").trim() || null,
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

  const prev = Number(c.patience) || 0;
  const prevFeats = featuresForPatience(prev);
  const next = Math.max(PATIENCE.MIN, Math.min(PATIENCE.MAX, Math.round(Number(patience))));
  c.patience = next;

  if (next >= PATIENCE.COFFEE) c.coffeeInvited = true;

  if (next <= PATIENCE.WIPE) {
    saveStore(store);
    return wipeConversation(c.id);
  }

  const nextFeats = featuresForPatience(next);
  const notices = [];

  if (prev !== next) {
    notices.push(pushSystemMessage(c.id, `Zainteresiranost: ${next}`));
  }

  const toggles = [
    ["like", "like"],
    ["smile", "smile"],
    ["voice", "glasovne poruke"],
    ["photo", "slike"],
    ["call", "poziv"],
    ["video", "videopoziv"],
    ["heart", "srce"],
    ["coffee", "kava"],
  ];
  for (const [key, label] of toggles) {
    if (!prevFeats[key] && nextFeats[key]) {
      notices.push(pushSystemMessage(c.id, `Otključano: ${label}`));
    } else if (prevFeats[key] && !nextFeats[key]) {
      notices.push(pushSystemMessage(c.id, `Onemogućeno: ${label}`));
    }
  }
  if (prevFeats.limited && !nextFeats.limited) {
    notices.push(pushSystemMessage(c.id, "Otključano: slobodan tekst"));
  } else if (!prevFeats.limited && nextFeats.limited) {
    notices.push(pushSystemMessage(c.id, "Onemogućeno: slobodan tekst"));
  }

  saveStore(store);
  return {
    ok: true,
    conversation: publicConversation(c),
    notices: notices.map(mapMessage),
  };
}

function pushSystemMessage(conversationId, text) {
  const message = {
    id: nextId(),
    conversation_id: Number(conversationId),
    from: "system",
    type: "system",
    text: String(text),
    media_path: null,
    created_at: new Date().toISOString(),
  };
  store.messages.push(message);
  return message;
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
    reaction: m.reaction || null,
    reactions: Array.isArray(m.reactions) ? m.reactions : [],
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

  if (from === "guest") {
    const blocked = guestContentBlocked(trimmed, feats);
    if (blocked) return { ok: false, error: blocked };
  }

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

export function createReactionMessage(conversationId, from, kind) {
  const c = getConversation(conversationId);
  if (!c || c.status !== "active") return { ok: false, error: "Razgovor nije aktivan." };

  const spec = REACTION_KIND[kind];
  if (!spec) return { ok: false, error: "Nepoznata reakcija." };

  const feats = featuresForPatience(c.patience);
  // Ema uvijek smije; gost samo ako je otključano
  if (from === "guest" && !feats[spec.feature]) {
    return {
      ok: false,
      error: `Nemaš otključan ${spec.label} — Ema mora podići strpljenje.`,
    };
  }

  const message = {
    id: nextId(),
    conversation_id: c.id,
    from,
    type: "reaction",
    text: spec.text,
    reaction: kind,
    reactions: [],
    media_path: null,
    created_at: new Date().toISOString(),
  };
  store.messages.push(message);
  saveStore(store);

  return {
    ok: true,
    message: { ...mapMessage(message), reaction: kind },
    conversation: publicConversation(c),
  };
}

const REACTABLE = new Set(["text", "voice", "call", "video"]);

/**
 * Reakcija NA poruku (like / smile / heart).
 * Ema uvijek; gost po unlocku. Srce od gosta samo na Emine poruke.
 */
export function reactToMessage(conversationId, from, messageId, kind) {
  const c = getConversation(conversationId);
  if (!c || c.status !== "active") return { ok: false, error: "Razgovor nije aktivan." };

  const spec = REACTION_KIND[kind];
  if (!spec) return { ok: false, error: "Nepoznata reakcija." };

  const feats = featuresForPatience(c.patience);
  if (from === "guest" && !feats[spec.feature]) {
    return {
      ok: false,
      error: `Nemaš otključan ${spec.label} — Ema mora podići strpljenje.`,
    };
  }

  const message = store.messages.find(
    (m) => m.id === Number(messageId) && m.conversation_id === c.id
  );
  if (!message) return { ok: false, error: "Poruka nije pronađena." };
  if (!REACTABLE.has(message.type)) {
    return { ok: false, error: "Na ovu poruku se ne može reagirati." };
  }

  if (from === "guest" && kind === "heart" && message.from !== "ema") {
    return { ok: false, error: "Srce šalješ Emi — samo na njezine poruke." };
  }

  if (!Array.isArray(message.reactions)) message.reactions = [];

  const existing = message.reactions.findIndex(
    (r) => r.from === from && r.kind === kind
  );
  if (existing >= 0) {
    message.reactions.splice(existing, 1);
  } else {
    // jedna reakcija istog tipa po osobi; zamijeni drugi kind iste osobe? ne — dozvoli više tipova
    message.reactions.push({
      from,
      kind,
      text: spec.text,
      at: new Date().toISOString(),
    });
  }

  saveStore(store);
  return { ok: true, message: mapMessage(message) };
}

/** Poziv / videopoziv — samo ako je otključano (Ema i gost). */
export function createCallMessage(conversationId, from, kind) {
  const c = getConversation(conversationId);
  if (!c || c.status !== "active") return { ok: false, error: "Razgovor nije aktivan." };

  const spec = CALL_KIND[kind];
  if (!spec) return { ok: false, error: "Nepoznat tip poziva." };

  const feats = featuresForPatience(c.patience);
  if (!feats[spec.feature]) {
    return {
      ok: false,
      error: `${spec.label[0].toUpperCase()}${spec.label.slice(1)} još nije otključan.`,
    };
  }

  if (from !== "ema" && from !== "guest") {
    return { ok: false, error: "Nepoznata uloga." };
  }

  const message = {
    id: nextId(),
    conversation_id: c.id,
    from,
    type: spec.type,
    text: spec.text,
    reaction: kind,
    media_path: null,
    created_at: new Date().toISOString(),
  };
  store.messages.push(message);
  saveStore(store);

  return {
    ok: true,
    message: { ...mapMessage(message), reaction: kind },
    conversation: publicConversation(c),
  };
}

export function createVoiceMessage(conversationId, from, base64Audio, mime = "audio/webm") {
  const c = getConversation(conversationId);
  if (!c || c.status !== "active") return { ok: false, error: "Razgovor nije aktivan." };
  if (from === "guest" && !featuresForPatience(c.patience).voice) {
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
