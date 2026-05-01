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
  detailName: null,
  detailDomains: [],
  detailFile: null,
  domains: [],
  selectedDeployDomain: "",
  tokens: [],
  noteDebounce: null,
  noteSaving: false,
  noteLastSaved: "",
  noteSavedTimer: null,
};

/* ============ UTILS ============ */

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

function fmtRelativeDays(ts) {
  if (!ts) return "—";
  const d = Date.now() - ts;
  const day = 24 * 60 * 60 * 1000;
  const days = Math.floor(d / day);
  if (days <= 0) return "aujourd'hui";
  return `il y a ${days}j`;
}

function originFromUrl(url) {
  try { return new URL(url).origin; } catch { return ""; }
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

/* ============ THEME ============ */

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

/* ============ TOAST + CONFIRM ============ */

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

/* ============ ROUTING ============ */

const SCREENS = ["login-screen", "dashboard-screen", "site-screen", "domains-screen", "tokens-screen"];

function showScreen(id) {
  for (const s of SCREENS) $("#" + s).hidden = s !== id;
}

function parseRoute() {
  if (location.hash === "#/domains" || location.hash === "#/domains/") {
    return { view: "domains" };
  }
  if (location.hash === "#/tokens" || location.hash === "#/tokens/") {
    return { view: "tokens" };
  }
  const m = location.hash.match(/^#\/site\/([a-z0-9-]+)\/?$/);
  if (m) return { view: "site", name: m[1] };
  return { view: "dashboard" };
}

async function route() {
  if (!state.token) {
    showLogin();
    return;
  }
  if (!state.baseDomain) {
    try {
      const me = await api("/api/me");
      state.baseDomain = me.baseDomain;
      applyBaseDomain(me.baseDomain);
    } catch {
      logout();
      return;
    }
  }
  const r = parseRoute();
  try {
    await refreshSites();
  } catch (err) {
    toast("Erreur", err.message || "Chargement impossible", "err");
    return;
  }
  if (r.view === "site") {
    showSiteDetail(r.name);
  } else if (r.view === "domains") {
    await showDomainsPage();
  } else if (r.view === "tokens") {
    await showTokensPage();
  } else {
    showScreen("dashboard-screen");
    await refreshDomainsForDeploy();
  }
}

function navigateHome() {
  if (location.hash !== "" && location.hash !== "#/") location.hash = "#/";
  else route();
}
function navigateSite(name) {
  const next = `#/site/${encodeURIComponent(name)}`;
  if (location.hash !== next) location.hash = next;
  else route();
}

/* ============ AUTH FLOW ============ */

function applyBaseDomain(domain) {
  $("#meta-domain").textContent = domain;
  $("#stat-domain").textContent = domain;
  $("#domain-suffix").textContent = `.${domain}`;
  $("#domain-pill").textContent = domain;
  $("#sd-rename-suffix").textContent = `.${domain}`;
}

function showLogin() {
  showScreen("login-screen");
  setTimeout(() => $("#login-form input[name=password]")?.focus(), 30);
}

async function login(password) {
  const data = await api("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  state.token = data.token;
  localStorage.setItem(TOKEN_KEY, state.token);
  state.baseDomain = "";
  await route();
}

function logout() {
  state.token = null;
  state.baseDomain = "";
  localStorage.removeItem(TOKEN_KEY);
  if (location.hash) {
    location.hash = "";
    return;
  }
  showLogin();
}

/* ============ SITES LIST ============ */

function getSiteByName(name) {
  return state.sites.find((s) => s.name === name);
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
    el.className = "site site--clickable fade-in";
    el.style.animationDelay = `${i * 0.04}s`;
    el.dataset.name = site.name;
    el.tabIndex = 0;
    el.setAttribute("role", "link");

    const titleHtml = site.title && site.title.trim()
      ? `<div class="site__title">${escape(site.title)}</div>`
      : "";
    const authPill = site.auth && site.auth.user
      ? `<span class="site__pill site__pill--protected" title="Protégé par mot de passe">🔒</span>`
      : "";
    const domainsCount = Array.isArray(site.customDomains) ? site.customDomains.length : 0;
    const domainsPill = domainsCount > 0
      ? `<span class="site__pill" title="Domaines personnalisés">+${domainsCount} domaine${domainsCount > 1 ? "s" : ""}</span>`
      : "";

    const origin = originFromUrl(site.url);
    const faviconHtml = origin
      ? `<img class="site__favicon" src="${escape(origin)}/favicon.ico" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.style.visibility='hidden';">`
      : `<span class="site__favicon" aria-hidden="true"></span>`;

    el.innerHTML = `
      ${faviconHtml}
      <div class="site__body">
        <div class="site__row">
          <span class="site__name">${escape(site.name)}</span>
          <span class="site__pill site__pill--live">live</span>
          ${authPill}
          ${domainsPill}
        </div>
        ${titleHtml}
        <div class="site__url-row">
          <a class="site__url" href="${escape(site.url)}" target="_blank" rel="noopener" data-stop>${escape(site.url)} ↗</a>
          <button class="icon-btn" data-action="copy" data-url="${escape(site.url)}" data-stop title="Copier l'URL" aria-label="Copier l'URL">
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
        <span class="site__chevron" aria-hidden="true">→</span>
      </div>`;
    list.appendChild(el);
  });
}

async function refreshSites() {
  const sites = await api("/api/sites");
  state.sites = sites;
  renderSites();
  if (state.detailName) {
    const site = getSiteByName(state.detailName);
    if (site && !$("#site-screen").hidden) populateSiteDetail(site);
  }
}

/* ============ DEPLOY (NEW SITE) ============ */

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

/* ============ COPY URL ============ */

async function copyUrl(btn, url) {
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
  } catch {
    toast("Erreur", "Impossible de copier l'URL.", "err");
  }
}

