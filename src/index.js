import cors from "cors";
import express from "express";
import http from "http";
import crypto from "crypto";
import { Server } from "socket.io";
import {
  adminUpdateEmaProfile,
  createRequest,
  createInvite,
  createTextMessage,
  createReactionMessage,
  createCallMessage,
  createVoiceMessage,
  createPhotoMessage,
  respondToInvite,
  reactToMessage,
  endConversation,
  featuresForPatience,
  getConversation,
  getConversationByGuestToken,
  getEmaProfile,
  getInvite,
  getLeaderboard,
  getMessages,
  getPublicAvailability,
  getRequestByToken,
  getStateForAdmin,
  getStateForEma,
  publicConversation,
  loginAdmin,
  loginEma,
  PATIENCE,
  resolveMediaFile,
  respondToRequest,
  setAcceptNewConversations,
  setPatience,
  setGuestNickname,
  setEmaAvatar,
  updateAdminProfile,
  updateEmaProfile,
  wipeConversation,
} from "./db.js";

const PORT = Number(process.env.PORT) || 3001;

const defaultOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "https://queenema.art",
  "https://www.queenema.art",
  "https://guest.queenema.art",
  "https://queenema-ema.vercel.app",
  "https://queenema-admin.vercel.app",
];

const allowedOrigins = [
  ...defaultOrigins,
  ...(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];

function isAllowedOrigin(origin, callback) {
  if (!origin) return callback(null, true);
  if (allowedOrigins.includes(origin)) return callback(null, true);
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return callback(null, true);
  return callback(null, false);
}

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins.concat([/^https:\/\/[a-z0-9-]+\.vercel\.app$/i]),
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 6e6,
});

app.set("trust proxy", 1);
app.use(cors({ origin: isAllowedOrigin }));
app.use(express.json({ limit: "6mb" }));

const emaSockets = new Set();
const adminSockets = new Set();
/** conversationId(number) -> Map(socketId -> role) */
const convPeers = new Map();

function convIdOf(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function trackConvPeer(socket, conversationId) {
  const id = convIdOf(conversationId);
  if (id == null) return null;
  socket.join(`conv:${id}`);
  socket.data.conversationId = id;
  if (!convPeers.has(id)) convPeers.set(id, new Map());
  convPeers.get(id).set(socket.id, socket.data.role || "unknown");
  return id;
}

function untrackSocket(socket) {
  for (const [id, peers] of convPeers) {
    if (!peers.has(socket.id)) continue;
    peers.delete(socket.id);
    if (peers.size === 0) convPeers.delete(id);
  }
}

function emitToConvPeers(conversationId, event, payload, exceptId) {
  const id = convIdOf(conversationId);
  if (id == null) return 0;
  const peers = convPeers.get(id);
  let sent = 0;
  if (peers && peers.size) {
    for (const sid of peers.keys()) {
      if (sid === exceptId) continue;
      io.to(sid).emit(event, payload);
      sent += 1;
    }
  }
  // fallback na Socket.IO room ako mapa prazna
  if (sent === 0) {
    if (exceptId) io.to(`conv:${id}`).except(exceptId).emit(event, payload);
    else io.to(`conv:${id}`).emit(event, payload);
  }
  return sent;
}

function broadcastEma(event, payload) {
  for (const id of emaSockets) io.to(id).emit(event, payload);
}

function broadcastAdmin(event, payload) {
  for (const id of adminSockets) io.to(id).emit(event, payload);
}

function broadcastStaff(event, payload) {
  broadcastEma(event, payload);
  broadcastAdmin(event, payload);
}

function isStaff(socket) {
  return socket.data.role === "ema" || socket.data.role === "admin";
}

function emitConversation(conversationId, event, payload) {
  const id = convIdOf(conversationId) ?? conversationId;
  io.to(`conv:${id}`).emit(event, payload);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, name: "queenema", ema: getEmaProfile().name, patience: PATIENCE });
});

