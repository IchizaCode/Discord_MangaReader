import "./style.css";
import { DiscordSDK } from "@discord/embedded-app-sdk";

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
  el.append(...kids);
  return el;
}

const titleOf = (m) =>
  m.attributes.title.en || Object.values(m.attributes.title)[0] || "Untitled";
const chapterLabel = (c) => {
  const a = c.attributes;
  return `Ch. ${a.chapter ?? "?"}${a.title ? " – " + a.title : ""}`;
};

// ---------- State ----------
let ws = null;
let applying = false;    // true while applying someone else's update
let suppressUntil = 0;   // ignore our own scroll briefly after a remote jump
let following = true;
let lastRemote = null;
let lastSent = "";

let mangaForList = null;
let chapterList = [];
let currentChapterId = null;
let currentTitle = "";
let currentPage = 0;
let pageEls = [];
let observer = null;
let pageTimer = null;

function leaveReader() {
  observer?.disconnect();
  currentChapterId = null;
}

// ---------- Screen 1: search ----------
function showSearch() {
  leaveReader();
  const input = h("input", { type: "search", placeholder: "Search manga…" });
  const results = h("div", { className: "grid" });
  const form = h("form", {
    onsubmit: (e) => {
      e.preventDefault();
      if (input.value.trim()) search(input.value.trim(), results);
    },
  }, input, h("button", {}, "Search"));

  app.replaceChildren(h("h1", {}, "Manga Reader"), form, results);
  input.focus();
}

async function search(q, results) {
  results.replaceChildren("Searching…");
  const p = new URLSearchParams({ title: q, limit: 24 });
  p.append("includes[]", "cover_art");
  p.append("contentRating[]", "safe");
  p.append("contentRating[]", "suggestive");

  const { data } = await md("/manga?" + p);
  if (!data.length) return results.replaceChildren("No results.");

  results.replaceChildren(...data.map((m) => {
    const file = m.relationships.find((r) => r.type === "cover_art")?.attributes?.fileName;
    const src = file ? img(`https://uploads.mangadex.org/covers/${m.id}/${file}.256.jpg`) : "";
    return h("button", { className: "card", onclick: () => showChapters(m) },
      h("img", { src, alt: "", loading: "lazy" }),
      h("span", {}, titleOf(m)));
  }));
}

// ---------- Screen 2: chapter list ----------
async function fetchChapters(mangaId) {
  const p = new URLSearchParams({ limit: 500, "order[chapter]": "asc" });
  p.append("translatedLanguage[]", "en");
  const { data } = await md(`/manga/${mangaId}/feed?${p}`);
  // Skip chapters hosted on external sites (they have 0 pages on MangaDex)
  return data.filter((c) => c.attributes.pages > 0);
}

async function showChapters(m) {
  leaveReader();
  const list = h("div", { className: "list" }, "Loading chapters…");
  app.replaceChildren(
    h("button", { onclick: showSearch }, "← Back"),
    h("h2", {}, titleOf(m)),
    list);

  const chapters = await fetchChapters(m.id);
  mangaForList = m;
  chapterList = chapters;
  if (!chapters.length) return list.replaceChildren("No English chapters available.");

  list.replaceChildren(...chapters.map((c) =>
    h("button", { onclick: () => pickChapter(c) }, chapterLabel(c))));
}

// Someone else picked a chapter we don't have a list for yet
async function loadListFor(chapterId) {
  const { data } = await md(`/chapter/${chapterId}`);
  const mangaId = data.relationships.find((r) => r.type === "manga")?.id;
  if (!mangaId) return;
  const [{ data: m }, chapters] = await Promise.all([md(`/manga/${mangaId}`), fetchChapters(mangaId)]);
  mangaForList = m;
  chapterList = chapters;
}

// ---------- Screen 3: reader ----------
async function pickChapter(c) {
  const title = chapterLabel(c);
  await loadChapter(c.id, title);
  share({ chapterId: c.id, title, page: 0 });
}

