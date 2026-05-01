const TOKEN_KEY = "multiweb-token";

const $ = (sel) => document.querySelector(sel);

const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  baseDomain: "",
  sites: [],
  selectedFile: null,
};

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} ko`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
}

function fmtRelative(ts) {
  const diff = Date.now() - ts;
  const min = 60_000, hour = 60 * min, day = 24 * hour;
  if (diff < min) return "à l'instant";
  if (diff < hour) return `il y a ${Math.floor(diff / min)} min`;
  if (diff < day) return `il y a ${Math.floor(diff / hour)} h`;
  return `il y a ${Math.floor(diff / day)} j`;
}

function fmtDate(date) {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(date);
}

function toRoman(n) {
  const map = [["M", 1000], ["CM", 900], ["D", 500], ["CD", 400], ["C", 100], ["XC", 90], ["L", 50], ["XL", 40], ["X", 10], ["IX", 9], ["V", 5], ["IV", 4], ["I", 1]];
  let out = "";
  for (const [s, v] of map) {
    while (n >= v) { out += s; n -= v; }
  }
  return out || "I";
}

function slugify(input) {
  return input
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers });
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

function toast(label, message, kind = "info") {
  const host = $("#toast-host");
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.innerHTML = `<div class="toast__label">${escape(label)}</div><div>${escape(message)}</div>`;
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
  setTimeout(() => $("#login-form input[name=password]")?.focus(), 50);
}

async function showDashboard() {
  const me = await api("/api/me");
  state.baseDomain = me.baseDomain;
  $("#login-screen").hidden = true;
  $("#dashboard-screen").hidden = false;
  $("#meta-domain").textContent = me.baseDomain;
  $("#domain-suffix").textContent = `.${me.baseDomain}`;
  $("#meta-date").textContent = fmtDate(new Date());
  $("#meta-edition").textContent = String(new Date().getFullYear());
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
  const list = $("#sites-list");
  list.innerHTML = "";
  $("#meta-count").textContent = String(sites.length);
  $("#meta-count-s").textContent = sites.length > 1 ? "s" : "";
  $("#sites-count").textContent = `${String(sites.length).padStart(2, "0")} entrée${sites.length > 1 ? "s" : ""}`;

  if (sites.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty__title">Aucun site n'est encore publié.</div>
        <div class="empty__sub">Déposez une archive .zip ci-dessus pour commencer.</div>
      </div>`;
    return;
  }

  sites.forEach((site, i) => {
    const el = document.createElement("article");
    el.className = "site";
    el.style.animation = `fade-in 0.4s ${i * 0.04}s backwards`;
    el.innerHTML = `
      <div class="site__index">${toRoman(i + 1)}</div>
      <div class="site__body">
        <div class="site__name">${escape(site.name)}</div>
        <a class="site__url" href="${escape(site.url)}" target="_blank" rel="noopener">${escape(site.url)} ↗</a>
        <div class="site__meta">
          ${fmtSize(site.size)}
          <span class="site__meta-sep">·</span>
          ${fmtRelative(site.updatedAt)}
        </div>
      </div>
      <div class="site__actions">
        <button class="site__action site__action--danger" data-action="delete" data-name="${escape(site.name)}">Supprimer</button>
      </div>`;
    list.appendChild(el);
  });
}

async function deleteSite(name) {
  const ok = await confirmModal({
    title: "Supprimer ce site ?",
    body: `Le site <em>${escape(name)}</em> sera retiré du serveur ainsi que sa configuration HTTPS. Cette action est définitive.`,
    okLabel: "Supprimer",
  });
  if (!ok) return;
  try {
    await api(`/api/sites/${encodeURIComponent(name)}`, { method: "DELETE" });
    toast("Retiré", `Le site « ${name} » a été supprimé.`, "ok");
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
    hint.innerHTML = `<em>${escape(file.name)}</em>`;
    sub.textContent = fmtSize(file.size).toUpperCase();
    dz.classList.add("has-file");
    if (!$("#site-name").value) {
      $("#site-name").value = slugify(file.name.replace(/\.zip$/i, ""));
    }
  } else {
    hint.innerHTML = "Glissez votre archive <em>.zip</em>";
    sub.textContent = "ou cliquez pour parcourir";
    dz.classList.remove("has-file");
  }
}

function setBtnLoading(btn, loading, labelText) {
  const labelEl = btn.querySelector(".btn__label");
  const arrowEl = btn.querySelector(".btn__arrow");
  if (loading) {
    btn.disabled = true;
    btn.dataset.label = labelEl.textContent;
    labelEl.innerHTML = `<span class="spinner"></span>${labelText || labelEl.textContent}`;
    if (arrowEl) arrowEl.style.opacity = "0";
  } else {
    btn.disabled = false;
    labelEl.textContent = btn.dataset.label || labelText || "";
    if (arrowEl) arrowEl.style.opacity = "";
  }
}

function bind() {
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
    const file = e.dataTransfer?.files?.[0];
    if (file) setSelectedFile(file);
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
    if (btn.dataset.action === "delete") {
      await deleteSite(btn.dataset.name);
    }
  });

  $("#site-name").addEventListener("input", (e) => {
    e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
  });
}

async function init() {
  bind();
  if (state.token) {
    try {
      await showDashboard();
    } catch {
      logout();
    }
  } else {
    showLogin();
  }
}

init();
