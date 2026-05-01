const TOKEN_KEY = "multiweb-token";
const THEME_KEY = "multiweb-theme";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  baseDomain: "",
  sites: [],
  selectedFile: null,
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

async function refreshSites() {
  const sites = await api("/api/sites");
  state.sites = sites;
  $("#stat-count").textContent = String(sites.length);
  const total = sites.reduce((a, s) => a + s.size, 0);
  $("#stat-size").textContent = fmtSize(total);
  $("#sites-count").textContent = `${sites.length} entrée${sites.length > 1 ? "s" : ""}`;

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

  sites.forEach((site, i) => {
    const el = document.createElement("article");
    el.className = "site fade-in";
    el.style.animationDelay = `${i * 0.04}s`;
    el.innerHTML = `
      <div class="site__body">
        <div class="site__row">
          <span class="site__name">${escape(site.name)}</span>
          <span class="site__pill site__pill--live">live</span>
        </div>
        <a class="site__url" href="${escape(site.url)}" target="_blank" rel="noopener">${escape(site.url)} ↗</a>
        <div class="site__meta">
          <span>${fmtSize(site.size)}</span>
          <span class="site__meta-sep">·</span>
          <span>${fmtRelative(site.updatedAt)}</span>
        </div>
      </div>
      <div class="site__actions">
        <button class="btn btn--ghost btn--sm" data-action="delete" data-name="${escape(site.name)}">Supprimer</button>
      </div>`;
    list.appendChild(el);
  });
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
    if (btn.dataset.action === "delete") await deleteSite(btn.dataset.name);
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
