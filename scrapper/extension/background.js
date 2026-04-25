// Background service worker. Handles recurring "watch" scrapes via chrome.alarms,
// and applies topic-based overlays on the active web tab.

const ALARM_NAME = "yt-scrape-watch";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8765/tiles";
const DEFAULT_MODE = "lookahead";
const DEFAULT_INTERVAL_MIN = 0.05;

function applyOverlayFn({ blockedVideoIds, blockedItemKeys }) {
  const blockedVideos = new Set((blockedVideoIds || []).filter(Boolean));
  const blockedKeys = new Set((blockedItemKeys || []).filter(Boolean));

  const normalizeUrl = (url) => {
    if (!url) return "";
    try {
      const u = new URL(url, location.origin);
      const keep = new URLSearchParams();
      for (const key of ["v", "list", "p", "q", "query", "k", "tbm", "search_query"]) {
        const val = u.searchParams.get(key);
        if (val) keep.set(key, val);
      }
      const qs = keep.toString();
      return `${u.origin}${u.pathname}${qs ? "?" + qs : ""}`;
    } catch (_) {
      return "";
    }
  };
  const videoIdFromUrl = (url) => {
    if (!url) return "";
    try {
      const u = new URL(url, location.origin);
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/shorts\/([^/?#]+)/);
      if (m) return m[1];
    } catch (_) {}
    return "";
  };
  const itemKeyFromUrl = (url) => {
    const norm = normalizeUrl(url);
    return norm ? `url:${norm}` : "";
  };
  const isUiChrome = (el) => {
    if (!el || !(el instanceof Element)) return true;
    if (el.matches("html, body, main, header, nav, aside, footer, form")) return true;
    if (el.closest("header, nav, aside, footer, form, [role='search'], [role='navigation'], [role='toolbar']")) return true;
    if (el.querySelector("input, textarea, select, [contenteditable='true']")) return true;
    return false;
  };

  // Reset previous overlays so each pass reflects the latest classifier output.
  for (const old of document.querySelectorAll(".lockin-overlay")) old.remove();
  for (const el of document.querySelectorAll("[data-lockin-blocked='1']")) {
    el.removeAttribute("data-lockin-blocked");
    if (el.dataset.lockinPrevPosition) {
      el.style.position = el.dataset.lockinPrevPosition;
      delete el.dataset.lockinPrevPosition;
    }
  }

  if (blockedVideos.size === 0 && blockedKeys.size === 0) return { blockedCount: 0 };

  const hostSelectors = [
    ".g",
    "[data-sokoban-container]",
    "[data-testid='tweet']",
    "[data-testid='cellInnerDiv']",
    "[role='article']",
    "article",
    "li",
    "section",
    "ytd-rich-item-renderer",
    "ytd-rich-grid-media",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-reel-item-renderer",
    "ytd-reel-shelf-renderer",
    "ytd-shorts",
    "ytd-shorts-lockup-view-model",
    "ytm-shorts-lockup-view-model",
    "yt-lockup-view-model",
  ];

  const makeOverlay = () => {
    const d = document.createElement("div");
    d.className = "lockin-overlay";
    d.textContent = "Blocked by LockIn";
    Object.assign(d.style, {
      position: "absolute",
      inset: "0",
      zIndex: "9999",
      background: "rgba(20, 20, 20, 0.88)",
      color: "#f5f5f5",
      display: "grid",
      placeItems: "center",
      textAlign: "center",
      fontWeight: "700",
      fontSize: "14px",
      letterSpacing: "0.2px",
      backdropFilter: "blur(3px)",
      pointerEvents: "auto",
    });
    return d;
  };

  const maybeBlockHost = (host) => {
    if (!host) return false;
    if (isUiChrome(host)) return false;

    const rect = host.getBoundingClientRect();
    const vpW = window.innerWidth || document.documentElement.clientWidth;
    const vpH = window.innerHeight || document.documentElement.clientHeight;
    // Avoid blanketing whole-app containers.
    if (rect.width > vpW * 0.98 || rect.height > vpH * 0.9) return false;

    const links = host.querySelectorAll("a[href]");
    let shouldBlock = false;
    for (const a of links) {
      const raw = a.getAttribute("href") || "";
      let full = "";
      try { full = new URL(raw, location.origin).toString(); } catch (_) { full = raw; }
      const vid = videoIdFromUrl(full);
      const key = itemKeyFromUrl(full);
      if ((vid && blockedVideos.has(vid)) || (key && blockedKeys.has(key))) {
        shouldBlock = true;
        break;
      }
    }
    if (!shouldBlock) return false;

    const prevPos = getComputedStyle(host).position;
    if (prevPos === "static") {
      host.dataset.lockinPrevPosition = "static";
      host.style.position = "relative";
    }
    host.dataset.lockinBlocked = "1";
    host.appendChild(makeOverlay());
    return true;
  };

  const pickGenericHost = (anchor) => {
    let el = anchor;
    for (let i = 0; i < 7 && el && el !== document.body; i++) {
      if (isUiChrome(el)) {
        el = el.parentElement;
        continue;
      }
      const rect = el.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const vpW = window.innerWidth || document.documentElement.clientWidth;
      const vpH = window.innerHeight || document.documentElement.clientHeight;
      if (area >= 10000 && rect.width <= vpW * 0.98 && rect.height <= vpH * 0.9) return el;
      el = el.parentElement;
    }
    return anchor.parentElement || anchor;
  };

  let blockedCount = 0;
  const seenHosts = new Set();
  for (const host of document.querySelectorAll(hostSelectors.join(","))) {
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    if (maybeBlockHost(host)) blockedCount += 1;
  }

  // Generic fallback for sites that don't expose card-like host tags.
  if (blockedCount === 0 || blockedKeys.size > 0) {
    for (const a of document.querySelectorAll("a[href]")) {
      if (a.closest("header, nav, aside, footer, form, [role='search'], [role='navigation'], [role='toolbar']")) continue;
      const raw = a.getAttribute("href") || "";
      let full = "";
      try { full = new URL(raw, location.origin).toString(); } catch (_) { full = raw; }
      const vid = videoIdFromUrl(full);
      const key = itemKeyFromUrl(full);
      if (!((vid && blockedVideos.has(vid)) || (key && blockedKeys.has(key)))) continue;
      const host = pickGenericHost(a);
      if (!host || seenHosts.has(host)) continue;
      seenHosts.add(host);
      if (maybeBlockHost(host)) blockedCount += 1;
    }
  }

  return { blockedCount };
}

function scrapeFn({ mode, lookahead }) {
  const SELECTORS = [
    "ytd-rich-item-renderer",
    "ytd-rich-grid-media",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-playlist-renderer",
    "ytd-grid-playlist-renderer",
    "ytd-compact-playlist-renderer",
    "ytd-radio-renderer",
    "ytd-compact-radio-renderer",
    "ytd-movie-renderer",
    "ytd-grid-movie-renderer",
    "ytd-promoted-video-renderer",
    "ytd-universal-watch-card-renderer",
    "ytd-rich-shelf-renderer",
    "ytd-shelf-renderer",
    "ytd-reel-item-renderer",
    "ytd-reel-shelf-renderer",
    "ytd-shorts",
    "ytd-shorts-lockup-view-model",
    "yt-lockup-view-model",
    "ytm-shorts-lockup-view-model",
  ];
  const GENERIC_SELECTORS = [
    "article",
    "main li",
    "main div",
    "section",
    ".g",
    "[role='article']",
    "[data-testid='cellInnerDiv']",
    "[data-testid='tweet']",
  ];
  const TITLE_SEL = [
    "h1", "h2", "h3", "h4",
    "a[title]",
    "#video-title-link", "a#video-title", "#video-title",
    "h3 a#video-title-link", "h3 #video-title",
    "yt-formatted-string#video-title",
    "a.yt-lockup-metadata-view-model-wiz__title",
    ".yt-lockup-metadata-view-model-wiz__title span",
    "h3 .yt-core-attributed-string",
  ];
  const CHANNEL_SEL = [
    "[class*='author']",
    "[class*='channel']",
    "[class*='byline']",
    "ytd-channel-name #text a", "ytd-channel-name #text", "ytd-channel-name a",
    "#channel-name #text", "#channel-name a",
    "#byline a", "#byline", ".ytd-channel-name",
    ".yt-content-metadata-view-model-wiz__metadata-row a",
    ".yt-content-metadata-view-model-wiz__metadata-text",
  ];
  const DESC_SEL = [
    "p",
    "[class*='snippet']",
    "[class*='description']",
    "#description-text", "yt-formatted-string#description-text",
    ".metadata-snippet-text", "#description",
  ];

  const firstText = (el, list) => {
    for (const sel of list) {
      const node = el.querySelector(sel);
      if (!node) continue;
      const t = (node.getAttribute && node.getAttribute("title")) || node.textContent || "";
      const cleaned = t.replace(/\s+/g, " ").trim();
      if (cleaned) return cleaned;
    }
    return "";
  };
  const isUiChrome = (el) => {
    if (!el || !(el instanceof Element)) return true;
    if (el.matches("html, body, main, header, nav, aside, footer, form")) return true;
    if (el.closest("header, nav, aside, footer, form, [role='search'], [role='navigation'], [role='toolbar']")) return true;
    if (el.querySelector("input, textarea, select, [contenteditable='true']")) return true;
    return false;
  };
  const firstHref = (el) => {
    const cand = el.querySelector(
      "a#thumbnail[href], a#video-title-link[href], a#video-title[href], a.yt-lockup-metadata-view-model-wiz__title[href], a[href*='/watch?v='], a[href*='/shorts/'], a[href*='/playlist?list='], a[href*='/browse/'], a[href]"
    );
    if (!cand) return "";
    const h = cand.getAttribute("href") || "";
    if (!h) return "";
    try { return new URL(h, location.origin).toString(); } catch (_) { return h; }
  };
  const normalizeUrl = (url) => {
    if (!url) return "";
    try {
      const u = new URL(url, location.origin);
      const keep = new URLSearchParams();
      for (const key of ["v", "list", "p", "q", "query", "k", "tbm", "search_query"]) {
        const val = u.searchParams.get(key);
        if (val) keep.set(key, val);
      }
      const qs = keep.toString();
      return `${u.origin}${u.pathname}${qs ? "?" + qs : ""}`;
    } catch (_) {
      return "";
    }
  };
  const itemKeyFrom = (url, vid, fallback) => {
    if (vid) return `video:${vid}`;
    const norm = normalizeUrl(url);
    if (norm) return `url:${norm}`;
    const fb = (fallback || "").trim().toLowerCase().slice(0, 120);
    return fb ? `text:${fb}` : "";
  };
  const videoIdFromUrl = (url) => {
    if (!url) return "";
    try {
      const u = new URL(url);
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/shorts\/([^/?#]+)/);
      if (m) return m[1];
    } catch (_) {}
    return "";
  };
  const firstThumb = (el) => {
    const img = el.querySelector("img#img, img.yt-core-image, img");
    if (!img) return "";
    return img.getAttribute("src") || img.getAttribute("data-thumb") || "";
  };

  const vpH = window.innerHeight || document.documentElement.clientHeight;
  const counts = { viewport_h: vpH, mode, lookahead, page_url: location.href, by_selector: {}, kept: 0, fallback_used: false };
  const seenEls = new Set();
  const seenIds = new Set();
  const seenKeys = new Set();
  const out = [];
  const ts = new Date().toISOString();

  const passesViewport = (rect) => {
    if (rect.width === 0 && rect.height === 0) return false;
    if (mode === "strict") return rect.bottom > 0 && rect.top < vpH;
    if (mode === "lookahead") return rect.bottom > 0 && rect.top < vpH + lookahead;
    return true; // "all"
  };

  for (const sel of [...SELECTORS, ...GENERIC_SELECTORS]) {
    const nodes = document.querySelectorAll(sel);
    counts.by_selector[sel] = nodes.length;
    for (const el of nodes) {
      if (seenEls.has(el)) continue;
      seenEls.add(el);
      if (isUiChrome(el)) continue;
      if (!passesViewport(el.getBoundingClientRect())) continue;

      const url = firstHref(el);
      const vid = videoIdFromUrl(url);
      const title = firstText(el, TITLE_SEL);
      const channel = firstText(el, CHANNEL_SEL);
      // Shorts cards can be sparse; keep id-backed items even without readable metadata.
      if (!title && !channel && !vid) continue;
      const itemKey = itemKeyFrom(url, vid, `${title}|${channel}`);
      if (vid) {
        if (seenIds.has(vid)) continue;
        seenIds.add(vid);
      }
      if (!itemKey || seenKeys.has(itemKey)) continue;
      seenKeys.add(itemKey);
      out.push({
        item_key: itemKey,
        video_id: vid,
        title,
        channel,
        description: firstText(el, DESC_SEL),
        thumbnail_url: firstThumb(el),
        url,
        tile_type: sel,
        scraped_at: ts,
        page_url: location.href,
      });
    }
  }

  // Wide scan: include all visible links as content candidates.
  counts.fallback_used = true;
  const links = document.querySelectorAll("a[href]");
  counts.fallback_links = links.length;
  for (const a of links) {
    if (a.closest("header, nav, aside, footer, form, [role='search'], [role='navigation'], [role='toolbar']")) continue;
    const url = (() => {
      try { return new URL(a.getAttribute("href"), location.origin).toString(); }
      catch (_) { return a.href || ""; }
    })();
    if (!url || url.startsWith("javascript:") || url.startsWith("mailto:")) continue;
    const vid = videoIdFromUrl(url);
    const text = (a.getAttribute("title") || a.textContent || "").replace(/\s+/g, " ").trim();
    const itemKey = itemKeyFrom(url, vid, text);
    if (!itemKey || seenKeys.has(itemKey)) continue;

    // Find the smallest containing card-ish ancestor to read title + channel from.
    const card = a.closest([...SELECTORS, ...GENERIC_SELECTORS].join(",")) || a.parentElement || a;
    if (isUiChrome(card)) continue;

    if (!passesViewport(card.getBoundingClientRect())) continue;
    const channel = firstText(card, CHANNEL_SEL);
    if (!text && !channel && !vid) continue;

    if (vid) seenIds.add(vid);
    seenKeys.add(itemKey);
    out.push({
      item_key: itemKey,
      video_id: vid,
      title: text,
      channel,
      description: firstText(card, DESC_SEL),
      thumbnail_url: firstThumb(card),
      url,
      tile_type: "fallback:link",
      scraped_at: ts,
      page_url: location.href,
    });
  }

  counts.kept = out.length;
  // Dump counts to the page console so the user can verify in DevTools.
  try { console.log("[YT Tile Scraper] counts:", counts); } catch (_) {}
  return { tiles: out, counts };
}

async function getActiveWebTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.url) return null;
  if (!/^https?:\/\//.test(tab.url)) return null;
  return tab;
}

async function scrapeAndSend() {
  const {
    endpoint = DEFAULT_ENDPOINT,
    mode = DEFAULT_MODE,
    topic = "",
  } = await chrome.storage.local.get(["endpoint", "mode", "topic"]);
  const tab = await getActiveWebTab();
  if (!tab) {
    return { ok: false, reason: "No active HTTP(S) tab. Open a normal web page and try again." };
  }
  let scrapeResult = { tiles: [], counts: {} };
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeFn,
      args: [{ mode, lookahead: 3000 }],
    });
    scrapeResult = result || { tiles: [], counts: {} };
  } catch (e) {
    return { ok: false, reason: "Scrape failed: " + e.message };
  }
  const tiles = scrapeResult.tiles || [];
  const counts = scrapeResult.counts || {};

  if (tiles.length === 0) {
    const breakdown = Object.entries(counts.by_selector || {}).filter(([, n]) => n > 0).map(([k, v]) => `${k}:${v}`).join(", ");
    const fb = counts.fallback_used ? ` fallback_links=${counts.fallback_links || 0}` : "";
    return {
      ok: true, sent: 0, accepted: 0, counts,
      reason: `0 tiles. selectors=[${breakdown || "none matched"}]${fb}. mode=${counts.mode} vp=${counts.viewport_h}. URL=${counts.page_url}`,
    };
  }
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tiles, page_url: tab.url, topic }),
    });
    if (!resp.ok) return { ok: false, reason: `Receiver returned ${resp.status}.`, counts };
    const data = await resp.json().catch(() => ({}));
    const accepted = typeof data.accepted === "number" ? data.accepted : tiles.length;
    const blockedVideoIds = Array.isArray(data.blocked_video_ids) ? data.blocked_video_ids : [];
    const blockedItemKeys = Array.isArray(data.blocked_item_keys) ? data.blocked_item_keys : [];
    let blockedOnPage = 0;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: applyOverlayFn,
        args: [{ blockedVideoIds, blockedItemKeys }],
      });
      blockedOnPage = Number(result && result.blockedCount) || 0;
    } catch (_) {
      blockedOnPage = 0;
    }
    return { ok: true, sent: tiles.length, accepted, blocked: blockedOnPage, counts };
  } catch (e) {
    return { ok: false, reason: `Receiver unreachable (${e.message}). Is yt_receiver.py running on ${endpoint}?`, counts };
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const result = await scrapeAndSend();
  await chrome.storage.local.set({ lastResult: result, lastAt: Date.now() });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg && msg.cmd === "scrape") {
      sendResponse(await scrapeAndSend());
    } else if (msg && msg.cmd === "watch-start") {
      const minutes = Math.max(0.05, Number(msg.intervalMinutes) || DEFAULT_INTERVAL_MIN);
      await chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
      const result = await scrapeAndSend();
      await chrome.storage.local.set({ watchOn: true, lastResult: result, lastAt: Date.now() });
      sendResponse({ ok: true, watchOn: true, immediate: result });
    } else if (msg && msg.cmd === "watch-stop") {
      await chrome.alarms.clear(ALARM_NAME);
      await chrome.storage.local.set({ watchOn: false });
      sendResponse({ ok: true, watchOn: false });
    } else {
      sendResponse({ ok: false, reason: "unknown cmd" });
    }
  })();
  return true;
});
