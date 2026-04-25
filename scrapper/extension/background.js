// Background service worker. Handles recurring "watch" scrapes via chrome.alarms,
// since popups close as soon as the user clicks away.

const ALARM_NAME = "yt-scrape-watch";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8765/tiles";
const DEFAULT_MODE = "lookahead";
const DEFAULT_INTERVAL_MIN = 0.05;
const DEFAULT_MODEL_SETTINGS = {
  enabled: false,
  endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
  model: "gemini-2.5-flash",
  apiKey: "",
};

const DEFAULT_PROFILE = {
  id: "default-profile",
  name: "Computer science student",
  description: "Focus on algorithms, data structures, system design, ML, and practical coding content.",
  tags: ["dsa", "algorithms", "data structures", "ml", "dl", "system design", "python"],
  active: true,
};

const MODEL_CHUNK_SIZE = 16;

function makeId(prefix) {
  if (crypto && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function uniqStrings(list) {
  return [...new Set((list || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeTag(tag) {
  return String(tag || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function splitTags(text) {
  return uniqStrings(String(text || "").split(/[,\n]/g).map(normalizeTag));
}

function topicWords(text) {
  return uniqStrings(String(text || "").toLowerCase().match(/[a-z0-9]+/g) || []).filter((word) => word.length >= 3);
}

function ensureProfileShape(profile) {
  const tags = Array.isArray(profile && profile.tags) ? profile.tags.map(normalizeTag) : [];
  return {
    id: String(profile && profile.id ? profile.id : makeId("profile")),
    name: String(profile && profile.name ? profile.name : DEFAULT_PROFILE.name).trim() || DEFAULT_PROFILE.name,
    description: String(profile && profile.description ? profile.description : "").trim(),
    tags: uniqStrings(tags),
    active: !!(profile && profile.active),
  };
}

function buildDefaultProfile() {
  return ensureProfileShape(DEFAULT_PROFILE);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get([
    "endpoint",
    "mode",
    "topic",
    "watchOn",
    "lastResult",
    "lastAt",
    "profiles",
    "activeProfileId",
    "modelSettings",
  ]);
  const profiles = Array.isArray(stored.profiles) && stored.profiles.length
    ? stored.profiles.map(ensureProfileShape)
    : [buildDefaultProfile()];
  const activeProfileId = String(stored.activeProfileId || profiles.find((profile) => profile.active)?.id || profiles[0].id);
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) || profiles[0];
  const modelSettings = { ...DEFAULT_MODEL_SETTINGS, ...(stored.modelSettings || {}) };
  modelSettings.enabled = !!modelSettings.enabled;
  modelSettings.endpoint = String(modelSettings.endpoint || DEFAULT_MODEL_SETTINGS.endpoint).trim();
  modelSettings.model = String(modelSettings.model || DEFAULT_MODEL_SETTINGS.model).trim();
  modelSettings.apiKey = String(modelSettings.apiKey || "");
  return {
    endpoint: stored.endpoint || DEFAULT_ENDPOINT,
    mode: stored.mode || DEFAULT_MODE,
    topic: String(stored.topic || "").trim(),
    watchOn: !!stored.watchOn,
    lastResult: stored.lastResult || null,
    lastAt: stored.lastAt || 0,
    profiles,
    activeProfileId,
    activeProfile,
    modelSettings,
  };
}

function profilePrompt(profile, fallbackTopic) {
  const activeProfile = profile || buildDefaultProfile();
  const tags = uniqStrings(activeProfile.tags || []);
  const topic = String(fallbackTopic || "").trim();
  const notes = [];
  if (activeProfile.description) notes.push(activeProfile.description);
  if (topic) notes.push(`Fallback topic: ${topic}`);
  return {
    name: activeProfile.name,
    description: notes.join(" "),
    tags,
  };
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {}
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch (_) {}
  }
  return null;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

function tileSummary(tile) {
  return {
    item_key: String(tile.item_key || tile.video_id || tile.url || "").trim(),
    video_id: String(tile.video_id || "").trim(),
    url: String(tile.url || "").trim(),
    title: String(tile.title || "").trim(),
    channel: String(tile.channel || "").trim(),
    description: String(tile.description || "").trim(),
  };
}

function heuristicIrrelevant(tile, profile, fallbackTopic) {
  const text = [tile.title, tile.channel, tile.description].join(" ").toLowerCase();
  const tags = uniqStrings([...(profile && profile.tags) || [], ...topicWords(fallbackTopic)]).map(normalizeTag).filter(Boolean);
  if (tags.length === 0) return false;
  return !tags.some((tag) => tag && text.includes(tag));
}

async function callChatCompletion(modelSettings, messages) {
  const endpoint = String(modelSettings.endpoint || "").trim();
  const apiKey = String(modelSettings.apiKey || "").trim();
  const isGemini = /generativelanguage\.googleapis\.com|:generateContent/i.test(endpoint);

  if (isGemini) {
    const systemPrompt = messages.filter((m) => m && m.role === "system").map((m) => String(m.content || "").trim()).filter(Boolean).join("\n\n");
    const userPrompt = messages.filter((m) => m && m.role !== "system").map((m) => String(m.content || "").trim()).filter(Boolean).join("\n\n");

    const url = (() => {
      try {
        const u = new URL(endpoint);
        if (apiKey && !u.searchParams.get("key")) u.searchParams.set("key", apiKey);
        return u.toString();
      } catch (_) {
        return endpoint;
      }
    })();

    const geminiPayload = {
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0 },
    };
    if (systemPrompt) {
      geminiPayload.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(geminiPayload),
    });
    if (!resp.ok) {
      throw new Error(`Model endpoint returned ${resp.status}`);
    }
    const data = await resp.json();
    const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    const content = Array.isArray(parts)
      ? parts.map((part) => String(part && part.text ? part.text : "")).join("\n").trim()
      : "";
    if (!content) {
      throw new Error("Model response did not include text content");
    }
    return content;
  }

  const resp = await fetch(modelSettings.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelSettings.model,
      messages,
      temperature: 0,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Model endpoint returned ${resp.status}`);
  }
  const data = await resp.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== "string") {
    throw new Error("Model response did not include text content");
  }
  return content;
}

async function suggestTags(profile, modelSettings, fallbackTopic) {
  const summary = profilePrompt(profile, fallbackTopic);
  const seedTags = uniqStrings(summary.tags);
  const fallback = uniqStrings([...seedTags, ...topicWords(summary.name), ...topicWords(summary.description)]).slice(0, 12);
  if (!modelSettings.enabled || !modelSettings.apiKey || !modelSettings.endpoint) {
    return fallback;
  }
  try {
    const content = await callChatCompletion(modelSettings, [
      { role: "system", content: "Return valid JSON only." },
      {
        role: "user",
        content: [
          "Suggest 8 to 12 concise lowercase interest tags for this profile.",
          "Return JSON exactly like {\"tags\":[\"tag1\",\"tag2\"]}.",
          `Profile name: ${summary.name}`,
          `Profile description: ${summary.description || "(none)"}`,
          `Existing tags: ${seedTags.join(", ") || "(none)"}`,
        ].join("\n"),
      },
    ]);
    const parsed = extractJsonObject(content);
    const tags = Array.isArray(parsed && parsed.tags) ? parsed.tags : [];
    return uniqStrings(tags.map(normalizeTag)).slice(0, 12).concat(fallback).slice(0, 12);
  } catch (_) {
    return fallback;
  }
}

async function classifyTilesLocally(profile, modelSettings, topic, tiles) {
  const blockedItemKeys = new Set();
  const activeProfile = profilePrompt(profile, topic);
  const profileFallback = activeProfile.tags.length ? activeProfile.tags : topicWords(topic);
  if (!tiles.length) {
    return { blockedItemKeys: [], usedModel: false };
  }
  if (!modelSettings.enabled || !modelSettings.apiKey || !modelSettings.endpoint) {
    for (const tile of tiles) {
      if (heuristicIrrelevant(tile, activeProfile, topic)) {
        blockedItemKeys.add(tile.item_key);
      }
    }
    return { blockedItemKeys: [...blockedItemKeys], usedModel: false };
  }

  for (const batch of chunk(tiles, MODEL_CHUNK_SIZE)) {
    const items = batch.map(tileSummary);
    const prompt = [
      "You are a strict relevance filter for YouTube recommendations.",
      "Given a profile and a list of items, return JSON only: {\"irrelevant_keys\":[...]}.",
      "Mark an item irrelevant if it is off-topic, weakly related, clickbait, or not useful for the profile.",
      `Profile name: ${activeProfile.name}`,
      `Profile description: ${activeProfile.description || "(none)"}`,
      `Profile tags: ${profileFallback.join(", ") || "(none)"}`,
      `Items: ${JSON.stringify(items)}`,
    ].join("\n");
    try {
      const content = await callChatCompletion(modelSettings, [
        { role: "system", content: "Return valid JSON only." },
        { role: "user", content: prompt },
      ]);
      const parsed = extractJsonObject(content);
      const irrelevant = Array.isArray(parsed && parsed.irrelevant_keys) ? parsed.irrelevant_keys : [];
      const relevant = Array.isArray(parsed && parsed.relevant_keys) ? parsed.relevant_keys : [];
      for (const key of irrelevant) {
        blockedItemKeys.add(String(key || "").trim());
      }
      if (irrelevant.length === 0 && relevant.length > 0) {
        const relevantSet = new Set(relevant.map((key) => String(key || "").trim()));
        for (const item of items) {
          if (!relevantSet.has(item.item_key)) {
            blockedItemKeys.add(item.item_key);
          }
        }
      }
    } catch (_) {
      for (const tile of batch) {
        if (heuristicIrrelevant(tile, activeProfile, topic)) {
          blockedItemKeys.add(tile.item_key);
        }
      }
    }
  }

  return { blockedItemKeys: [...blockedItemKeys], usedModel: true };
}

async function postTilesToReceiver(endpoint, tiles, pageUrl, topic, profile, blockedItemKeys, blockedVideoIds) {
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tiles,
        page_url: pageUrl,
        topic,
        profile,
        blocked_item_keys: blockedItemKeys,
        blocked_video_ids: blockedVideoIds,
      }),
    });
    if (!resp.ok) {
      return { ok: false, reason: `Receiver returned ${resp.status}` };
    }
    const data = await resp.json().catch(() => ({}));
    return { ok: true, data };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function applyOverlayFn({ blockedVideoIds, blockedItemKeys }) {
  const blockedVideos = new Set((blockedVideoIds || []).filter(Boolean));
  const blockedKeys = new Set((blockedItemKeys || []).filter(Boolean));

  const normalizeUrl = (url) => {
    if (!url) return "";
    try {
      const u = new URL(url, location.origin);
      const keep = new URLSearchParams();
      for (const key of ["v", "list", "p", "q"]) {
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

  let blockedCount = 0;
  const seenHosts = new Set();
  for (const host of document.querySelectorAll(hostSelectors.join(","))) {
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    if (maybeBlockHost(host)) blockedCount += 1;
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
      for (const key of ["v", "list", "p", "q"]) {
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

  for (const sel of SELECTORS) {
    const nodes = document.querySelectorAll(sel);
    counts.by_selector[sel] = nodes.length;
    for (const el of nodes) {
      if (seenEls.has(el)) continue;
      seenEls.add(el);
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

  // Wide scan: include all visible YouTube links as content candidates.
  counts.fallback_used = true;
  const links = document.querySelectorAll("a[href]");
  counts.fallback_links = links.length;
  for (const a of links) {
    const url = (() => {
      try { return new URL(a.getAttribute("href"), location.origin).toString(); }
      catch (_) { return a.href || ""; }
    })();
    if (!url || !url.includes("youtube.com")) continue;
    const vid = videoIdFromUrl(url);
    const text = (a.getAttribute("title") || a.textContent || "").replace(/\s+/g, " ").trim();
    const itemKey = itemKeyFrom(url, vid, text);
    if (!itemKey || seenKeys.has(itemKey)) continue;

    // Find the smallest containing card-ish ancestor to read title + channel from.
    const card = a.closest(SELECTORS.join(",")) || a.parentElement || a;

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
  const settings = await loadSettings();
  const {
    endpoint = DEFAULT_ENDPOINT,
    mode = DEFAULT_MODE,
    topic = "",
    activeProfile,
    modelSettings,
  } = settings;
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
  const profile = activeProfile || buildDefaultProfile();
  const classification = await classifyTilesLocally(profile, modelSettings, topic, tiles);
  const blockedItemKeys = classification.blockedItemKeys || [];
  const blockedVideoIds = blockedItemKeys
    .filter((key) => String(key).startsWith("video:"))
    .map((key) => String(key).slice(6))
    .filter(Boolean);
  let blockedOnPage = 0;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: applyOverlayFn,
      args: [{ blockedItemKeys, blockedVideoIds }],
    });
    blockedOnPage = Number(result && result.blockedCount) || 0;
  } catch (_) {
    blockedOnPage = 0;
  }

  const receiverResult = await postTilesToReceiver(endpoint, tiles, tab.url, topic, profile, blockedItemKeys, blockedVideoIds);

  if (tiles.length === 0) {
    const breakdown = Object.entries(counts.by_selector || {}).filter(([, n]) => n > 0).map(([k, v]) => `${k}:${v}`).join(", ");
    const fb = counts.fallback_used ? ` fallback_links=${counts.fallback_links || 0}` : "";
    return {
      ok: true, sent: 0, accepted: 0, counts,
      blocked: blockedOnPage,
      profile: profile.name,
      modelUsed: classification.usedModel,
      receiver: receiverResult,
      reason: `0 tiles. selectors=[${breakdown || "none matched"}]${fb}. mode=${counts.mode} vp=${counts.viewport_h}. URL=${counts.page_url}`,
    };
  }
  const accepted = receiverResult.ok && receiverResult.data && typeof receiverResult.data.accepted === "number"
    ? receiverResult.data.accepted
    : tiles.length;
  return {
    ok: true,
    sent: tiles.length,
    accepted,
    blocked: blockedOnPage,
    counts,
    profile: profile.name,
    modelUsed: classification.usedModel,
    receiver: receiverResult,
  };
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
    } else if (msg && msg.cmd === "suggest-tags") {
      const settings = await loadSettings();
      const profile = ensureProfileShape(msg.profile || {});
      const tags = await suggestTags(profile, settings.modelSettings, settings.topic || "");
      sendResponse({ ok: true, tags });
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
