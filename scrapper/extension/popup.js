const $ = (id) => document.getElementById(id);
const setStatus = (msg) => { $("status").textContent = msg; };

function setWatchButton(on) {
  $("watch").textContent = on ? "Watch on (stop)" : "Watch off";
  $("watch").dataset.on = on ? "1" : "";
}

function describe(result) {
  if (!result) return "";
  if (!result.ok) return result.reason || "Failed.";
  const blocked = Number(result.blocked || 0);
  return `Sent ${result.sent ?? 0} tiles. New: ${result.accepted ?? 0}. Blocked on page: ${blocked}.`;
}

async function scrape() {
  setStatus("Scraping...");
  const result = await chrome.runtime.sendMessage({ cmd: "scrape" });
  setStatus(describe(result));
}

async function toggleWatch() {
  const on = $("watch").dataset.on === "1";
  if (on) {
    const r = await chrome.runtime.sendMessage({ cmd: "watch-stop" });
    setWatchButton(false);
    setStatus(r && r.ok ? "Watch stopped." : "Failed to stop watch.");
  } else {
    setStatus("Starting watch...");
    const r = await chrome.runtime.sendMessage({ cmd: "watch-start", intervalMinutes: 0.05 });
    setWatchButton(true);
    setStatus("Watch on. " + describe(r && r.immediate));
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const stored = await chrome.storage.local.get(["endpoint", "mode", "topic", "watchOn", "lastResult"]);
  if (stored.endpoint) $("endpoint").value = stored.endpoint;
  if (stored.mode) $("mode").value = stored.mode;
  if (stored.topic) $("topic").value = stored.topic;
  setWatchButton(!!stored.watchOn);
  if (stored.lastResult) setStatus(describe(stored.lastResult));

  $("endpoint").addEventListener("change", () => chrome.storage.local.set({ endpoint: $("endpoint").value }));
  $("mode").addEventListener("change", () => chrome.storage.local.set({ mode: $("mode").value }));
  $("topic").addEventListener("change", () => chrome.storage.local.set({ topic: $("topic").value }));
  $("scrape").addEventListener("click", scrape);
  $("watch").addEventListener("click", toggleWatch);
});
