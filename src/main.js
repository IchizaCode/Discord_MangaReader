import "./style.css";
import { DiscordSDK } from "@discord/embedded-app-sdk";

const CLIENT_ID = import.meta.env.VITE_CLIENT_ID;
const app = document.querySelector("#app");

const md = (p) => fetch("/api" + p).then((r) => {
  if (!r.ok) throw new Error("MangaDex error " + r.status);
  return r.json();
});
const img = (u) => "/img?url=" + encodeURIComponent(u);

// Small helper to build elements safely (no innerHTML)
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  Object.assign(el, props);
  el.append(...kids.filter((k) => k != null && k !== false));
  return el;
}

const show = (...kids) => {
  app.replaceChildren(...kids.filter(Boolean));
  window.scrollTo(0, 0);
};

const titleOf = (m) =>
  m.attributes.title.en || Object.values(m.attributes.title)[0] || "Untitled";
const coverOf = (m) => {
  const file = m.relationships?.find((r) => r.type === "cover_art")?.attributes?.fileName;
  return file ? img(`https://uploads.mangadex.org/covers/${m.id}/${file}.256.jpg`) : "";
};
const groupOf = (c) =>
  c?.relationships?.find((r) => r.type === "scanlation_group")?.attributes?.name || "";
const chapterLabel = (c) => {
  const a = c.attributes;
  return `Ch. ${a.chapter ?? "?"}${a.title ? " – " + a.title : ""}`;
};

