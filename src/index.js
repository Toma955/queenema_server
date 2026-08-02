import cors from "cors";
import express from "express";
import http from "http";
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
  loginAdmin,
  loginEma,
  PATIENCE,
  resolveMediaFile,
  respondToRequest,
  setAcceptNewConversations,
  setPatience,
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
  io.to(`conv:${conversationId}`).emit(event, payload);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, name: "queenema", ema: getEmaProfile().name, patience: PATIENCE });
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
      conversation: {
        id: conversation.id,
        guestName: conversation.guestName,
        status: conversation.status,
        patience: conversation.patience,
        features: featuresForPatience(conversation.patience),
        limits: {
          maxMessages: featuresForPatience(conversation.patience).maxMessages,
          maxChars: featuresForPatience(conversation.patience).maxChars,
        },
        coffeeInvited: Boolean(conversation.coffeeInvited),
        created_at: conversation.created_at,
      },
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
      socket.data.conversationId = payload.conversation.id;
      socket.join(`conv:${payload.conversation.id}`);
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
      socket.data.conversationId = payload.conversation.id;
      socket.join(`conv:${payload.conversation.id}`);
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

  socket.on("join_conversation", ({ conversationId, role, guestToken }) => {
    const c = getConversation(conversationId);
    if (!c || c.status !== "active") {
      socket.emit("error_message", { error: "Razgovor nije pronađen." });
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
    socket.data.conversationId = c.id;
    socket.join(`conv:${c.id}`);

    const pub = {
      id: c.id,
      guestName: c.guestName,
      guestBio: c.guestBio,
      guestAvatar: c.guestAvatar,
      meta: c.meta,
      status: c.status,
      patience: c.patience,
      features: featuresForPatience(c.patience),
      limits: {
        maxMessages: featuresForPatience(c.patience).maxMessages,
        maxChars: featuresForPatience(c.patience).maxChars,
      },
      coffeeInvited: Boolean(c.coffeeInvited),
      created_at: c.created_at,
    };
    socket.emit("conversation_state", {
      conversation: pub,
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
    socket.join(`conv:${c.id}`);
    socket.data.conversationId = c.id;
    socket.emit("conversation_state", {
      conversation: publicish(c),
      messages: getMessages(c.id),
    });
  });

  function publicish(c) {
    return {
      id: c.id,
      guestName: c.guestName,
      guestBio: c.guestBio,
      guestAvatar: c.guestAvatar,
      meta: c.meta,
      status: c.status,
      patience: c.patience,
      features: featuresForPatience(c.patience),
      limits: {
        maxMessages: featuresForPatience(c.patience).maxMessages,
        maxChars: featuresForPatience(c.patience).maxChars,
      },
      coffeeInvited: Boolean(c.coffeeInvited),
      created_at: c.created_at,
      ended_at: c.ended_at,
      end_reason: c.end_reason,
    };
  }

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