/** ICE/TURN config za WebRTC pozive */
app.get("/api/ice", async (_req, res) => {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.relay.metered.ca:80" },
    { urls: "stun:freeturn.net:3478" },
    { urls: "stun:freeturn.net:5349" },
  ];

  // Metered / Open Relay REST (preporučeno — free account API key)
  const meteredKey = process.env.METERED_API_KEY || process.env.TURN_API_KEY;
  const meteredDomain =
    process.env.METERED_DOMAIN || process.env.TURN_METERED_DOMAIN;
  if (meteredKey && meteredDomain) {
    try {
      const url = `https://${meteredDomain}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(meteredKey)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const list = await r.json();
        if (Array.isArray(list) && list.length) {
          res.setHeader("Cache-Control", "no-store");
          return res.json({ iceServers: [...iceServers, ...list], source: "metered" });
        }
      }
    } catch {
      /* fallback below */
    }
  }

  let source = "fallback";
  let ttl = 12 * 3600;

  // elixir-webrtc public Rel (radi — short-lived REST credentials)
  try {
    const r = await fetch(
      "https://turn.elixir-webrtc.org/?service=turn&username=queenema",
      { method: "POST", signal: AbortSignal.timeout(4000) }
    );
    if (r.ok) {
      const cred = await r.json();
      if (cred?.username && cred?.password && Array.isArray(cred.uris) && cred.uris.length) {
        iceServers.push({
          urls: cred.uris,
          username: cred.username,
          credential: cred.password,
        });
        ttl = Number(cred.ttl) || ttl;
        source = "elixir-rel";
      }
    }
  } catch {
    /* continue */
  }

  // Open Relay static-auth (često mrtav bez Metered API key — ostaje kao backup)
  const secret = process.env.TURN_STATIC_SECRET || "openrelayprojectsecret";
  const unix = Math.floor(Date.now() / 1000) + ttl;
  const username = `${unix}:queenema`;
  const credential = crypto
    .createHmac("sha1", secret)
    .update(username)
    .digest("base64");

  iceServers.push({
    urls: [
      "turn:staticauth.openrelay.metered.ca:80",
      "turn:staticauth.openrelay.metered.ca:80?transport=tcp",
      "turn:staticauth.openrelay.metered.ca:443",
      "turns:staticauth.openrelay.metered.ca:443?transport=tcp",
    ],
    username,
    credential,
  });

  // freeturn.net (javni free:free) — TCP/TLS backup
  iceServers.push({
    urls: [
      "turn:freeturn.net:3478",
      "turn:freeturn.net:3478?transport=tcp",
      "turns:freeturn.net:5349",
    ],
    username: "free",
    credential: "free",
  });

  const turnUrls = String(process.env.TURN_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (turnUrls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
    source = "env-turn";
  }

  res.setHeader("Cache-Control", "no-store");
  res.json({ iceServers, ttl, source });
});

app.get("/api/availability", (_req, res) => {
  res.json({
    ...getPublicAvailability(),
    emaOnline: emaSockets.size > 0,
  });
});

app.post("/api/login", (req, res) => {
  const result = loginEma(req.body?.username, req.body?.password);
  if (!result.ok) return res.status(401).json({ error: result.error });
  res.json({ user: result.user, ...getStateForEma() });
});

app.post("/api/admin/login", (req, res) => {
  const result = loginAdmin(req.body?.username, req.body?.password);
  if (!result.ok) return res.status(401).json({ error: result.error });
  res.json({ user: result.user, ...getStateForAdmin() });
});

app.post("/api/ema/profile", (req, res) => {
  const result = updateEmaProfile({
    name: req.body?.name,
    username: req.body?.username,
    password: req.body?.password,
    currentPassword: req.body?.currentPassword,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ user: result.user });
});

app.post("/api/admin/profile", (req, res) => {
  const result = updateAdminProfile({
    name: req.body?.name,
    username: req.body?.username,
    password: req.body?.password,
    currentPassword: req.body?.currentPassword,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ user: result.user });
});

app.post("/api/admin/ema-profile", (req, res) => {
  const result = adminUpdateEmaProfile({
    name: req.body?.name,
    username: req.body?.username,
    password: req.body?.password,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  broadcastStaff("ema_profile", result.ema);
  res.json(result);
});

app.post("/api/invite", (_req, res) => {
  const result = createInvite();
  res.json(result);
});

app.get("/api/invite/:token", (req, res) => {
  const result = getInvite(req.params.token);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

app.post("/api/request", (req, res) => {
  const result = createRequest({
    name: req.body?.name,
    firstName: req.body?.firstName,
    lastName: req.body?.lastName,
    bio: req.body?.bio,
    avatar: req.body?.avatar,
    avatarMime: req.body?.avatarMime,
    guestToken: req.body?.guestToken,
    inviteToken: req.body?.inviteToken,
    meta: {
      device: req.body?.device,
      userAgent: req.body?.userAgent || req.headers["user-agent"],
      cookiesAccepted: req.body?.cookiesAccepted,
      ip: clientIp(req),
    },
  });
  if (!result.ok) {
    const status = result.code === "already_active" || result.code === "already_pending" ? 409 : 403;
    return res.status(status).json(result);
  }
  broadcastEma("new_request", result.request);
  broadcastAdmin("admin_state", getStateForAdmin());
  res.json(result);
});

app.get("/api/ema/state", (_req, res) => {
  res.json(getStateForEma());
});

app.get("/api/ema/leaderboard", (_req, res) => {
  res.json(getLeaderboard());
});

function guestPayload(token) {
  const conversation = getConversationByGuestToken(token);
  if (conversation?.status === "active") {
    return {
      status: "active",
      conversation: publicConversation(conversation),
      messages: getMessages(conversation.id),
    };
  }
  const request = getRequestByToken(token);
  if (request?.status === "pending") {
    return { status: "pending", guestName: request.guestName };
  }
  if (request?.status === "rejected") {
    return { status: "rejected" };
  }
  if (conversation?.status === "ended") {
    return { status: "ended" };
  }
  return { status: "gone" };
}

app.get("/api/guest/:token", (req, res) => {
  res.json(guestPayload(req.params.token));
});

app.get("/api/media/:file", (req, res) => {
  const file = resolveMediaFile(req.params.file);
  if (!file) return res.status(404).end();
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.sendFile(file);
});

io.on("connection", (socket) => {
  const authToken = socket.handshake.auth?.guestToken;
  if (authToken) {
    socket.data.role = "guest";
    socket.data.guestToken = authToken;
    const payload = guestPayload(authToken);
    socket.emit("guest_state", payload);
    if (payload.status === "active" && payload.conversation) {
      trackConvPeer(socket, payload.conversation.id);
    }
  }

  socket.on("ema_hello", () => {
    socket.data.role = "ema";
    emaSockets.add(socket.id);
    socket.emit("ema_state", getStateForEma());
    io.emit("availability", {
      ...getPublicAvailability(),
      emaOnline: emaSockets.size > 0,
    });
  });

  socket.on("admin_hello", () => {
    socket.data.role = "admin";
    adminSockets.add(socket.id);
    socket.emit("admin_state", getStateForAdmin());
  });

  socket.on("guest_hello", ({ guestToken }) => {
    if (!guestToken) return;
    socket.data.role = "guest";
    socket.data.guestToken = guestToken;
    const payload = guestPayload(guestToken);
    socket.emit("guest_state", payload);
    if (payload.status === "active" && payload.conversation) {
      trackConvPeer(socket, payload.conversation.id);
    }
  });

  socket.on("set_accept_new", ({ value }) => {
    if (!isStaff(socket)) return;
    const settings = setAcceptNewConversations(value);
    broadcastStaff("settings", settings);
    broadcastAdmin("admin_state", getStateForAdmin());
    io.emit("availability", {
      ...getPublicAvailability(),
      emaOnline: emaSockets.size > 0,
    });
  });

  socket.on("respond_request", ({ requestId, accept }) => {
    if (!isStaff(socket)) return;
    const result = respondToRequest(requestId, accept);
    if (!result.ok) {
      socket.emit("error_message", { error: result.error });
      return;
    }
    broadcastEma("ema_state", getStateForEma());
    broadcastAdmin("admin_state", getStateForAdmin());
    if (result.rejected) {
      io.emit("request_rejected", { guestToken: result.guestToken });
      return;
    }
    broadcastEma("conversation_started", result.conversation);
    io.emit("request_accepted", {
      guestToken: result.guestToken,
      conversation: result.conversation,
    });
    io.emit("conversation_started", result.conversation);
  });

  socket.on("join_conversation", ({ conversationId, role, guestToken } = {}) => {
    const c = getConversation(conversationId);
    if (!c || c.status !== "active") {
      socket.emit("error_message", { error: "Razgovor nije pronađen." });
      return;
    }

    // Re-join sobe bez mijenjanja uloge (npr. prije WebRTC signala)
    if (role == null || role === "") {
      if (socket.data.role === "guest") {
        if (c.guestToken !== socket.data.guestToken) {
          socket.emit("error_message", { error: "Nedozvoljen pristup." });
          return;
        }
      } else if (!isStaff(socket)) {
        socket.emit("error_message", { error: "Nemaš pristup." });
        return;
      }
      trackConvPeer(socket, c.id);
      return;
    }

    if (role === "guest") {
      if (c.guestToken !== guestToken) {
        socket.emit("error_message", { error: "Nedozvoljen pristup." });
        return;
      }
      socket.data.role = "guest";
      socket.data.guestToken = guestToken;
    } else if (role === "admin" || socket.data.role === "admin") {
      socket.data.role = "admin";
      adminSockets.add(socket.id);
    } else {
      socket.data.role = "ema";
      emaSockets.add(socket.id);
    }
    trackConvPeer(socket, c.id);

    socket.emit("conversation_state", {
      conversation: publicConversation(c),
      messages: getMessages(c.id),
    });
  });

  socket.on("admin_peek", ({ conversationId }) => {
    if (socket.data.role !== "admin") return;
    const c = getConversation(conversationId);
    if (!c) {
      socket.emit("error_message", { error: "Razgovor nije pronađen." });
      return;
    }
    trackConvPeer(socket, c.id);
    socket.emit("conversation_state", {
      conversation: publicConversation(c),
      messages: getMessages(c.id),
    });
  });

  function publicish(c) {
    return publicConversation(c);
  }

  socket.on("set_guest_nickname", ({ conversationId, nickname } = {}) => {
    if (!isStaff(socket)) return;
    const result = setGuestNickname(conversationId, nickname);
    if (!result.ok) {
      socket.emit("error_message", { error: result.error });
      return;
    }
    emitConversation(conversationId, "conversation_updated", {
      conversation: result.conversation,
    });
    broadcastEma("ema_state", getStateForEma());
    broadcastAdmin("admin_state", getStateForAdmin());
  });

  socket.on("set_patience", ({ conversationId, patience }) => {
    if (!isStaff(socket)) return;
    const result = setPatience(conversationId, patience);
    if (!result.ok) {
      socket.emit("error_message", { error: result.error });
      return;
    }
    if (result.wiped) {
      const payload = {
        conversationId: result.conversationId,
        guestToken: result.guestToken,
      };
      io.to(`conv:${result.conversationId}`).emit("conversation_wiped", payload);
      broadcastStaff("conversation_wiped", payload);
      broadcastEma("ema_state", getStateForEma());
      broadcastAdmin("admin_state", getStateForAdmin());
      return;
    }
    emitConversation(conversationId, "patience", {
      conversation: result.conversation,
    });
    for (const notice of result.notices || []) {
      emitConversation(conversationId, "new_message", notice);
    }
    broadcastEma("ema_state", getStateForEma());
    broadcastAdmin("admin_state", getStateForAdmin());
  });

  socket.on("end_conversation", ({ conversationId } = {}) => {
    const id = conversationId || socket.data.conversationId;
    if (!id) return;

    if (isStaff(socket)) {
      const result = endConversation(id, "manual");
      if (!result.ok) return;
      emitConversation(id, "conversation_ended", {
        conversation: result.conversation,
      });
      broadcastEma("ema_state", getStateForEma());
      broadcastAdmin("admin_state", getStateForAdmin());
      return;
    }

    if (socket.data.role !== "guest") return;
    const c = getConversation(id);
    if (!c || c.guestToken !== socket.data.guestToken) {
      socket.emit("error_message", { error: "Nemaš pristup." });
      return;
    }
    const result = endConversation(id, "guest_left");
    if (!result.ok) {
      socket.emit("error_message", { error: result.error || "Neuspjeh." });
      return;
    }
    emitConversation(id, "conversation_ended", {
      conversation: result.conversation,
    });
    broadcastEma("ema_state", getStateForEma());
    broadcastAdmin("admin_state", getStateForAdmin());
  });

  socket.on("wipe_conversation", ({ conversationId }) => {
    if (!isStaff(socket)) return;
    const result = wipeConversation(conversationId);
    if (!result.ok) return;
    io.to(`conv:${result.conversationId}`).emit("conversation_wiped", {
      conversationId: result.conversationId,
      guestToken: result.guestToken,
    });
    broadcastEma("ema_state", getStateForEma());
    broadcastAdmin("admin_state", getStateForAdmin());
  });

  socket.on("send_message", ({ conversationId, text } = {}) => {
    if (!isStaff(socket) && socket.data.role !== "guest") {
      socket.emit("error_message", { error: "Nemaš pristup." });
      return;
    }
    const from = socket.data.role === "guest" ? "guest" : "ema";
    const id = conversationId || socket.data.conversationId;
    const result = createTextMessage(id, from, text);
    if (!result.ok) {
      socket.emit("error_message", { error: result.error });
      return;
    }
    emitConversation(id, "new_message", result.message);
    emitConversation(id, "patience", {
      conversation: result.conversation,
    });
  });

  socket.on("react_message", ({ conversationId, messageId, kind } = {}) => {
    if (!isStaff(socket) && socket.data.role !== "guest") {
      socket.emit("error_message", { error: "Nemaš pristup." });
      return;
    }
    const from = socket.data.role === "guest" ? "guest" : "ema";
    const id = conversationId || socket.data.conversationId;
    const result = reactToMessage(id, from, messageId, kind);
    if (!result.ok) {
      socket.emit("error_message", { error: result.error });
      return;
    }
    emitConversation(id, "message_updated", result.message);
  });

  socket.on("send_call", ({ conversationId, kind } = {}) => {
    if (!isStaff(socket) && socket.data.role !== "guest") {
      socket.emit("error_message", { error: "Nemaš pristup." });
      return;
    }
    const from = socket.data.role === "guest" ? "guest" : "ema";
    const id = conversationId || socket.data.conversationId;
    const result = createCallMessage(id, from, kind);
    if (!result.ok) {
      socket.emit("error_message", { error: result.error });
      return;
    }
    emitConversation(id, "new_message", result.message);
  });

  socket.on("typing", ({ conversationId, typing } = {}) => {
    if (!isStaff(socket) && socket.data.role !== "guest") return;
    const id = conversationId || socket.data.conversationId;
    if (!id) return;
    const from = socket.data.role === "guest" ? "guest" : "ema";
    const payload = {
      conversationId: Number(id) || id,
      from,
      typing: Boolean(typing),
    };
    // soba + broadcast staffovima (ako nisu u sobi)
    socket.to(`conv:${id}`).emit("peer_typing", payload);
    if (from === "guest") {
      for (const sid of emaSockets) {
        if (sid !== socket.id) io.to(sid).emit("peer_typing", payload);
      }
      for (const sid of adminSockets) {
        if (sid !== socket.id) io.to(sid).emit("peer_typing", payload);
      }
    }
  });

  socket.on("respond_invite", ({ conversationId, messageId, answer } = {}) => {
    if (!isStaff(socket) && socket.data.role !== "guest") {
      socket.emit("error_message", { error: "Nemaš pristup." });
      return;
    }
    const from = socket.data.role === "guest" ? "guest" : "ema";
    const id = conversationId || socket.data.conversationId;
    const result = respondToInvite(id, from, messageId, answer);
    if (!result.ok) {
      socket.emit("error_message", { error: result.error });
      return;
    }
    emitConversation(id, "message_updated", result.message);
    if (
      result.message &&
      (result.message.type === "call" || result.message.type === "video") &&
      result.message.status === "accepted"
    ) {
      emitConversation(id, "call_session", {
        conversationId: id,
        messageId: result.message.id,
        kind: result.message.type,
        caller: result.message.from,
        callee: from,
      });
    }
  });

  socket.on("webrtc_signal", ({ conversationId, ...payload } = {}) => {
    if (!isStaff(socket) && socket.data.role !== "guest") return;
    const id = convIdOf(conversationId || socket.data.conversationId);
    if (id == null) return;
    // osiguraj da je pošiljatelj u mapi peerova
    trackConvPeer(socket, id);
    const from = socket.data.role === "guest" ? "guest" : "ema";
    const msg = {
      conversationId: id,
      from,
      ...payload,
    };
    const sent = emitToConvPeers(id, "webrtc_signal", msg, socket.id);
    // ako mapa nije imala peerove, room fallback je već u emitToConvPeers
    if (sent === 0) {
      socket.to(`conv:${id}`).emit("webrtc_signal", msg);
    }
  });

  socket.on("set_ema_avatar", ({ image, mime, clear } = {}) => {
    if (!isStaff(socket)) {
      socket.emit("error_message", { error: "Nemaš pristup." });
      return;
    }
    const result = clear ? setEmaAvatar(null) : setEmaAvatar(image, mime);
    if (!result.ok) {
      socket.emit("error_message", { error: result.error });
      return;
    }
    broadcastEma("ema_avatar", { avatar: result.avatar });
    broadcastAdmin("ema_avatar", { avatar: result.avatar });
    // osvježi aktivne chateve s novim emaAvatar
    for (const c of getStateForEma().conversations || []) {
      emitConversation(c.id, "patience", { conversation: c });
    }
  });

  socket.on("send_photo", ({ conversationId, image, mime } = {}) => {
    if (!isStaff(socket) && socket.data.role !== "guest") {
      socket.emit("error_message", { error: "Nemaš pristup." });
      return;
    }
    const from = socket.data.role === "guest" ? "guest" : "ema";
    const id = conversationId || socket.data.conversationId;
    const result = createPhotoMessage(id, from, image, mime);
    if (!result.ok) {
      socket.emit("error_message", { error: result.error });
      return;
    }
    emitConversation(id, "new_message", result.message);
  });

  socket.on("send_voice", ({ conversationId, audio, mime, durationSec } = {}) => {
    if (!isStaff(socket) && socket.data.role !== "guest") {
      socket.emit("error_message", { error: "Nemaš pristup." });
      return;
    }
    const from = socket.data.role === "guest" ? "guest" : "ema";
    const id = conversationId || socket.data.conversationId;
    const result = createVoiceMessage(id, from, audio, mime, durationSec);
    if (!result.ok) {
      socket.emit("error_message", { error: result.error });
      return;
    }
    emitConversation(id, "new_message", result.message);
  });

  socket.on("send_reaction", ({ conversationId, kind } = {}) => {
    if (!isStaff(socket) && socket.data.role !== "guest") {
      socket.emit("error_message", { error: "Nemaš pristup." });
      return;
    }
    const from = socket.data.role === "guest" ? "guest" : "ema";
    const id = conversationId || socket.data.conversationId;
    const result = createReactionMessage(id, from, kind);
    if (!result.ok) {
      socket.emit("error_message", { error: result.error });
      return;
    }
    emitConversation(id, "new_message", result.message);
    if (result.conversation) {
      emitConversation(id, "patience", { conversation: result.conversation });
    }
  });

  socket.on("disconnect", () => {
    emaSockets.delete(socket.id);
    adminSockets.delete(socket.id);
    untrackSocket(socket);
    io.emit("availability", {
      ...getPublicAvailability(),
      emaOnline: emaSockets.size > 0,
    });
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: "Stranica nedostupna",
    code: 404,
    path: req.path,
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`queenema API na portu ${PORT}`);
});