// ---------- Saved in this browser ----------
const store = {
  get(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const settings = { hd: false, mode: "strip", ...store.get("settings", {}) };
const saveSettings = () => store.set("settings", settings);
const readHistory = () => store.get("history", {});

// ---------- State ----------
let ws = null;
let applying = false;    // true while applying someone else's update
let suppressUntil = 0;   // ignore our own page changes briefly after a remote jump
let following = true;
let lastRemote = null;
let lastSent = "";
let mangaForList = null; // series whose chapter list is loaded
let chapterList = [];
let currentManga = null; // series of the open chapter
let currentChapterId = null;
let currentTitle = "";
let currentPage = 0;
let atHome = null;       // MangaDex image server info for the open chapter
let pageUrls = [];
let pageEls = [];
let pageImg = null;
let pagesEl = null;
let progressText = null;
let progressFill = null;
let observer = null;
let pageTimer = null;
let homeCache = null;

let me = null;           // your Discord user, once logged in
let participants = [];
let leaderId = "";

// ---------- Layout that stays on every screen ----------
const backdrop = h("div", { className: "backdrop" });
const presenceEl = h("div", { className: "presence" });
const topbar = h("header", { className: "topbar" },
  h("button", { className: "brand", onclick: () => showHome() },
    h("span", { className: "logo" }, "📖"), "Manga Reader"),
  presenceEl);
document.body.prepend(topbar, backdrop, h("div", { className: "shade" }));

function setBackdrop(url) {
  if (url) backdrop.style.backgroundImage = `url("${url}")`;
  backdrop.classList.toggle("on", !!url);
}

function toast(msg) {
  const t = h("div", { className: "toast" }, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add("hide"), 2600);
  setTimeout(() => t.remove(), 3100);
}

// ---------- Who's here ----------
const nameOf = (p) => p?.nickname || p?.global_name || p?.username || "Someone";

function avatar(p) {
  const name = nameOf(p);
  const leading = p.id === leaderId;
  const cls = "av" + (leading ? " leading" : "");
  const title = name + (leading ? " (leading)" : "");
  return p.avatar
    ? h("img", { className: cls, src: `/avatar/${p.id}/${p.avatar}`, alt: name, title })
    : h("span", { className: cls + " av-letter", title }, name[0].toUpperCase());
}

function renderPresence() {
  if (!participants.length) return presenceEl.replaceChildren();
  presenceEl.replaceChildren(
    h("div", { className: "stack" }, ...participants.slice(0, 6).map(avatar)),
    h("span", { className: "count" }, `${participants.length} reading`));
}

function setLeader(id) {
  if (id === leaderId) return;
  leaderId = id;
  renderPresence();
}

// ---------- Shared pieces ----------
function bar(fraction) {
  const i = h("i");
  i.style.width = `${Math.round(fraction * 100)}%`;
  return i;
}

function card({ cover, name, sub, progress, onclick }) {
  return h("button", { className: "card", onclick },
    h("img", { className: "cover", src: cover, alt: "", loading: "lazy" }),
    h("span", { className: "name" }, name),
    sub ? h("span", { className: "sub" }, sub) : null,
    progress != null ? h("span", { className: "mini" }, bar(progress)) : null);
}

const mangaCard = (m) => card({ cover: coverOf(m), name: titleOf(m), onclick: () => showChapters(m) });
const skeletons = (n) => Array.from({ length: n }, () => h("div", { className: "skeleton" }));
const section = (title, body) => h("section", { className: "section" }, h("h2", {}, title), body);

function searchForm(value = "") {
  const input = h("input", { type: "search", placeholder: "Search manga…", value });
  return h("form", {
    className: "search",
    onsubmit: (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (q) showSearch(q);
    },
  }, input, h("button", { className: "primary" }, "Search"));
}

async function listManga(extra) {
  const p = new URLSearchParams({ limit: 18, hasAvailableChapters: "true", ...extra });
  p.append("includes[]", "cover_art");
  p.append("availableTranslatedLanguage[]", "en");
  p.append("contentRating[]", "safe");
  p.append("contentRating[]", "suggestive");
  return (await md("/manga?" + p)).data;
}

function leaveReader() {
  if (currentChapterId) saveProgress();
  observer?.disconnect();
  clearTimeout(pageTimer);
  currentChapterId = null;
  progressText = progressFill = null;
}

// ---------- Screen: home ----------
function showHome() {
  leaveReader();
  setBackdrop("");
  const recent = Object.values(readHistory()).sort((a, b) => b.t - a.t);
  const popular = h("div", { className: "row" }, ...skeletons(8));
  const latest = h("div", { className: "row" }, ...skeletons(8));

  show(
    h("div", { className: "hero" },
      h("h1", {}, "What are we reading?"),
      h("p", { className: "muted" }, "Pick something and everyone in the call reads along.")),
    searchForm(),
    recent.length ? section("Continue reading", h("div", { className: "row" }, ...recent.map((e) => card({
      cover: e.cover,
      name: e.title,
      sub: `${e.label.split(" – ")[0]} · p. ${e.page + 1}/${e.total || "?"}`,
      progress: e.total ? (e.page + 1) / e.total : 0,
      onclick: () => resume(e),
    })))) : null,
    section("Popular", popular),
    section("Latest updates", latest));

  // Fetched once per session, so going back home doesn't hit MangaDex again
  homeCache ??= Promise.all([
    listManga({ "order[followedCount]": "desc" }),
    listManga({ "order[latestUploadedChapter]": "desc" }),
  ]);
  homeCache.then(([pop, lat]) => {
    popular.replaceChildren(...pop.map(mangaCard));
    latest.replaceChildren(...lat.map(mangaCard));
  }).catch((err) => {
    homeCache = null;
    popular.replaceChildren(h("p", { className: "error" }, err.message));
    latest.replaceChildren();
  });
}

// ---------- Screen: search results ----------
async function showSearch(q) {
  leaveReader();
  setBackdrop("");
  const grid = h("div", { className: "grid" }, ...skeletons(12));
  show(
    h("button", { className: "ghost", onclick: showHome }, "← Home"),
    searchForm(q),
    section(`Results for “${q}”`, grid));
  const data = await listManga({ title: q, limit: 24 });
  grid.replaceChildren(...(data.length ? data.map(mangaCard) : [h("p", { className: "muted" }, "No results.")]));
}

// ---------- Screen: series + chapter list ----------
async function fetchChapters(mangaId) {
  const p = new URLSearchParams({ limit: 500, "order[chapter]": "asc" });
  p.append("translatedLanguage[]", "en");
  p.append("includes[]", "scanlation_group");
  const { data } = await md(`/manga/${mangaId}/feed?${p}`);
  // Skip chapters hosted on external sites (they have 0 pages on MangaDex)
  return data.filter((c) => c.attributes.pages > 0);
}

async function loadSeries(mangaId) {
  const [{ data: m }, chapters] = await Promise.all([
    md(`/manga/${mangaId}?includes[]=cover_art`),
    fetchChapters(mangaId),
  ]);
  mangaForList = m;
  chapterList = chapters;
}

// Someone else picked a chapter we don't have a list for yet
async function loadListFor(chapterId) {
  const { data } = await md(`/chapter/${chapterId}`);
  const mangaId = data.relationships.find((r) => r.type === "manga")?.id;
  if (mangaId) await loadSeries(mangaId);
}

async function showChapters(m) {
  leaveReader();
  setBackdrop(coverOf(m));
  const last = readHistory()[m.id];
  const list = h("div", { className: "chapters" }, h("p", { className: "muted center" }, "Loading chapters…"));
  const startBtn = h("button", { className: "primary", disabled: true }, "Loading…");
  const desc = (m.attributes.description?.en || "").split("\n")[0];

  show(
    h("button", { className: "ghost", onclick: showHome }, "← Home"),
    h("section", { className: "series" },
      h("img", { className: "series-cover", src: coverOf(m), alt: "" }),
      h("div", { className: "series-info" },
        h("h1", {}, titleOf(m)),
        desc ? h("p", { className: "desc" }, desc) : null,
        startBtn)),
    list);

  const chapters = await fetchChapters(m.id);
  mangaForList = m;
  chapterList = chapters;
  if (!chapters.length) {
    startBtn.textContent = "No English chapters";
    return list.replaceChildren();
  }

  const lastIdx = last ? chapters.findIndex((c) => c.id === last.chapterId) : -1;
  startBtn.disabled = false;
  if (lastIdx >= 0) {
    startBtn.textContent = `Continue ${last.label.split(" – ")[0]}`;
    startBtn.onclick = () => resume(last);
  } else {
    startBtn.textContent = "Start reading";
    startBtn.onclick = () => pickChapter(chapters[0]);
  }

  list.replaceChildren(...chapters.map((c, i) => h("button", {
    className: "chapter" + (i < lastIdx ? " read" : i === lastIdx ? " current" : ""),
    onclick: () => pickChapter(c),
  }, h("span", {}, chapterLabel(c)), h("span", { className: "muted" }, groupOf(c)))));
}

// ---------- Continue reading ----------
function saveProgress() {
  if (!currentManga || !currentChapterId || !pageUrls.length) return;
  const all = readHistory();
  all[currentManga.id] = {
    mangaId: currentManga.id,
    title: titleOf(currentManga),
    cover: coverOf(currentManga),
    chapterId: currentChapterId,
    label: currentTitle,
    page: currentPage,
    total: pageUrls.length,
    t: Date.now(),
  };
  const newest = Object.values(all).sort((a, b) => b.t - a.t).slice(0, 20);
  store.set("history", Object.fromEntries(newest.map((x) => [x.mangaId, x])));
}

async function resume(e) {
  await loadSeries(e.mangaId);
  await loadChapter(e.chapterId, e.label);
  goToPage(e.page);
  share({ chapterId: e.chapterId, title: e.label, page: e.page });
}

// ---------- Screen: reader ----------
const chapterIndex = () => chapterList.findIndex((c) => c.id === currentChapterId);

function nextChapter() {
  const i = chapterIndex();
  if (i >= 0 && chapterList[i + 1]) pickChapter(chapterList[i + 1]);
}

function prevChapter() {
  const i = chapterIndex();
  if (i > 0) pickChapter(chapterList[i - 1]);
}

async function pickChapter(c) {
  const title = chapterLabel(c);
  await loadChapter(c.id, title);
  share({ chapterId: c.id, title, page: 0 });
}

async function loadChapter(chapterId, title) {
  if (currentChapterId) saveProgress();
  observer?.disconnect();
  currentChapterId = chapterId;
  currentTitle = title;
  currentPage = 0;
  atHome = null;
  pageUrls = [];
  pageEls = [];
  currentManga = chapterList.some((c) => c.id === chapterId) ? mangaForList : null;
  setBackdrop(currentManga ? coverOf(currentManga) : "");

  const group = groupOf(chapterList.find((c) => c.id === chapterId));
  pagesEl = h("div", { className: "pages" }, h("p", { className: "muted center" }, "Loading pages…"));
  show(
    readerBar(),
    group ? h("p", { className: "credit" }, `Translated by ${group}`) : null,
    pagesEl,
    endCard(group));

  const res = await md(`/at-home/server/${chapterId}`);
  if (chapterId !== currentChapterId) return; // switched chapters while loading
  atHome = res;
  renderPages(0);
}

function chip(label, isOn, onToggle) {
  const b = h("button", { className: "chip" + (isOn ? " on" : "") }, label);
  b.onclick = () => {
    const on = !b.classList.contains("on");
    b.classList.toggle("on", on);
    onToggle(on);
  };
  return b;
}

function readerBar() {
  const i = chapterIndex();
  progressText = h("span", { className: "count muted" });
  progressFill = h("i");

  const modeLabel = () => (settings.mode === "page" ? "▤ Pages" : "▥ Strip");
  const mode = h("button", { className: "chip", title: "Switch reading mode" }, modeLabel());
  mode.onclick = () => {
    settings.mode = settings.mode === "page" ? "strip" : "page";
    saveSettings();
    mode.textContent = modeLabel();
    if (atHome) renderPages(currentPage);
  };

  return h("div", { className: "readerbar" },
    h("div", { className: "controls" },
      h("button", {
        className: "ghost", title: "Chapter list",
        onclick: () => (currentManga ? showChapters(currentManga) : showHome()),
      }, "←"),
      h("button", { className: "ghost", disabled: i <= 0, onclick: prevChapter }, "‹ Prev"),
      h("span", { className: "title", title: currentTitle }, currentTitle),
      progressText,
      h("button", { className: "ghost", disabled: i < 0 || i >= chapterList.length - 1, onclick: nextChapter }, "Next ›"),
      chip("Follow", following, (on) => {
        following = on;
        if (on && lastRemote?.chapterId === currentChapterId) goToPage(lastRemote.page);
      }),
      chip("HD", settings.hd, (on) => {
        settings.hd = on;
        saveSettings();
        if (atHome) renderPages(currentPage);
      }),
      mode),
    h("div", { className: "progress" }, progressFill));
}

function endCard(group) {
  const i = chapterIndex();
  const next = i >= 0 ? chapterList[i + 1] : null;
  return h("div", { className: "end" },
    h("p", {}, `End of ${currentTitle}${group ? ` · translated by ${group}` : ""}`),
    next
      ? h("button", { className: "primary", onclick: () => pickChapter(next) }, `Next: ${chapterLabel(next)}`)
      : h("p", {}, "You're all caught up."));
}

function renderPages(start = 0) {
  observer?.disconnect();
  const { baseUrl, chapter } = atHome;
  const files = settings.hd ? chapter.data : chapter.dataSaver;
  const dir = settings.hd ? "data" : "data-saver";
  pageUrls = files.map((f) => img(`${baseUrl}/${dir}/${chapter.hash}/${f}`));
  const onload = (e) => e.target.classList.remove("loading");

  if (settings.mode === "page") {
    pageImg = h("img", { alt: "", className: "loading", onload });
    pageEls = [];
    pagesEl.className = "pages single";
    pagesEl.replaceChildren(
      pageImg,
      h("button", { className: "tap tap-left", title: "Previous page", onclick: () => flip(-1) }),
      h("button", { className: "tap tap-right", title: "Next page", onclick: () => flip(1) }));
    showPage(Math.min(start, pageUrls.length - 1));
    updateProgress();
  } else {
    pagesEl.className = "pages strip";
    pageEls = pageUrls.map((src) => h("img", { src, alt: "", loading: "lazy", className: "loading", onload }));
    pagesEl.replaceChildren(...pageEls);
    watchPages();
    if (start > 0) goToPage(start);
    else {
      currentPage = 0;
      updateProgress();
    }
  }
}

function showPage(i) {
  currentPage = i;
  pageImg.classList.add("loading");
  pageImg.src = pageUrls[i];
  if (pageUrls[i + 1]) new Image().src = pageUrls[i + 1]; // preload the next page
  window.scrollTo(0, 0);
}

function flip(d) {
  const i = currentPage + d;
  if (i >= pageUrls.length) return nextChapter();
  if (i < 0) return;
  showPage(i);
  pageChanged();
}

function goToPage(i) {
  if (!pageUrls.length) return;
  i = Math.max(0, Math.min(i, pageUrls.length - 1));
  suppressUntil = Date.now() + 800;
  if (settings.mode === "page") showPage(i);
  else {
    currentPage = i;
    pageEls[i]?.scrollIntoView({ block: "start" });
  }
  pageChanged();
}

// ---------- Page tracking ----------
function watchPages() {
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) currentPage = pageEls.indexOf(e.target);
    pageChanged();
  }, { rootMargin: "-45% 0px -45% 0px" }); // page crossing the middle of the screen
  pageEls.forEach((el) => observer.observe(el));
}