/* ============ SITE DETAIL ============ */

function isZipFile(file) {
  if (!file) return false;
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".zip")) return true;
  return file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

function showSiteDetail(name) {
  const site = getSiteByName(name);
  if (!site) {
    toast("Introuvable", `Aucun site nommé « ${name} ».`, "err");
    location.hash = "#/";
    return;
  }
  showScreen("site-screen");
  populateSiteDetail(site);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function populateSiteDetail(site) {
  state.detailName = site.name;
  state.detailDomains = Array.isArray(site.customDomains) ? [...site.customDomains] : [];
  state.detailFile = null;

  $("#sd-breadcrumb").textContent = site.name;
  $("#sd-name").textContent = site.name;
  if (site.title && site.title.trim()) {
    $("#sd-title").textContent = site.title;
    $("#sd-title").hidden = false;
  } else {
    $("#sd-title").hidden = true;
    $("#sd-title").textContent = "";
  }
  $("#sd-url").textContent = site.url;
  $("#sd-url").href = site.url;
  $("#sd-copy").dataset.url = site.url;
  $("#sd-size").textContent = fmtSize(site.size);
  $("#sd-deployed").textContent = fmtRelative(site.updatedAt);

  const hasAuth = !!(site.auth && site.auth.user);
  $("#sd-auth-pill").hidden = !hasAuth;

  $("#sd-rename-input").value = site.name;
  $("#sd-rename-suffix").textContent = `.${state.baseDomain}`;

  $("#sd-auth-toggle").checked = hasAuth;
  $("#sd-auth-fields").hidden = !hasAuth;
  $("#sd-auth-user").value = hasAuth ? site.auth.user : "admin";
  $("#sd-auth-pass").value = "";
  $("#sd-auth-pass").placeholder = hasAuth ? "•••••••• (laisser vide pour conserver)" : "••••••••";
  $("#sd-auth-clear").hidden = !hasAuth;

  renderDetailDomains();

  // Load note
  const noteEl = $("#sd-note");
  if (noteEl) {
    const note = typeof site.note === "string" ? site.note : "";
    noteEl.value = note;
    state.noteLastSaved = note;
    if (state.noteDebounce) {
      clearTimeout(state.noteDebounce);
      state.noteDebounce = null;
    }
    hideNoteSavedIndicator();
  }

  const frame = $("#sd-preview-frame");
  if (frame.dataset.src !== site.url) {
    frame.dataset.src = site.url;
    frame.src = site.url;
  }
  $("#sd-preview-open").href = site.url;

  resetDetailDropzone();
}

function resetDetailDropzone() {
  state.detailFile = null;
  const dz = $("#sd-dropzone");
  $("#sd-dropzone-hint").textContent = "Glissez la nouvelle version .zip";
  $("#sd-dropzone-sub").textContent = "Ou cliquez pour parcourir";
  dz.classList.remove("has-file", "is-uploading", "is-dragover");
  const overlay = dz.querySelector(".dropzone__overlay");
  if (overlay) overlay.remove();
  const input = $("#sd-file-input");
  if (input) input.value = "";
}

function setDetailRedeploying(on) {
  const dz = $("#sd-dropzone");
  if (on) {
    dz.classList.add("is-uploading");
    if (!dz.querySelector(".dropzone__overlay")) {
      const overlay = document.createElement("div");
      overlay.className = "dropzone__overlay";
      overlay.innerHTML = `<span class="spinner"></span><span>Redéploiement…</span>`;
      dz.appendChild(overlay);
    }
  } else {
    dz.classList.remove("is-uploading");
    const overlay = dz.querySelector(".dropzone__overlay");
    if (overlay) overlay.remove();
  }
}

function renderDetailDomains() {
  const ul = $("#sd-domains-list");
  ul.innerHTML = "";
  if (!state.detailDomains.length) {
    const li = document.createElement("li");
    li.className = "settings__domains-empty";
    li.textContent = "Aucun domaine personnalisé.";
    ul.appendChild(li);
    return;
  }
  state.detailDomains.forEach((d, idx) => {
    const li = document.createElement("li");
    li.className = "settings__domain";
    li.innerHTML = `
      <span>${escape(d)}</span>
      <button type="button" class="settings__domain-remove" data-idx="${idx}" aria-label="Retirer">×</button>`;
    ul.appendChild(li);
  });
}

async function redeploySite(file) {
  if (!state.detailName) return;
  if (!isZipFile(file)) {
    toast("Refusé", "Seules les archives .zip sont acceptées.", "err");
    return;
  }
  setDetailRedeploying(true);
  try {
    await deploy(state.detailName, file);
    toast("Redéployé", `« ${state.detailName} » a été mis à jour.`, "ok");
    await refreshSites();
    const frame = $("#sd-preview-frame");
    if (frame.dataset.src) {
      const bust = frame.dataset.src + (frame.dataset.src.includes("?") ? "&" : "?") + "_=" + Date.now();
      frame.src = bust;
    }
  } catch (err) {
    toast("Erreur", err.message, "err");
  } finally {
    setDetailRedeploying(false);
    resetDetailDropzone();
  }
}

async function submitRename(e) {
  e.preventDefault();
  if (!state.detailName) return;
  const oldName = state.detailName;
  const newName = $("#sd-rename-input").value.toLowerCase().trim();
  if (!newName || newName === oldName) return;
  const btn = $("#sd-rename-btn");
  setBtnLoading(btn, true, "Renommage…");
  try {
    const res = await api(`/api/sites/${encodeURIComponent(oldName)}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    toast("Renommé", `« ${oldName} » → « ${res.name || newName} ».`, "ok");
    state.detailName = res.name || newName;
    await refreshSites();
    location.hash = `#/site/${encodeURIComponent(state.detailName)}`;
  } catch (err) {
    toast("Erreur", err.message, "err");
  } finally {
    setBtnLoading(btn, false);
  }
}

async function submitAuth(e) {
  e.preventDefault();
  if (!state.detailName) return;
  const user = $("#sd-auth-user").value.trim();
  const pass = $("#sd-auth-pass").value;
  if (!user) { toast("Manquant", "Renseignez un identifiant.", "err"); return; }
  if (!pass) { toast("Manquant", "Renseignez un mot de passe.", "err"); return; }
  const btn = $("#sd-auth-save");
  setBtnLoading(btn, true, "Enregistrement…");
  try {
    await api(`/api/sites/${encodeURIComponent(state.detailName)}/auth`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, password: pass }),
    });
    toast("Protégé", "Authentification activée.", "ok");
    $("#sd-auth-pass").value = "";
    $("#sd-auth-clear").hidden = false;
    $("#sd-auth-pill").hidden = false;
    await refreshSites();
  } catch (err) {
    toast("Erreur", err.message, "err");
  } finally {
    setBtnLoading(btn, false);
  }
}

