const TOKEN_KEY = "multiweb-token";
const THEME_KEY = "multiweb-theme";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  baseDomain: "",
  sites: [],
  selectedFile: null,
  filter: "",
  settingsName: null,
  settingsDomains: [],
};

function fmtSize(b) {
  if (b < 1024) return `${b} o`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} ko`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} Mo`;
  return `${(b / 1024 ** 3).toFixed(1)} Go`;
}

function fmtRelative(ts) {
  const d = Date.now() - ts;
  const min = 60_000, h = 60 * min, day = 24 * h;
  if (d < min) return "à l'instant";
  if (d < h) return `il y a ${Math.floor(d / min)} min`;
  if (d < day) return `il y a ${Math.floor(d / h)} h`;
  return `il y a ${Math.floor(d / day)} j`;
}

function slugify(s) {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401) {
    state.token = null;
    localStorage.removeItem(TOKEN_KEY);
    showLogin();
    throw new Error(data.error || "Session expirée");
  }
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

function getTheme() {
  return (
    localStorage.getItem(THEME_KEY) ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  );
}
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(THEME_KEY, t);
}
function toggleTheme() {
  setTheme(getTheme() === "dark" ? "light" : "dark");
}

function toast(label, msg, kind = "info") {
  const host = $("#toast-host");
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.innerHTML = `<div class="toast__label">${escape(label)}</div><div class="toast__msg">${escape(msg)}</div>`;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 220);
  }, 4200);
}

function confirmModal({ title, body, okLabel = "Confirmer" }) {
  return new Promise((resolve) => {
    const dialog = $("#confirm-dialog");
    $("#confirm-title").textContent = title;
    $("#confirm-body").innerHTML = body;
    $("#confirm-ok").textContent = okLabel;
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      resolve(dialog.returnValue === "ok");
    };
    dialog.addEventListener("close", onClose);
    dialog.showModal();
  });
}

function showLogin() {
  $("#login-screen").hidden = false;
  $("#dashboard-screen").hidden = true;
  setTimeout(() => $("#login-form input[name=password]")?.focus(), 30);
}

async function showDashboard() {
  const me = await api("/api/me");
  state.baseDomain = me.baseDomain;
  $("#login-screen").hidden = true;
  $("#dashboard-screen").hidden = false;
  $("#meta-domain").textContent = me.baseDomain;
  $("#stat-domain").textContent = me.baseDomain;
  $("#domain-suffix").textContent = `.${me.baseDomain}`;
  $("#domain-pill").textContent = me.baseDomain;
  await refreshSites();
}

