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
  const profile = result.profile ? ` Profile: ${result.profile}.` : "";
  const model = result.modelUsed ? " Model on." : " Heuristic only.";
  return `Sent ${result.sent ?? 0} tiles. New: ${result.accepted ?? 0}. Blocked on page: ${blocked}.${profile}${model}`;
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
  const stored = await chrome.storage.local.get(["endpoint", "mode", "topic", "watchOn", "lastResult", "activeProfileId", "profiles"]);
  if (stored.endpoint) $("endpoint").value = stored.endpoint;
  if (stored.mode) $("mode").value = stored.mode;
  if (stored.topic) $("topic").value = stored.topic;
  setWatchButton(!!stored.watchOn);
  if (stored.lastResult) setStatus(describe(stored.lastResult));

  const profiles = Array.isArray(stored.profiles) ? stored.profiles : [];
  const activeProfile = profiles.find((profile) => profile.id === stored.activeProfileId) || profiles.find((profile) => profile.active) || profiles[0];
  if (activeProfile) {
    const summary = $("profileSummary");
    summary.textContent = "";
    const name = document.createElement("strong");
    name.textContent = activeProfile.name;
    const tags = document.createElement("span");
    tags.textContent = activeProfile.tags && activeProfile.tags.length ? activeProfile.tags.join(", ") : "No tags yet.";
    summary.appendChild(name);
    summary.appendChild(tags);
    setStatus(`${activeProfile.name}. ${stored.lastResult ? describe(stored.lastResult) : "Ready."}`);
  } else {
    const summary = $("profileSummary");
    summary.textContent = "";
    const name = document.createElement("strong");
    name.textContent = "No profile configured";
    const tags = document.createElement("span");
    tags.textContent = "Create one in settings.";
    summary.appendChild(name);
    summary.appendChild(tags);
  }

  $("endpoint").addEventListener("change", () => chrome.storage.local.set({ endpoint: $("endpoint").value }));
  $("mode").addEventListener("change", () => chrome.storage.local.set({ mode: $("mode").value }));
  $("topic").addEventListener("change", () => chrome.storage.local.set({ topic: $("topic").value }));
  $("scrape").addEventListener("click", scrape);
  $("watch").addEventListener("click", toggleWatch);
  $("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
});