async function clearAuth() {
  if (!state.detailName) return;
  const btn = $("#sd-auth-clear");
  btn.disabled = true;
  try {
    await api(`/api/sites/${encodeURIComponent(state.detailName)}/auth`, { method: "DELETE" });
    toast("Retiré", "Protection supprimée.", "ok");
    $("#sd-auth-toggle").checked = false;
    $("#sd-auth-fields").hidden = true;
    $("#sd-auth-pass").value = "";
    $("#sd-auth-clear").hidden = true;
    $("#sd-auth-pill").hidden = true;
    await refreshSites();
  } catch (err) {
    toast("Erreur", err.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function saveDomains() {
  if (!state.detailName) return false;
  try {
    await api(`/api/sites/${encodeURIComponent(state.detailName)}/domains`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domains: state.detailDomains }),
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
  if (!state.detailName) return;
  const input = $("#sd-domain-input");
  const val = input.value.trim().toLowerCase();
  if (!val) return;
  if (state.detailDomains.includes(val)) {
    toast("Déjà présent", "Ce domaine est déjà dans la liste.", "err");
    return;
  }
  const prev = [...state.detailDomains];
  state.detailDomains.push(val);
  renderDetailDomains();
  input.value = "";
  const ok = await saveDomains();
  if (ok) toast("Ajouté", `${val} configuré.`, "ok");
  else { state.detailDomains = prev; renderDetailDomains(); }
}

async function removeDomain(idx) {
  if (!state.detailName) return;
  const prev = [...state.detailDomains];
  const removed = state.detailDomains[idx];
  state.detailDomains.splice(idx, 1);
  renderDetailDomains();
  const ok = await saveDomains();
  if (ok) toast("Retiré", `${removed} a été retiré.`, "ok");
  else { state.detailDomains = prev; renderDetailDomains(); }
}

async function deleteCurrentSite() {
  if (!state.detailName) return;
  const name = state.detailName;
  const ok = await confirmModal({
    title: "Supprimer ce site ?",
    body: `Le site <code>${escape(name)}</code> sera retiré du serveur ainsi que sa configuration HTTPS. Cette action est définitive.`,
    okLabel: "Supprimer",
  });
  if (!ok) return;
  try {
    await api(`/api/sites/${encodeURIComponent(name)}`, { method: "DELETE" });
    toast("Retiré", `« ${name} » a été supprimé.`, "ok");
    state.detailName = null;
    await refreshSites();
    location.hash = "#/";
  } catch (err) {
    toast("Erreur", err.message, "err");
  }
}

/* ============ NOTES (site detail) ============ */

function showNoteSavedIndicator() {
  const el = $("#sd-note-saved");
  if (!el) return;
  el.hidden = false;
  // Force reflow to allow transition.
  void el.offsetWidth;
  el.classList.add("is-visible");
  if (state.noteSavedTimer) clearTimeout(state.noteSavedTimer);
  state.noteSavedTimer = setTimeout(() => {
    el.classList.remove("is-visible");
    state.noteSavedTimer = setTimeout(() => {
      el.hidden = true;
      state.noteSavedTimer = null;
    }, 280);
  }, 1400);
}

function hideNoteSavedIndicator() {
  const el = $("#sd-note-saved");
  if (!el) return;
  el.classList.remove("is-visible");
  el.hidden = true;
  if (state.noteSavedTimer) {
    clearTimeout(state.noteSavedTimer);
    state.noteSavedTimer = null;
  }
}

async function saveNote() {
  if (!state.detailName) return;
  const noteEl = $("#sd-note");
  if (!noteEl) return;
  const value = noteEl.value;
  if (value === state.noteLastSaved) return;
  if (state.noteSaving) return;
  state.noteSaving = true;
  const attempted = value;
  try {
    await api(`/api/sites/${encodeURIComponent(state.detailName)}/note`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: attempted }),
    });
    state.noteLastSaved = attempted;
    // Mirror to local sites cache so refreshes don't flicker.
    const site = getSiteByName(state.detailName);
    if (site) site.note = attempted;
    showNoteSavedIndicator();
  } catch (err) {
    toast("Note", err.message || "Enregistrement impossible.", "err");
  } finally {
    state.noteSaving = false;
    // If user kept typing during save, schedule another flush.
    if (noteEl.value !== state.noteLastSaved) {
      scheduleNoteSave();
    }
  }
}

