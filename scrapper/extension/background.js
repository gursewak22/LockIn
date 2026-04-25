// Background service worker. Handles recurring "watch" scrapes via chrome.alarms,
// since popups close as soon as the user clicks away.

const ALARM_NAME = "yt-scrape-watch";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8765/tiles";
const DEFAULT_MODE = "lookahead";
const DEFAULT_INTERVAL_MIN = 0.05;

function applyOverlayFn({ blockedVideoIds }) {
  const blocked = new Set((blockedVideoIds || []).filter(Boolean));

  // Reset previous overlays so each pass reflects the latest classifier output.
  for (const old of document.querySelectorAll(".lockin-overlay")) old.remove();
  for (const el of document.querySelectorAll("[data-lockin-blocked='1']")) {
    el.removeAttribute("data-lockin-blocked");
    if (el.dataset.lockinPrevPosition) {
      el.style.position = el.dataset.lockinPrevPosition;
      delete el.dataset.lockinPrevPosition;
    }
  }

  if (blocked.size === 0) return { blockedCount: 0 };

  const hostSelectors = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-reel-item-renderer",
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

  const seenHosts = new Set();
  let blockedCount = 0;

  for (const vid of blocked) {
    const esc = (window.CSS && CSS.escape) ? CSS.escape(vid) : vid;
    const links = [
      ...document.querySelectorAll(`a[href*='watch?v=${esc}']`),
      ...document.querySelectorAll(`a[href*='/shorts/${esc}']`),
    ];
    for (const a of links) {
      const host = a.closest(hostSelectors.join(","));
      if (!host || seenHosts.has(host)) continue;
      seenHosts.add(host);

      const prevPos = getComputedStyle(host).position;
      if (prevPos === "static") {
        host.dataset.lockinPrevPosition = "static";
        host.style.position = "relative";
      }
      host.dataset.lockinBlocked = "1";
      host.appendChild(makeOverlay());
      blockedCount += 1;
    }
  }

  return { blockedCount };
}

function scrapeFn({ mode, lookahead }) {
  const SELECTORS = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-reel-item-renderer",
    "yt-lockup-view-model",
    "ytm-shorts-lockup-view-model",
  ];
  const TITLE_SEL = [
    "#video-title-link", "a#video-title", "#video-title",
    "h3 a#video-title-link", "h3 #video-title",
    "yt-formatted-string#video-title",
    "a.yt-lockup-metadata-view-model-wiz__title",
    ".yt-lockup-metadata-view-model-wiz__title span",
    "h3 .yt-core-attributed-string",
  ];
  const CHANNEL_SEL = [
    "ytd-channel-name #text a", "ytd-channel-name #text", "ytd-channel-name a",
    "#channel-name #text", "#channel-name a",
    "#byline a", "#byline", ".ytd-channel-name",
    ".yt-content-metadata-view-model-wiz__metadata-row a",
    ".yt-content-metadata-view-model-wiz__metadata-text",
  ];
  const DESC_SEL = [
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
  const firstHref = (el) => {
    const cand = el.querySelector(
      "a#thumbnail[href], a#video-title-link[href], a#video-title[href], a.yt-lockup-metadata-view-model-wiz__title[href], a[href*='/watch?v='], a[href*='/shorts/']"
    );
    if (!cand) return "";
    const h = cand.getAttribute("href") || "";
    if (!h) return "";
    try { return new URL(h, location.origin).toString(); } catch (_) { return h; }
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
  const out = [];
  const ts = new Date().toISOString();

  const passesViewport = (rect) => {
    if (rect.width === 0 && rect.height === 0) return false;
    if (mode === "strict") return rect.bottom > 0 && rect.top < vpH;
    if (mode === "lookahead") return rect.bottom > 0 && rect.top < vpH + lookahead;
    return true; // "all"
  };

  for (const sel of SELECTORS) {
    const nodes = document.querySelectorAll(sel);
    counts.by_selector[sel] = nodes.length;
    for (const el of nodes) {
      if (seenEls.has(el)) continue;
      seenEls.add(el);
      if (!passesViewport(el.getBoundingClientRect())) continue;

      const title = firstText(el, TITLE_SEL);
      const channel = firstText(el, CHANNEL_SEL);
      if (!title && !channel) continue;

      const url = firstHref(el);
      const vid = videoIdFromUrl(url);
      if (vid) {
        if (seenIds.has(vid)) continue;
        seenIds.add(vid);
      }
      out.push({
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

  // Fallback: if structured selectors found nothing, scan every video link and synthesize tiles.
  if (out.length === 0) {
    counts.fallback_used = true;
    const links = document.querySelectorAll("a[href*='/watch?v='], a[href*='/shorts/']");
    counts.fallback_links = links.length;
    for (const a of links) {
      const url = (() => {
        try { return new URL(a.getAttribute("href"), location.origin).toString(); }
        catch (_) { return a.href || ""; }
      })();
      const vid = videoIdFromUrl(url);
      if (!vid || seenIds.has(vid)) continue;

      // Find the smallest containing card-ish ancestor to read title + channel from.
      let host = a;
      for (let i = 0; i < 6 && host && host !== document.body; i++) host = host.parentElement;
      const card = host || a.parentElement || a;

      if (!passesViewport(card.getBoundingClientRect())) continue;

      const title = (a.getAttribute("title") || a.textContent || "").replace(/\s+/g, " ").trim();
      const channel = firstText(card, CHANNEL_SEL);
      if (!title && !channel) continue;

      seenIds.add(vid);
      out.push({
        video_id: vid,
        title,
        channel,
        description: firstText(card, DESC_SEL),
        thumbnail_url: firstThumb(card),
        url,
        tile_type: "fallback:link",
        scraped_at: ts,
        page_url: location.href,
      });
    }
  }

  counts.kept = out.length;
  // Dump counts to the page console so the user can verify in DevTools.
  try { console.log("[YT Tile Scraper] counts:", counts); } catch (_) {}
  return { tiles: out, counts };
}

async function getYouTubeTab() {
  const tabs = await chrome.tabs.query({});
  const yt = tabs.filter((t) => t.url && /youtube\.com/.test(t.url));
  if (yt.length === 0) return null;
  const active = yt.find((t) => t.active);
  if (active) return active;
  yt.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return yt[0];
}

async function scrapeAndSend() {
  const {
    endpoint = DEFAULT_ENDPOINT,
    mode = DEFAULT_MODE,
    topic = "",
  } = await chrome.storage.local.get(["endpoint", "mode", "topic"]);
  const tab = await getYouTubeTab();
  if (!tab) {
    return { ok: false, reason: "No YouTube tab open." };
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
    let blockedOnPage = 0;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: applyOverlayFn,
        args: [{ blockedVideoIds }],
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