async function loadChapter(chapterId, title) {
  observer?.disconnect();
  currentChapterId = chapterId;
  currentTitle = title;
  currentPage = 0;
  pageEls = [];

  const i = chapterList.findIndex((c) => c.id === chapterId);
  const pages = h("div", { className: "pages" }, "Loading pages…");
  const nav = (withFollow) => h("div", { className: "nav" },
    h("button", { onclick: () => (mangaForList ? showChapters(mangaForList) : showSearch()) }, "← Chapters"),
    h("button", { disabled: i <= 0, onclick: () => pickChapter(chapterList[i - 1]) }, "Prev"),
    h("span", {}, title),
    h("button", { disabled: i < 0 || i >= chapterList.length - 1, onclick: () => pickChapter(chapterList[i + 1]) }, "Next"),
    withFollow ? followToggle() : "");

  app.replaceChildren(nav(true), pages, nav(false));
  window.scrollTo(0, 0);

  const { baseUrl, chapter } = await md(`/at-home/server/${chapterId}`);
  if (chapterId !== currentChapterId) return; // switched chapters while loading

  pageEls = chapter.dataSaver.map((f) => h("img", {
    src: img(`${baseUrl}/data-saver/${chapter.hash}/${f}`),
    alt: "",
    loading: "lazy",
    className: "loading",
    onload: (e) => e.target.classList.remove("loading"),
  }));
  pages.replaceChildren(...pageEls);
  watchPages();
}

function followToggle() {
  const box = h("input", { type: "checkbox", checked: following });
  box.onchange = () => {
    following = box.checked;
    if (following && lastRemote?.chapterId === currentChapterId) scrollToPage(lastRemote.page);
  };
  return h("label", { className: "follow" }, box, " Follow");
}

// ---------- Page tracking ----------
function watchPages() {
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) currentPage = pageEls.indexOf(e.target);
    clearTimeout(pageTimer);
    pageTimer = setTimeout(sharePage, 200); // debounce
  }, { rootMargin: "-45% 0px -45% 0px" }); // page crossing the middle of the screen
  pageEls.forEach((el) => observer.observe(el));
}

function sharePage() {
  if (!following || !currentChapterId || Date.now() < suppressUntil) return;
  share({ chapterId: currentChapterId, title: currentTitle, page: currentPage });
}

function scrollToPage(i) {
  const el = pageEls[i];
  if (!el) return;
  suppressUntil = Date.now() + 800;
  el.scrollIntoView({ block: "start" });
}

// ---------- Sync ----------
function share(s) {
  const key = `${s.chapterId}:${s.page}`;
  if (applying || key === lastSent || ws?.readyState !== 1) return;
  lastSent = key;
  ws.send(JSON.stringify(s));
}

async function onRemote(e) {
  let s;
  try { s = JSON.parse(e.data); } catch { return; }
  if (!s.chapterId) return;
  lastRemote = s;
  lastSent = `${s.chapterId}:${s.page}`; // don't echo it back

  applying = true;
  try {
    if (s.chapterId !== currentChapterId) {
      if (!chapterList.some((c) => c.id === s.chapterId)) await loadListFor(s.chapterId).catch(() => {});
      await loadChapter(s.chapterId, s.title);
    }
    if (following) scrollToPage(s.page);
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

// ---------- Start ----------
window.onunhandledrejection = (e) =>
  app.prepend(h("p", { className: "error" }, "Error: " + (e.reason?.message || e.reason)));

async function start() {
  let room = "local-test"; // used when testing in a normal browser
  if (new URLSearchParams(location.search).has("frame_id")) {
    const sdk = new DiscordSDK(import.meta.env.VITE_CLIENT_ID);
    await sdk.ready();
    room = sdk.instanceId; // everyone in the same Activity shares this
  }
  showSearch();
  connect(room);
}
start();