function scheduleNoteSave() {
  if (state.noteDebounce) clearTimeout(state.noteDebounce);
  state.noteDebounce = setTimeout(() => {
    state.noteDebounce = null;
    saveNote();
  }, 800);
}

function flushNoteSave() {
  if (state.noteDebounce) {
    clearTimeout(state.noteDebounce);
    state.noteDebounce = null;
  }
  saveNote();
}

/* ============ DOMAINS PAGE ============ */

async function fetchDomains() {
  const list = await api("/api/domains");
  state.domains = Array.isArray(list) ? list : [];
  return state.domains;
}

async function refreshDomainsForDeploy() {
  try {
    await fetchDomains();
  } catch {
    /* ignore — deploy form falls back to empty select */
    state.domains = [];
  }
  populateDeployDomainSelect();
}

function populateDeployDomainSelect() {
  const select = $("#deploy-domain-select");
  if (!select) return;
  const free = state.domains.filter((d) => !d.site);
  const current = state.selectedDeployDomain;
  const opts = ['<option value="">Aucun — juste auto subdomain</option>'];
  for (const d of free) {
    const sel = d.domain === current ? " selected" : "";
    opts.push(`<option value="${escape(d.domain)}"${sel}>${escape(d.domain)}</option>`);
  }
  select.innerHTML = opts.join("");
  if (current && !free.some((d) => d.domain === current)) {
    state.selectedDeployDomain = "";
  }
}