function pageChanged() {
  updateProgress();
  clearTimeout(pageTimer);
  pageTimer = setTimeout(() => {
    sharePage();
    saveProgress();
  }, 200); // debounce
}

function updateProgress() {
  if (!progressText) return;
  const n = pageUrls.length;
  progressText.textContent = n ? `${currentPage + 1} / ${n}` : "";
  progressFill.style.width = n ? `${((currentPage + 1) / n) * 100}%` : "0";
}

function sharePage() {
  if (!following || !currentChapterId || Date.now() < suppressUntil) return;
  share({ chapterId: currentChapterId, title: currentTitle, page: currentPage });
}

// Arrow keys: flip pages in Pages mode, switch chapters in Strip mode
document.addEventListener("keydown", (e) => {
  if (!currentChapterId || e.target.tagName === "INPUT") return;
  if (settings.mode === "page") {
    if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); flip(1); }
    else if (e.key === "ArrowLeft") flip(-1);
  } else if (e.key === "ArrowRight") nextChapter();
  else if (e.key === "ArrowLeft") prevChapter();
});

// ---------- Sync ----------
function share(s) {
  const key = `${s.chapterId}:${s.page}`;
  if (applying || key === lastSent || ws?.readyState !== 1) return;
  lastSent = key;
  ws.send(JSON.stringify({ ...s, by: me?.id || "" }));
  if (me) setLeader(me.id);
}

