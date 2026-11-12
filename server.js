import express from "express";
import { WebSocketServer } from "ws";

const app = express();
const OK = /(^|\.)mangadex\.(org|network)$/;

if (!process.env.DISCORD_CLIENT_SECRET) console.warn("DISCORD_CLIENT_SECRET missing: avatars won't show");

// ---------- Serve the built page ----------
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
    res.set("Cache-Control", "public, max-age=3600"); // browser reuses pages instead of re-downloading
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.sendStatus(502);
  }
});

// ---------- Discord login: swap the one-time code for an access token ----------
app.post("/token", express.json(), async (req, res) => {
  const code = String(req.body?.code || "");
  if (!code) return res.sendStatus(400);
  try {
    const r = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.VITE_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
      }),
    });
    const { access_token } = await r.json();
    if (!access_token) return res.sendStatus(401);
    res.json({ access_token });
  } catch {
    res.sendStatus(502);
  }
});

// ---------- Discord avatar proxy ----------
app.get("/avatar/:id/:hash", async (req, res) => {
  const { id, hash } = req.params;
  if (!/^\d{5,20}$/.test(id) || !/^(a_)?[0-9a-f]{32}$/.test(hash)) return res.sendStatus(400);
  try {
    const r = await fetch(`https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=64`);
    if (!r.ok) return res.sendStatus(r.status);
    res.set("Cache-Control", "public, max-age=86400").type("image/png");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.sendStatus(502);
  }
});

// ---------- Start HTTP server (only reachable from this machine) ----------
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
      by: String(m.by || "").slice(0, 32), // Discord user id of whoever moved last
    };
    for (const c of room.clients)
      if (c !== ws && c.readyState === 1) c.send(JSON.stringify(room.state));
  });

  ws.on("close", () => {
    room.clients.delete(ws);
    if (!room.clients.size) rooms.delete(id);
  });
});