async function showDomainsPage() {
  showScreen("domains-screen");
  try {
    await fetchDomains();
  } catch (err) {
    toast("Erreur", err.message || "Chargement impossible", "err");
    return;
  }
  renderDomainsList();
  setTimeout(() => $("#domain-add-input")?.focus(), 30);
}

function renderDomainsList() {
  const list = $("#domains-list");
  const sub = $("#domains-page-count");
  list.innerHTML = "";
  const total = state.domains.length;
  const free = state.domains.filter((d) => !d.site).length;
  sub.textContent = total === 0
    ? "Aucun domaine pour le moment."
    : `${total} domaine${total > 1 ? "s" : ""} · ${free} libre${free > 1 ? "s" : ""}`;

  if (total === 0) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty__icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>
          </svg>
        </div>
        <div class="empty__title">Aucun domaine enregistré</div>
        <div class="empty__sub">Ajoutez votre premier domaine ci-dessus.</div>
      </div>`;
    return;
  }

  state.domains.forEach((d, i) => {
    const el = document.createElement("article");
    el.className = "domain-row fade-in";
    el.style.animationDelay = `${i * 0.03}s`;
    el.dataset.domain = d.domain;
    const status = d.site
      ? `<span class="domain-row__pill domain-row__pill--assigned">→ <a href="#/site/${encodeURIComponent(d.site)}">${escape(d.site)}</a></span>`
      : `<span class="domain-row__pill domain-row__pill--free">Libre</span>`;
    const removeBtn = d.site
      ? ""
      : `<button class="btn btn--ghost btn--sm" data-action="domain-delete" data-domain="${escape(d.domain)}">Retirer</button>`;
    el.innerHTML = `
      <div class="domain-row__main">
        <div class="domain-row__head">
          <span class="domain-row__name">${escape(d.domain)}</span>
          ${status}
        </div>
        <div class="domain-row__dns" id="dns-${escape(d.domain)}" hidden></div>
      </div>
      <div class="domain-row__actions">
        <button class="btn btn--ghost btn--sm" data-action="domain-check" data-domain="${escape(d.domain)}">Vérifier DNS</button>
        ${removeBtn}
      </div>`;
    list.appendChild(el);
  });
}

async function addDomainFromPage(e) {
  e.preventDefault();
  const input = $("#domain-add-input");
  const domain = input.value.trim().toLowerCase();
  if (!domain) return;
  const btn = $("#domain-add-btn");
  setBtnLoading(btn, true, "Ajout…");
  try {
    await api("/api/domains", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain }),
    });
    toast("Ajouté", `${domain} enregistré.`, "ok");
    input.value = "";
    await fetchDomains();
    renderDomainsList();
  } catch (err) {
    toast("Erreur", err.message, "err");
  } finally {
    setBtnLoading(btn, false);
  }
}

async function deleteDomainFromPage(domain) {
  const ok = await confirmModal({
    title: "Retirer ce domaine ?",
    body: `<code>${escape(domain)}</code> sera retiré du registre. Cette action est sans effet sur le DNS.`,
    okLabel: "Retirer",
  });
  if (!ok) return;
  try {
    await api(`/api/domains/${encodeURIComponent(domain)}`, { method: "DELETE" });
    toast("Retiré", `${domain} retiré du registre.`, "ok");
    await fetchDomains();
    renderDomainsList();
  } catch (err) {
    toast("Erreur", err.message, "err");
  }
}

async function checkDomainDns(domain, btn) {
  const dnsBox = document.getElementById(`dns-${domain}`);
  if (!dnsBox) return;
  setBtnLoading(btn, true, "Vérification…");
  try {
    const data = await api(`/api/domains/${encodeURIComponent(domain)}/check`);
    const rows = [];
    if (data.error && data.ips.length === 0 && data.ipv6.length === 0) {
      rows.push(`<div class="domain-row__dns-row"><span class="domain-row__dns-label">Erreur</span><span class="domain-row__dns-value domain-row__dns-value--err">${escape(data.error)}</span></div>`);
    }
    if (data.ips.length > 0) {
      rows.push(`<div class="domain-row__dns-row"><span class="domain-row__dns-label">A</span><span class="domain-row__dns-value">${data.ips.map(escape).join(", ")}</span></div>`);
    }
    if (data.ipv6.length > 0) {
      rows.push(`<div class="domain-row__dns-row"><span class="domain-row__dns-label">AAAA</span><span class="domain-row__dns-value">${data.ipv6.map(escape).join(", ")}</span></div>`);
    }
    dnsBox.innerHTML = rows.join("");
    dnsBox.hidden = false;
  } catch (err) {
    dnsBox.innerHTML = `<div class="domain-row__dns-row"><span class="domain-row__dns-label">Err</span><span class="domain-row__dns-value domain-row__dns-value--err">${escape(err.message)}</span></div>`;
    dnsBox.hidden = false;
  } finally {
    setBtnLoading(btn, false);
  }
}

/* ============ TOKENS PAGE ============ */

async function fetchTokens() {
  const list = await api("/api/tokens");
  state.tokens = Array.isArray(list) ? list : [];
  return state.tokens;
}

async function showTokensPage() {
  showScreen("tokens-screen");
  try {
    await fetchTokens();
  } catch (err) {
    toast("Erreur", err.message || "Chargement impossible", "err");
    return;
  }
  renderTokensList();
  setTimeout(() => $("#token-add-input")?.focus(), 30);
}

function renderTokensList() {
  const list = $("#tokens-list");
  const sub = $("#tokens-page-count");
  list.innerHTML = "";
  const total = state.tokens.length;
  sub.textContent = total === 0
    ? "Aucun token pour le moment."
    : `${total} token${total > 1 ? "s" : ""}`;

  if (total === 0) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty__icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 2 15 8M17 6l4 4M11 12a4 4 0 1 0-4 4 4 4 0 0 0 4-4ZM7 12 3 16l2 2 4-4"/>
          </svg>
        </div>
        <div class="empty__title">Aucun token actif</div>
        <div class="empty__sub">Créez votre premier token ci-dessus pour automatiser vos déploiements.</div>
      </div>`;
    return;
  }

  state.tokens.forEach((t, i) => {
    const el = document.createElement("article");
    el.className = "token-row fade-in";
    el.style.animationDelay = `${i * 0.03}s`;
    el.dataset.id = t.id;
    const created = t.createdAt ? `Créé ${fmtRelativeDays(t.createdAt)}` : "Créé —";
    const used = t.lastUsedAt ? `Utilisé ${fmtRelativeDays(t.lastUsedAt)}` : "Jamais utilisé";
    el.innerHTML = `
      <div class="token-row__main">
        <div class="token-row__head">
          <span class="token-row__name">${escape(t.name || "—")}</span>
          <span class="token-row__prefix">mwt_${escape(t.prefix || "")}…</span>
        </div>
        <div class="token-row__meta">
          <span>${escape(created)}</span>
          <span class="token-row__meta-sep">·</span>
          <span>${escape(used)}</span>
        </div>
      </div>
      <div class="token-row__actions">
        <button class="btn btn--ghost btn--sm" data-action="token-revoke" data-id="${escape(t.id)}" data-name="${escape(t.name || "")}">Révoquer</button>
      </div>`;
    list.appendChild(el);
  });
}

