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

const $ = (id) => document.getElementById(id);

const state = {
  profiles: [],
  activeProfileId: "",
  modelSettings: { ...DEFAULT_MODEL_SETTINGS },
  permissionStatus: "",
};

function uniqStrings(list) {
  return [...new Set((list || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeTag(tag) {
  return String(tag || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function splitTags(text) {
  return uniqStrings(String(text || "").split(/[,\n]/g).map(normalizeTag));
}

function makeId(prefix) {
  if (crypto && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureProfile(profile) {
  return {
    id: String(profile && profile.id ? profile.id : makeId("profile")),
    name: String(profile && profile.name ? profile.name : DEFAULT_PROFILE.name).trim() || DEFAULT_PROFILE.name,
    description: String(profile && profile.description ? profile.description : "").trim(),
    tags: uniqStrings(Array.isArray(profile && profile.tags) ? profile.tags.map(normalizeTag) : []),
    active: !!(profile && profile.active),
  };
}

function defaultProfile() {
  return ensureProfile(DEFAULT_PROFILE);
}

function getActiveProfile() {
  return state.profiles.find((profile) => profile.id === state.activeProfileId) || state.profiles[0] || defaultProfile();
}

async function loadState() {
  const stored = await chrome.storage.local.get(["profiles", "activeProfileId", "modelSettings", "endpoint", "mode", "topic"]);
  state.profiles = Array.isArray(stored.profiles) && stored.profiles.length
    ? stored.profiles.map(ensureProfile)
    : [defaultProfile()];
  state.activeProfileId = String(stored.activeProfileId || state.profiles.find((profile) => profile.active)?.id || state.profiles[0].id);
  state.modelSettings = { ...DEFAULT_MODEL_SETTINGS, ...(stored.modelSettings || {}) };
  if (stored.endpoint && !state.modelSettings.endpoint) state.modelSettings.endpoint = stored.endpoint;
  if (stored.topic && !state.profiles.some((profile) => profile.description)) {
    state.profiles[0].description = String(stored.topic).trim();
  }
  state.modelSettings.enabled = !!state.modelSettings.enabled;
  state.modelSettings.endpoint = String(state.modelSettings.endpoint || DEFAULT_MODEL_SETTINGS.endpoint);
  state.modelSettings.model = String(state.modelSettings.model || DEFAULT_MODEL_SETTINGS.model);
  state.modelSettings.apiKey = String(state.modelSettings.apiKey || "");
}

function renderPermissionStatus(text) {
  state.permissionStatus = text;
  $("permission-status").textContent = text;
}

function renderProfileSelect() {
  const select = $("profile-id");
  select.innerHTML = "";
  for (const profile of state.profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.active || profile.id === state.activeProfileId ? "* " : ""}${profile.name}`;
    if (profile.id === state.activeProfileId) option.selected = true;
    select.appendChild(option);
  }
}

function renderProfiles() {
  const list = $("profile-list");
  list.innerHTML = "";
  for (const profile of state.profiles) {
    const card = document.createElement("article");
    card.className = `profile-card${profile.id === state.activeProfileId ? " active" : ""}`;
    const header = document.createElement("header");
    const left = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = profile.name;
    const description = document.createElement("div");
    description.className = "muted";
    description.textContent = profile.description || "No description yet.";
    left.appendChild(title);
    left.appendChild(description);
    const right = document.createElement("div");
    right.className = "muted";
    right.textContent = profile.id === state.activeProfileId ? "Active" : "";
    header.appendChild(left);
    header.appendChild(right);
    card.appendChild(header);
    const tags = document.createElement("div");
    tags.className = "tag-row";
    for (const tag of profile.tags) {
      const chip = document.createElement("span");
      chip.className = "tag";
      const label = document.createElement("span");
      label.textContent = tag;
      chip.appendChild(label);
      tags.appendChild(chip);
    }
    card.appendChild(tags);
    card.addEventListener("click", () => {
      state.activeProfileId = profile.id;
      render();
      setProfileStatus(`Selected ${profile.name}.`);
    });
    list.appendChild(card);
  }
}

function renderTagRow() {
  const row = $("tag-row");
  row.innerHTML = "";
  const profile = getActiveProfile();
  for (const tag of profile.tags) {
    const chip = document.createElement("span");
    chip.className = "tag";
    chip.innerHTML = `<span>${tag}</span>`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.addEventListener("click", async (event) => {
      event.stopPropagation();
      profile.tags = profile.tags.filter((value) => value !== tag);
      await persistProfiles();
    });
    chip.appendChild(remove);
    row.appendChild(chip);
  }
}

function renderFields() {
  const profile = getActiveProfile();
  $("profile-name").value = profile.name;
  $("profile-description").value = profile.description;
  $("profile-tags").value = "";
  $("model-enabled").value = state.modelSettings.enabled ? "1" : "0";
  $("model-endpoint").value = state.modelSettings.endpoint;
  $("model-name").value = state.modelSettings.model;
  $("model-key").value = state.modelSettings.apiKey;
  $("profile-status").textContent = `${state.profiles.length} profile(s) configured. Active: ${profile.name}.`;
}

function render() {
  renderProfileSelect();
  renderProfiles();
  renderFields();
  renderTagRow();
  if (state.permissionStatus) renderPermissionStatus(state.permissionStatus);
}

async function persistProfiles() {
  const profile = getActiveProfile();
  profile.name = String($("profile-name").value || profile.name).trim() || DEFAULT_PROFILE.name;
  profile.description = String($("profile-description").value || profile.description).trim();
  await chrome.storage.local.set({ profiles: state.profiles, activeProfileId: state.activeProfileId });
  render();
}

async function persistModelSettings() {
  state.modelSettings.enabled = $("model-enabled").value === "1";
  state.modelSettings.endpoint = String($("model-endpoint").value || DEFAULT_MODEL_SETTINGS.endpoint).trim();
  state.modelSettings.model = String($("model-name").value || DEFAULT_MODEL_SETTINGS.model).trim();
  state.modelSettings.apiKey = String($("model-key").value || "");
  await chrome.storage.local.set({
    modelSettings: state.modelSettings,
  });
  renderPermissionStatus(`Saved model settings for ${state.modelSettings.endpoint}.`);
}

function setProfileStatus(message) {
  $("profile-status").textContent = message;
}

async function requestEndpointPermission() {
  const endpoint = String($("model-endpoint").value || DEFAULT_MODEL_SETTINGS.endpoint).trim();
  try {
    const origin = new URL(endpoint).origin;
    const pattern = `${origin}/*`;
    const granted = await chrome.permissions.contains({ origins: [pattern] });
    if (granted) {
      renderPermissionStatus(`Permission already granted for ${pattern}.`);
      return;
    }
    const ok = await chrome.permissions.request({ origins: [pattern] });
    renderPermissionStatus(ok ? `Permission granted for ${pattern}.` : `Permission not granted for ${pattern}.`);
  } catch (error) {
    renderPermissionStatus(`Invalid endpoint URL: ${error.message}`);
  }
}

async function createProfile() {
  const name = String($("profile-name").value || "").trim();
  const description = String($("profile-description").value || "").trim();
  const tags = splitTags($("profile-tags").value);
  const profile = ensureProfile({ id: makeId("profile"), name: name || DEFAULT_PROFILE.name, description, tags, active: false });
  state.profiles.push(profile);
  state.activeProfileId = profile.id;
  await chrome.storage.local.set({ profiles: state.profiles, activeProfileId: state.activeProfileId });
  setProfileStatus(`Created ${profile.name}.`);
  render();
}

async function deleteProfile() {
  if (state.profiles.length <= 1) {
    setProfileStatus("Keep at least one profile.");
    return;
  }
  const profile = getActiveProfile();
  state.profiles = state.profiles.filter((item) => item.id !== profile.id);
  state.activeProfileId = state.profiles[0].id;
  await chrome.storage.local.set({ profiles: state.profiles, activeProfileId: state.activeProfileId });
  setProfileStatus(`Deleted ${profile.name}.`);
  render();
}

async function setActiveProfile() {
  const profile = state.profiles.find((item) => item.id === $("profile-id").value) || getActiveProfile();
  state.activeProfileId = profile.id;
  await chrome.storage.local.set({ profiles: state.profiles, activeProfileId: state.activeProfileId });
  setProfileStatus(`${profile.name} is now active.`);
  render();
}

async function addTag() {
  const profile = getActiveProfile();
  const tags = splitTags($("tag-input").value);
  if (tags.length === 0) return;
  profile.tags = uniqStrings([...(profile.tags || []), ...tags]);
  $("tag-input").value = "";
  await persistProfiles();
}

async function suggestTags() {
  const profile = getActiveProfile();
  setProfileStatus("Suggesting tags from the model...");
  const response = await chrome.runtime.sendMessage({ cmd: "suggest-tags", profile, topic: profile.description || profile.name });
  if (!response || !response.ok) {
    setProfileStatus((response && response.reason) || "Tag suggestion failed.");
    return;
  }
  profile.tags = uniqStrings([...(profile.tags || []), ...(response.tags || [])]);
  await persistProfiles();
  setProfileStatus(`Added ${response.tags.length} suggested tag(s).`);
}

async function saveAll() {
  await persistModelSettings();
  await persistProfiles();
  setProfileStatus(`Saved settings for ${getActiveProfile().name}.`);
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadState();
  render();

  $("profile-name").addEventListener("change", persistProfiles);
  $("profile-description").addEventListener("change", persistProfiles);
  $("profile-id").addEventListener("change", async (event) => {
    state.activeProfileId = String(event.target.value || state.activeProfileId);
    await chrome.storage.local.set({ activeProfileId: state.activeProfileId });
    render();
  });
  $("model-enabled").addEventListener("change", persistModelSettings);
  $("model-endpoint").addEventListener("change", persistModelSettings);
  $("model-name").addEventListener("change", persistModelSettings);
  $("model-key").addEventListener("change", persistModelSettings);
  $("create-profile").addEventListener("click", createProfile);
  $("delete-profile").addEventListener("click", deleteProfile);
  $("set-active").addEventListener("click", setActiveProfile);
  $("add-tag").addEventListener("click", addTag);
  $("suggest-tags").addEventListener("click", suggestTags);
  $("save-model").addEventListener("click", persistModelSettings);
  $("allow-endpoint").addEventListener("click", requestEndpointPermission);
  $("save-all").addEventListener("click", saveAll);
  $("open-popup").addEventListener("click", () => chrome.action.openPopup());
});