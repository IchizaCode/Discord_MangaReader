import express from "express";
import { WebSocketServer } from "ws";

const app = express();
const OK = /(^|\.)mangadex\.(org|network)$/;

// ---------- Serve the built page (NEW) ----------
app.use(express.static("dist"));

// ---------- MangaDex API proxy ----------
app.use("/api", async (req, res) => {
  try {
    const r = await fetch("https://api.mangadex.org" + req.url);
    res.status(r.status).type("json").send(await r.text());
  } catch {
    res.sendStatus(502);
  }
});

// ---------- MangaDex image proxy ----------
app.get("/img", async (req, res) => {
  try {
    const u = new URL(req.query.url);
    if (u.protocol !== "https:" || !OK.test(u.hostname)) return res.sendStatus(400);
    const r = await fetch(u);
    res.status(r.status).type(r.headers.get("content-type") || "image/jpeg");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.sendStatus(502);
  }
});

// ---------- Start HTTP server (NEW: only reachable from this machine) ----------
const server = app.listen(3001, "127.0.0.1", () =>
  console.log("Server running on http://127.0.0.1:3001")
);

// ---------- WebSocket sync (reading together) ----------
const wss = new WebSocketServer({ server, path: "/ws" });
const rooms = new Map(); // instanceId -> { state, clients }

wss.on("connection", (ws, req) => {
  const id = new URL(req.url, "http://x").searchParams.get("room");
  if (!id) return ws.close();
  const room = rooms.get(id) ?? { state: null, clients: new Set() };
  rooms.set(id, room);
  room.clients.add(ws);

  // Late joiners get the current chapter and page right away
  if (room.state) ws.send(JSON.stringify(room.state));

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    room.state = {
      chapterId: String(m.chapterId || "").slice(0, 64),
      title: String(m.title || "").slice(0, 200),
      page: Number(m.page) | 0,
    };
    for (const c of room.clients)
      if (c !== ws && c.readyState === 1) c.send(JSON.stringify(room.state));
  });

  ws.on("close", () => {
    room.clients.delete(ws);
    if (!room.clients.size) rooms.delete(id);
  });
});