async function login(password) {
  const data = await api("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  state.token = data.token;
  localStorage.setItem(TOKEN_KEY, state.token);
  await showDashboard();
}

function logout() {
  state.token = null;
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
}

function filterSites(sites, q) {
  const term = (q || "").trim().toLowerCase();
  if (!term) return sites;
  return sites.filter((s) => {
    if (s.name && s.name.toLowerCase().includes(term)) return true;
    if (s.title && s.title.toLowerCase().includes(term)) return true;
    if (Array.isArray(s.customDomains) &&
        s.customDomains.some((d) => d && d.toLowerCase().includes(term))) return true;
    return false;
  });
}

function renderSites() {
  const sites = state.sites;
  const filtered = filterSites(sites, state.filter);

  $("#stat-count").textContent = String(sites.length);
  const total = sites.reduce((a, s) => a + s.size, 0);
  $("#stat-size").textContent = fmtSize(total);

  const countEl = $("#sites-count");
  if (state.filter && sites.length) {
    countEl.textContent = `${filtered.length} / ${sites.length}`;
  } else {
    countEl.textContent = `${sites.length} entrée${sites.length > 1 ? "s" : ""}`;
  }

  const filterWrap = document.querySelector(".sites-section__filter");
  if (filterWrap) filterWrap.style.display = sites.length === 0 ? "none" : "";

  const list = $("#sites-list");
  list.innerHTML = "";

  if (sites.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty__icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7l9-4 9 4M3 7v10l9 4 9-4V7M3 7l9 4 9-4M12 11v10"/>
          </svg>
        </div>
        <div class="empty__title">Aucun site publié</div>
        <div class="empty__sub">Déposez une archive .zip ci-dessus pour commencer.</div>
      </div>`;
    return;
  }

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty__icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
          </svg>
        </div>
        <div class="empty__title">Aucun site ne correspond.</div>
        <div class="empty__sub">Essayez un autre terme de recherche.</div>
      </div>`;
    return;
  }

  filtered.forEach((site, i) => {
    const el = document.createElement("article");
    el.className = "site fade-in";
    el.style.animationDelay = `${i * 0.04}s`;
    el.dataset.name = site.name;

    const titleHtml = site.title && site.title.trim()
      ? `<div class="site__title">${escape(site.title)}</div>`
      : "";

    el.innerHTML = `
      <div class="site__body">
        <div class="site__row">
          <span class="site__name">${escape(site.name)}</span>
          <span class="site__pill site__pill--live">live</span>
        </div>
        ${titleHtml}
        <div class="site__url-row">
          <a class="site__url" href="${escape(site.url)}" target="_blank" rel="noopener">${escape(site.url)} ↗</a>
          <button class="icon-btn" data-action="copy" data-url="${escape(site.url)}" title="Copier l'URL" aria-label="Copier l'URL">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="11" height="11" rx="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
        </div>
        <div class="site__meta">
          <span>${fmtSize(site.size)}</span>
          <span class="site__meta-sep">·</span>
          <span>${fmtRelative(site.updatedAt)}</span>
        </div>
      </div>
      <div class="site__actions">
        <button class="icon-btn" data-action="settings" data-name="${escape(site.name)}" title="Paramètres" aria-label="Paramètres">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>
          </svg>
        </button>
        <button class="btn btn--ghost btn--sm" data-action="delete" data-name="${escape(site.name)}">Supprimer</button>
      </div>`;
    list.appendChild(el);
  });
}

async function refreshSites() {
  const sites = await api("/api/sites");
  state.sites = sites;
  renderSites();
}

async function deleteSite(name) {
  const ok = await confirmModal({
    title: "Supprimer ce site ?",
    body: `Le site <code>${escape(name)}</code> sera retiré du serveur ainsi que sa configuration HTTPS. Cette action est définitive.`,
    okLabel: "Supprimer",
  });
  if (!ok) return;
  try {
    await api(`/api/sites/${encodeURIComponent(name)}`, { method: "DELETE" });
    toast("Retiré", `« ${name} » a été supprimé.`, "ok");
    await refreshSites();
  } catch (err) {
    toast("Erreur", err.message, "err");
  }
}

async function deploy(name, file) {
  const form = new FormData();
  form.append("name", name);
  form.append("file", file);
  const res = await fetch("/api/sites", {
    method: "POST",
    headers: { authorization: `Bearer ${state.token}` },
    body: form,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

async function copySiteUrl(btn, url) {
  try {
    await navigator.clipboard.writeText(url);
    const original = btn.innerHTML;
    btn.classList.add("is-ok");
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>`;
    setTimeout(() => {
      btn.classList.remove("is-ok");
      btn.innerHTML = original;
    }, 1200);
    toast("Copié", "URL copiée", "ok");
  } catch (err) {
    toast("Erreur", "Impossible de copier l'URL.", "err");
  }
}

function isZipFile(file) {
  if (!file) return false;
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".zip")) return true;
  return file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

function setSiteUploading(siteEl, on) {
  if (!siteEl) return;
  const existing = siteEl.querySelector(".site__overlay");
  if (on) {
    siteEl.classList.add("is-uploading");
    if (!existing) {
      const overlay = document.createElement("div");
      overlay.className = "site__overlay";
      overlay.innerHTML = `<span class="spinner"></span><span>Redéploiement…</span>`;
      siteEl.appendChild(overlay);
    }
  } else {
    siteEl.classList.remove("is-uploading");
    if (existing) existing.remove();
  }
}

async function redeploySite(siteEl, name, file) {
  if (!isZipFile(file)) {
    toast("Refusé", "Seules les archives .zip sont acceptées.", "err");
    return;
  }
  setSiteUploading(siteEl, true);
  try {
    await deploy(name, file);
    toast("Redéployé", `« ${name} » a été mis à jour.`, "ok");
    await refreshSites();
  } catch (err) {
    toast("Erreur", err.message, "err");
    setSiteUploading(siteEl, false);
  }
}

/* ============ SETTINGS MODAL ============ */

function getSiteByName(name) {
  return state.sites.find((s) => s.name === name);
}

function resetSettingsState() {
  state.settingsName = null;
  state.settingsDomains = [];
  $("#settings-auth-toggle").checked = false;
  $("#settings-auth-fields").hidden = true;
  $("#settings-auth-user").value = "admin";
  $("#settings-auth-pass").value = "";
  $("#settings-auth-clear").hidden = true;
  $("#settings-domain-input").value = "";
  $("#settings-domains-list").innerHTML = "";
}

function renderSettingsDomains() {
  const ul = $("#settings-domains-list");
  ul.innerHTML = "";
  if (!state.settingsDomains.length) {
    const li = document.createElement("li");
    li.className = "settings__domains-empty";
    li.textContent = "Aucun domaine personnalisé.";
    ul.appendChild(li);
    return;
  }
  state.settingsDomains.forEach((d, idx) => {
    const li = document.createElement("li");
    li.className = "settings__domain";
    li.innerHTML = `
      <span>${escape(d)}</span>
      <button type="button" class="settings__domain-remove" data-idx="${idx}" aria-label="Retirer">×</button>`;
    ul.appendChild(li);
  });
}

function openSettingsModal(name) {
  const site = getSiteByName(name);
  if (!site) return;
  resetSettingsState();
  state.settingsName = name;
  state.settingsDomains = Array.isArray(site.customDomains) ? [...site.customDomains] : [];

  $("#settings-title").textContent = `Paramètres — ${name}`;
  $("#settings-sub").textContent = site.url || "";

  $("#settings-rename-input").value = name;
  $("#settings-rename-suffix").textContent = `.${state.baseDomain}`;

  const hasAuth = !!(site.auth && site.auth.user);
  $("#settings-auth-toggle").checked = hasAuth;
  $("#settings-auth-fields").hidden = !hasAuth;
  $("#settings-auth-user").value = hasAuth ? site.auth.user : "admin";
  $("#settings-auth-pass").value = "";
  $("#settings-auth-pass").placeholder = hasAuth ? "•••••••• (laisser vide pour conserver)" : "••••••••";
  $("#settings-auth-clear").hidden = !hasAuth;

  renderSettingsDomains();
  $("#settings-dialog").showModal();
}

function closeSettingsModal() {
  const dlg = $("#settings-dialog");
  if (dlg.open) dlg.close();
  resetSettingsState();
}

async function submitRename(e) {
  e.preventDefault();
  if (!state.settingsName) return;
  const oldName = state.settingsName;
  const newName = $("#settings-rename-input").value.toLowerCase().trim();
  if (!newName || newName === oldName) return;
  const btn = $("#settings-rename-btn");
  setBtnLoading(btn, true, "Renommage…");
  try {
    const res = await api(`/api/sites/${encodeURIComponent(oldName)}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    toast("Renommé", `« ${oldName} » → « ${res.name || newName} ».`, "ok");
    state.settingsName = res.name || newName;
    await refreshSites();
    const updated = getSiteByName(state.settingsName);
    if (updated) {
      $("#settings-title").textContent = `Paramètres — ${updated.name}`;
      $("#settings-sub").textContent = updated.url || "";
    }
  } catch (err) {
    toast("Erreur", err.message, "err");
  } finally {
    setBtnLoading(btn, false);
  }
}

async function submitAuth(e) {
  e.preventDefault();
  if (!state.settingsName) return;
  const user = $("#settings-auth-user").value.trim();
  const pass = $("#settings-auth-pass").value;
  if (!user) {
    toast("Manquant", "Renseignez un identifiant.", "err");
    return;
  }
  if (!pass) {
    toast("Manquant", "Renseignez un mot de passe.", "err");
    return;
  }
  const btn = $("#settings-auth-save");
  setBtnLoading(btn, true, "Enregistrement…");
  try {
    await api(`/api/sites/${encodeURIComponent(state.settingsName)}/auth`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, password: pass }),
    });
    toast("Protégé", "Authentification activée.", "ok");
    $("#settings-auth-pass").value = "";
    $("#settings-auth-clear").hidden = false;
    await refreshSites();
  } catch (err) {
    toast("Erreur", err.message, "err");
  } finally {
    setBtnLoading(btn, false);
  }
}

async function clearAuth() {
  if (!state.settingsName) return;
  const btn = $("#settings-auth-clear");
  btn.disabled = true;
  try {
    await api(`/api/sites/${encodeURIComponent(state.settingsName)}/auth`, {
      method: "DELETE",
    });
    toast("Retiré", "Protection supprimée.", "ok");
    $("#settings-auth-toggle").checked = false;
    $("#settings-auth-fields").hidden = true;
    $("#settings-auth-pass").value = "";
    $("#settings-auth-clear").hidden = true;
    await refreshSites();
  } catch (err) {
    toast("Erreur", err.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function saveDomains() {
  if (!state.settingsName) return;
  try {
    await api(`/api/sites/${encodeURIComponent(state.settingsName)}/domains`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domains: state.settingsDomains }),
    });
    await refreshSites();
    return true;
  } catch (err) {
    toast("Erreur", err.message, "err");
    return false;
  }
}

async function addDomain(e) {
  e.preventDefault();
  if (!state.settingsName) return;
  const input = $("#settings-domain-input");
  const val = input.value.trim().toLowerCase();
  if (!val) return;
  if (state.settingsDomains.includes(val)) {
    toast("Déjà présent", "Ce domaine est déjà dans la liste.", "err");
    return;
  }
  const prev = [...state.settingsDomains];
  state.settingsDomains.push(val);
  renderSettingsDomains();
  input.value = "";
  const ok = await saveDomains();
  if (ok) {
    toast("Ajouté", `${val} configuré.`, "ok");
  } else {
    state.settingsDomains = prev;
    renderSettingsDomains();
  }
}

async function removeDomain(idx) {
  if (!state.settingsName) return;
  const prev = [...state.settingsDomains];
  const removed = state.settingsDomains[idx];
  state.settingsDomains.splice(idx, 1);
  renderSettingsDomains();
  const ok = await saveDomains();
  if (ok) {
    toast("Retiré", `${removed} a été retiré.`, "ok");
  } else {
    state.settingsDomains = prev;
    renderSettingsDomains();
  }
}

function setSelectedFile(file) {
  state.selectedFile = file;
  const dz = $("#dropzone");
  const hint = $("#dropzone-hint");
  const sub = $("#dropzone-sub");
  if (file) {
    hint.textContent = file.name;
    sub.textContent = fmtSize(file.size);
    dz.classList.add("has-file");
    if (!$("#site-name").value) {
      $("#site-name").value = slugify(file.name.replace(/\.zip$/i, ""));
    }
  } else {
    hint.textContent = "Glissez un fichier .zip";
    sub.textContent = "Ou cliquez pour parcourir";
    dz.classList.remove("has-file");
  }
}

function setBtnLoading(btn, loading, label) {
  const labelEl = btn.querySelector(".btn__label");
  const iconEl = btn.querySelector(".btn__icon");
  if (loading) {
    btn.disabled = true;
    btn.dataset.label = labelEl.textContent;
    labelEl.innerHTML = `<span class="spinner"></span>${label || labelEl.textContent}`;
    if (iconEl) iconEl.style.opacity = "0";
  } else {
    btn.disabled = false;
    labelEl.textContent = btn.dataset.label || label || "";
    if (iconEl) iconEl.style.opacity = "";
  }
}

function bind() {
  $$("[data-theme-toggle]").forEach((b) => b.addEventListener("click", toggleTheme));

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pwd = e.target.password.value;
    const btn = e.target.querySelector("button[type=submit]");
    setBtnLoading(btn, true, "Vérification…");
    try {
      await login(pwd);
      e.target.reset();
    } catch (err) {
      toast("Refusé", err.message, "err");
    } finally {
      setBtnLoading(btn, false);
    }
  });

  $("#logout-btn").addEventListener("click", logout);

  const dz = $("#dropzone");
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("is-dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === "dragleave" && e.target !== dz) return;
      dz.classList.remove("is-dragover");
    })
  );
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) setSelectedFile(f);
  });
  $("#file-input").addEventListener("change", (e) => {
    setSelectedFile(e.target.files[0] || null);
  });

  $("#deploy-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#site-name").value.toLowerCase().trim();
    const file = state.selectedFile;
    if (!file) {
      toast("Manquant", "Choisissez d'abord une archive .zip.", "err");
      return;
    }
    const btn = $("#deploy-btn");
    setBtnLoading(btn, true, "Publication…");
    try {
      const data = await deploy(name, file);
      toast("Publié", `En ligne : ${data.url}`, "ok");
      $("#deploy-form").reset();
      setSelectedFile(null);
      await refreshSites();
    } catch (err) {
      toast("Erreur", err.message, "err");
    } finally {
      setBtnLoading(btn, false);
    }
  });

  $("#sites-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "delete") {
      await deleteSite(btn.dataset.name);
    } else if (action === "copy") {
      await copySiteUrl(btn, btn.dataset.url);
    } else if (action === "settings") {
      openSettingsModal(btn.dataset.name);
    }
  });

  /* ---- search filter ---- */
  $("#sites-filter").addEventListener("input", (e) => {
    state.filter = e.target.value;
    renderSites();
  });

  /* ---- per-card drop ---- */
  const sitesList = $("#sites-list");
  let dragDepth = 0;
  let activeCard = null;

  const isFileDrag = (e) => {
    const types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) if (types[i] === "Files") return true;
    return false;
  };

  sitesList.addEventListener("dragenter", (e) => {
    if (!isFileDrag(e)) return;
    const card = e.target.closest(".site");
    if (!card || card.classList.contains("is-uploading")) return;
    e.preventDefault();
    dragDepth++;
    if (activeCard && activeCard !== card) activeCard.classList.remove("is-dragover");
    activeCard = card;
    card.classList.add("is-dragover");
  });

  sitesList.addEventListener("dragover", (e) => {
    if (!isFileDrag(e)) return;
    const card = e.target.closest(".site");
    if (!card) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });

  sitesList.addEventListener("dragleave", (e) => {
    if (!isFileDrag(e)) return;
    const card = e.target.closest(".site");
    if (!card) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && activeCard) {
      activeCard.classList.remove("is-dragover");
      activeCard = null;
    }
  });

  sitesList.addEventListener("drop", async (e) => {
    const card = e.target.closest(".site");
    if (!card) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    card.classList.remove("is-dragover");
    activeCard = null;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const name = card.dataset.name;
    if (!name) return;
    await redeploySite(card, name, file);
  });

  // Prevent the page from navigating when files are dropped outside
  // the dedicated dropzones (e.g. between cards).
  window.addEventListener("dragover", (e) => {
    if (isFileDrag(e)) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    const inDropzone = e.target.closest("#dropzone");
    const inCard = e.target.closest(".site");
    if (!inDropzone && !inCard && isFileDrag(e)) e.preventDefault();
  });

  /* ---- settings modal ---- */
  const settingsDialog = $("#settings-dialog");
  $("#settings-close").addEventListener("click", () => closeSettingsModal());
  settingsDialog.addEventListener("close", () => resetSettingsState());
  settingsDialog.addEventListener("click", (e) => {
    // Click on backdrop closes the dialog
    if (e.target === settingsDialog) closeSettingsModal();
  });

  $("#settings-rename-form").addEventListener("submit", submitRename);
  $("#settings-rename-input").addEventListener("input", (e) => {
    e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
  });

  $("#settings-auth-toggle").addEventListener("change", (e) => {
    const on = e.target.checked;
    const fields = $("#settings-auth-fields");
    fields.hidden = !on;
    if (on) {
      const site = getSiteByName(state.settingsName);
      const hasAuth = !!(site && site.auth && site.auth.user);
      if (!hasAuth) {
        $("#settings-auth-user").value = $("#settings-auth-user").value || "admin";
        $("#settings-auth-pass").focus();
      }
    }
  });

  $("#settings-auth-form").addEventListener("submit", submitAuth);
  $("#settings-auth-clear").addEventListener("click", clearAuth);

  $("#settings-domain-form").addEventListener("submit", addDomain);
  $("#settings-domains-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".settings__domain-remove");
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    if (!Number.isNaN(idx)) removeDomain(idx);
  });

  $("#site-name").addEventListener("input", (e) => {
    e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
  });

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!localStorage.getItem(THEME_KEY)) setTheme(e.matches ? "dark" : "light");
  });
}

async function init() {
  bind();
  if (state.token) {
    try { await showDashboard(); }
    catch { logout(); }
  } else {
    showLogin();
  }
}

init();
