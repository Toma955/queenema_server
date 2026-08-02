import cors from "cors";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import {
  clearMessages,
  createTextMessage,
  createVoiceMessage,
  getMessages,
  getMode,
  getUserById,
  joinAsRole,
  listUsers,
  resolveVoiceFile,
  ROLES,
  setMode,
} from "./db.js";

const PORT = Number(process.env.PORT) || 3001;

const defaultOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "https://queenema.art",
  "https://www.queenema.art",
  "https://admin.queenema.art",
];

const allowedOrigins = [
  ...defaultOrigins,
  ...(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  // Vercel preview / production aliases
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return true;
  return false;
}

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: isAllowedOrigin, methods: ["GET", "POST"] },
  maxHttpBufferSize: 4e6,
  pingInterval: 25000,
  pingTimeout: 20000,
});

app.set("trust proxy", 1);
app.use(cors({ origin: isAllowedOrigin }));
app.use(express.json({ limit: "4mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    name: "queenema",
    pair: { admin: ROLES.toma.name, mobile: ROLES.ema.name },
    mode: getMode(),
    maxPeople: 2,
  });
});

app.get("/api/chat", (_req, res) => {
  res.json({
    mode: getMode(),
    pair: { admin: ROLES.toma, mobile: ROLES.ema },
    users: listUsers().map((u) => ({ id: u.id, name: u.name, role: u.role })),
    messages: getMessages(),
  });
});

app.post("/api/join", (req, res) => {
  const role = String(req.body?.role ?? "").toLowerCase();
  const result = joinAsRole(role);
  if (!result.ok) return res.status(403).json({ error: result.error });
  res.json({
    user: result.user,
    mode: getMode(),
    users: listUsers().map((u) => ({ id: u.id, name: u.name, role: u.role })),
    messages: getMessages(),
  });
});

app.get("/api/voice/:file", (req, res) => {
  const file = resolveVoiceFile(req.params.file);
  if (!file) return res.status(404).end();
  res.sendFile(file);
});

const onlineByUserId = new Map();

function presencePayload() {
  const onlineIds = [...onlineByUserId.keys()];
  return {
    mode: getMode(),
    onlineUserIds: onlineIds,
    users: listUsers().map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      online: onlineIds.includes(u.id),
    })),
  };
}

function broadcastPresence() {
  io.emit("presence", presencePayload());
}

io.on("connection", (socket) => {
  socket.on("join", ({ userId }) => {
    const user = getUserById(userId);
    if (!user || (user.role !== "toma" && user.role !== "ema")) {
      socket.emit("error_message", { error: "Korisnik nije pronađen." });
      return;
    }

    socket.data.userId = user.id;
    socket.data.userName = user.name;
    socket.data.role = user.role;
    socket.join("chat");

    if (!onlineByUserId.has(user.id)) onlineByUserId.set(user.id, new Set());
    onlineByUserId.get(user.id).add(socket.id);

    socket.emit("chat_state", {
      messages: getMessages(),
      mode: getMode(),
      ...presencePayload(),
    });
    broadcastPresence();
  });

  socket.on("set_mode", ({ mode }) => {
    if (socket.data.role !== "toma") {
      socket.emit("error_message", { error: "Samo admin mijenja mode." });
      return;
    }
    const result = setMode(mode);
    if (!result.ok) {
      socket.emit("error_message", { error: result.error });
      return;
    }
    io.emit("mode_changed", { mode: result.mode });
  });

  socket.on("send_message", ({ text }) => {
    const userId = socket.data.userId;
    if (!userId) {
      socket.emit("error_message", { error: "Nisi prijavljen." });
      return;
    }
    const result = createTextMessage(userId, text ?? "");
    if (!result.ok) {
      socket.emit("error_message", { error: result.error });
      return;
    }
    io.to("chat").emit("new_message", result.message);
  });

  socket.on("send_voice", ({ audio, mime }) => {
    const userId = socket.data.userId;
    if (!userId) {
      socket.emit("error_message", { error: "Nisi prijavljen." });
      return;
    }
    const result = createVoiceMessage(userId, audio, mime);
    if (!result.ok) {
      socket.emit("error_message", { error: result.error });
      return;
    }
    io.to("chat").emit("new_message", result.message);
  });

  socket.on("clear_messages", () => {
    if (socket.data.role !== "toma") {
      socket.emit("error_message", { error: "Samo admin može obrisati chat." });
      return;
    }
    clearMessages();
    io.to("chat").emit("chat_cleared");
  });

  socket.on("disconnect", () => {
    const userId = socket.data.userId;
    if (!userId) return;
    const sockets = onlineByUserId.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) onlineByUserId.delete(userId);
    }
    broadcastPresence();
  });
});

server.listen(PORT, () => {
  console.log(`queenema API na portu ${PORT}`);
});