async function onRemote(e) {
  let s;
  try { s = JSON.parse(e.data); } catch { return; }
  if (!s.chapterId) return;
  lastRemote = s;
  lastSent = `${s.chapterId}:${s.page}`; // don't echo it back
  setLeader(s.by || "");
  applying = true;
  try {
    if (s.chapterId !== currentChapterId) {
      if (s.by && s.by !== me?.id)
        toast(`${nameOf(participants.find((p) => p.id === s.by))} opened ${s.title}`);
      if (!chapterList.some((c) => c.id === s.chapterId)) await loadListFor(s.chapterId).catch(() => {});
      await loadChapter(s.chapterId, s.title);
    }
    if (following) goToPage(s.page);
  } finally {
    applying = false;
    suppressUntil = Date.now() + 800;
  }
}

function connect(room) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}`);
  ws.onmessage = onRemote;
  ws.onclose = () => setTimeout(() => connect(room), 1500); // auto-reconnect
}

// ---------- Discord ----------
async function setupDiscord() {
  const sdk = new DiscordSDK(CLIENT_ID);
  await sdk.ready();
  // Login only powers avatars; reading still works if it fails
  login(sdk).catch((err) => console.warn("Discord login skipped:", err));
  return sdk.instanceId; // everyone in the same Activity shares this
}

async function login(sdk) {
  const { code } = await sdk.commands.authorize({
    client_id: CLIENT_ID,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify", "guilds"],
  });
  const r = await fetch("/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!r.ok) throw new Error("Token exchange failed: " + r.status);
  const { access_token } = await r.json();
  const auth = await sdk.commands.authenticate({ access_token });
  me = auth.user;

  const update = ({ participants: list }) => {
    participants = list;
    renderPresence();
  };
  update(await sdk.commands.getInstanceConnectedParticipants());
  sdk.subscribe("ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE", update);
}

// ---------- Start ----------
window.onunhandledrejection = (e) => toast("Error: " + (e.reason?.message || e.reason));

async function start() {
  let room = "local-test"; // used when testing in a normal browser
  if (new URLSearchParams(location.search).has("frame_id")) room = await setupDiscord();
  showHome();
  connect(room);
}

start();