function buildCurlExample(secret) {
  const origin = location.origin;
  return `curl -X POST ${origin}/api/sites \\
  -H "Authorization: Bearer ${secret}" \\
  --form name=monapp \\
  --form file=@dist.zip`;
}

function showTokenSecret(token, secret) {
  const dlg = $("#token-secret-dialog");
  $("#token-secret-value").textContent = secret;
  $("#token-curl-code").textContent = buildCurlExample(secret);
  dlg.dataset.secret = secret;
  if (!dlg.open) dlg.showModal();
}

function clearTokenSecretDialog() {
  const dlg = $("#token-secret-dialog");
  // Wipe DOM + dataset so the secret never lingers.
  $("#token-secret-value").textContent = "—";
  $("#token-curl-code").textContent = "—";
  delete dlg.dataset.secret;
}

function closeTokenSecretDialog() {
  const dlg = $("#token-secret-dialog");
  if (dlg.open) dlg.close();
  clearTokenSecretDialog();
}

async function createToken(e) {
  e.preventDefault();
  const input = $("#token-add-input");
  const name = input.value.trim();
  if (!name) return;
  const btn = $("#token-add-btn");
  setBtnLoading(btn, true, "Création…");
  try {
    const data = await api("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!data || !data.secret) throw new Error("Réponse invalide.");
    showTokenSecret(data.token, data.secret);
    input.value = "";
    toast("Créé", `Token « ${data.token?.name || name} » prêt.`, "ok");
  } catch (err) {
    toast("Erreur", err.message, "err");
  } finally {
    setBtnLoading(btn, false);
  }
}

async function revokeToken(id, name) {
  const ok = await confirmModal({
    title: "Révoquer ce token ?",
    body: `Le token <code>${escape(name || id)}</code> ne pourra plus être utilisé. Cette action est définitive.`,
    okLabel: "Révoquer",
  });
  if (!ok) return;
  try {
    await api(`/api/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("Révoqué", `Token retiré.`, "ok");
    await fetchTokens();
    renderTokensList();
  } catch (err) {
    toast("Erreur", err.message, "err");
  }
}

async function copyText(btn, text, label = "Copié") {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const original = btn.innerHTML;
      btn.classList.add("is-ok");
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>`;
      setTimeout(() => {
        btn.classList.remove("is-ok");
        btn.innerHTML = original;
      }, 1200);
    }
    toast(label, "Copié dans le presse-papiers", "ok");
  } catch {
    toast("Erreur", "Impossible de copier.", "err");
  }
}

/* ============ HELPERS ============ */

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

/* ============ BIND ============ */

function bind() {
  $$("[data-theme-toggle]").forEach((b) => b.addEventListener("click", toggleTheme));

  document.body.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "logout") logout();
  });

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

  /* ---- top-level deploy form ---- */
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
    if (!file) { toast("Manquant", "Choisissez d'abord une archive .zip.", "err"); return; }
    const customDomain = $("#deploy-domain-select")?.value || "";
    const btn = $("#deploy-btn");
    setBtnLoading(btn, true, "Publication…");
    try {
      const data = await deploy(name, file);
      let detail = data.url;
      if (customDomain) {
        try {
          await api(`/api/sites/${encodeURIComponent(name)}/domains`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ domains: [customDomain] }),
          });
          detail = `https://${customDomain}`;
        } catch (err) {
          toast("Domaine non assigné", err.message, "err");
        }
      }
      toast("Publié", `En ligne : ${detail}`, "ok");
      $("#deploy-form").reset();
      setSelectedFile(null);
      state.selectedDeployDomain = "";
      await refreshSites();
      await refreshDomainsForDeploy();
    } catch (err) {
      toast("Erreur", err.message, "err");
    } finally {
      setBtnLoading(btn, false);
    }
  });

  $("#deploy-domain-select").addEventListener("change", (e) => {
    state.selectedDeployDomain = e.target.value;
    if (e.target.value) {
      const slug = $("#site-name");
      if (!slug.value) {
        const nameFromDomain = e.target.value.split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "");
        if (nameFromDomain) slug.value = nameFromDomain.slice(0, 32);
      }
    }
  });

  $("#site-name").addEventListener("input", (e) => {
    e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
  });

  /* ---- sites list interactions ---- */
  const list = $("#sites-list");
  list.addEventListener("click", async (e) => {
    const stop = e.target.closest("[data-stop]");
    if (stop) {
      e.stopPropagation();
      const action = e.target.closest("[data-action]")?.dataset.action;
      if (action === "copy") {
        const btn = e.target.closest("[data-action='copy']");
        await copyUrl(btn, btn.dataset.url);
      }
      return;
    }
    const card = e.target.closest(".site");
    if (card?.dataset.name) navigateSite(card.dataset.name);
  });
  list.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".site");
    if (card?.dataset.name) {
      e.preventDefault();
      navigateSite(card.dataset.name);
    }
  });

  $("#sites-filter").addEventListener("input", (e) => {
    state.filter = e.target.value;
    renderSites();
  });

  /* ---- detail-page redeploy dropzone ---- */
  const sdDz = $("#sd-dropzone");
  ["dragenter", "dragover"].forEach((ev) =>
    sdDz.addEventListener(ev, (e) => {
      e.preventDefault();
      sdDz.classList.add("is-dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    sdDz.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === "dragleave" && e.target !== sdDz) return;
      sdDz.classList.remove("is-dragover");
    })
  );
  sdDz.addEventListener("drop", async (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) await redeploySite(f);
  });
  $("#sd-file-input").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) await redeploySite(f);
  });

  /* ---- detail copy URL ---- */
  $("#sd-copy").addEventListener("click", async (e) => {
    e.preventDefault();
    const btn = e.currentTarget;
    await copyUrl(btn, btn.dataset.url);
  });

  /* ---- detail settings ---- */
  $("#sd-rename-form").addEventListener("submit", submitRename);
  $("#sd-rename-input").addEventListener("input", (e) => {
    e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
  });

  $("#sd-auth-toggle").addEventListener("change", (e) => {
    const on = e.target.checked;
    const fields = $("#sd-auth-fields");
    fields.hidden = !on;
    if (on) {
      const site = getSiteByName(state.detailName);
      const hasAuth = !!(site && site.auth && site.auth.user);
      if (!hasAuth) {
        $("#sd-auth-user").value = $("#sd-auth-user").value || "admin";
        $("#sd-auth-pass").focus();
      }
    }
  });

  $("#sd-auth-form").addEventListener("submit", submitAuth);
  $("#sd-auth-clear").addEventListener("click", clearAuth);

  $("#sd-domain-form").addEventListener("submit", addDomain);
  $("#sd-domains-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".settings__domain-remove");
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    if (!Number.isNaN(idx)) removeDomain(idx);
  });

  $("#sd-delete-btn").addEventListener("click", deleteCurrentSite);

  /* ---- domains page ---- */
  $("#domain-add-form").addEventListener("submit", addDomainFromPage);
  $("#domains-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const domain = btn.dataset.domain;
    if (!domain) return;
    if (action === "domain-delete") await deleteDomainFromPage(domain);
    else if (action === "domain-check") await checkDomainDns(domain, btn);
  });

  /* ---- notes (site detail) ---- */
  const noteEl = $("#sd-note");
  if (noteEl) {
    noteEl.addEventListener("input", scheduleNoteSave);
    noteEl.addEventListener("blur", flushNoteSave);
  }

  /* ---- tokens page ---- */
  $("#token-add-form").addEventListener("submit", createToken);
  $("#tokens-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "token-revoke") {
      await revokeToken(btn.dataset.id, btn.dataset.name);
    }
  });

  const secretDlg = $("#token-secret-dialog");
  if (secretDlg) {
    $("#token-secret-copy").addEventListener("click", (e) => {
      const secret = secretDlg.dataset.secret || "";
      if (secret) copyText(e.currentTarget, secret, "Token copié");
    });
    $("#token-curl-copy").addEventListener("click", (e) => {
      const secret = secretDlg.dataset.secret || "";
      if (secret) copyText(e.currentTarget, buildCurlExample(secret), "Commande copiée");
    });
    $("#token-secret-close").addEventListener("click", closeTokenSecretDialog);
    $("#token-secret-done").addEventListener("click", closeTokenSecretDialog);
    secretDlg.addEventListener("close", () => {
      clearTokenSecretDialog();
      // Refresh list after dismissal so the new token appears.
      if (location.hash === "#/tokens" || location.hash === "#/tokens/") {
        fetchTokens().then(renderTokensList).catch(() => {});
      }
    });
  }

  /* ---- prevent accidental file-drop navigation outside dropzones ---- */
  const isFileDrag = (e) => {
    const types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) if (types[i] === "Files") return true;
    return false;
  };
  window.addEventListener("dragover", (e) => {
    if (isFileDrag(e)) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    const inDropzone = e.target.closest("#dropzone, #sd-dropzone");
    if (!inDropzone && isFileDrag(e)) e.preventDefault();
  });

  /* ---- system theme tracker ---- */
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!localStorage.getItem(THEME_KEY)) setTheme(e.matches ? "dark" : "light");
  });

  /* ---- routing ---- */
  window.addEventListener("hashchange", route);
}

async function init() {
  bind();
  await route();
}

init();
