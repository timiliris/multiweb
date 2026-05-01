import path from "node:path";
import { config } from "./config.ts";
import { checkAuth, unauthorized } from "./auth.ts";
import {
  listSites,
  deploySite,
  deleteSite,
  renameSite,
  validateName,
  validateUser,
  validatePassword,
  validateCustomDomain,
  isSubdomainOfBase,
  cleanupStaging,
} from "./sites.ts";
import { syncCaddy } from "./caddy.ts";
import {
  readMeta,
  setSiteAuth,
  clearSiteAuth,
  setSiteCustomDomains,
  addKnownDomain,
  removeKnownDomain,
} from "./meta.ts";
import { listDomains, resolveDomain } from "./domains.ts";

const PUBLIC_DIR = path.join(import.meta.dir, "..", "public");

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

async function serveStatic(pathname: string): Promise<Response> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return new Response("Forbidden", { status: 403 });
  }
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    const fallback = Bun.file(path.join(PUBLIC_DIR, "index.html"));
    if (await fallback.exists()) return new Response(fallback);
    return new Response("Not found", { status: 404 });
  }
  return new Response(file);
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return {};
  return body as Record<string, unknown>;
}

async function handleApi(req: Request, pathname: string): Promise<Response> {
  if (pathname === "/api/login" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (!body || typeof body !== "object" || (body as { password?: unknown }).password !== config.password) {
      return json({ error: "Mot de passe incorrect" }, { status: 401 });
    }
    return json({ token: config.password });
  }

  if (pathname === "/api/me" && req.method === "GET") {
    if (!checkAuth(req)) return unauthorized();
    return json({ baseDomain: config.baseDomain });
  }

  if (!checkAuth(req)) return unauthorized();

  if (pathname === "/api/sites" && req.method === "GET") {
    return json(await listSites());
  }

  if (pathname === "/api/sites" && req.method === "POST") {
    const form = await req.formData();
    const name = String(form.get("name") ?? "").toLowerCase().trim();
    const file = form.get("file");
    if (!validateName(name)) {
      return json({ error: "Nom invalide (a-z, 0-9, -, 2-32 caractères)" }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return json({ error: "Fichier zip manquant" }, { status: 400 });
    }
    if (file.size > config.maxUploadMb * 1024 * 1024) {
      return json({ error: `Fichier trop volumineux (>${config.maxUploadMb}MB)` }, { status: 413 });
    }
    await deploySite(name, file);
    return json({ ok: true, name, url: `https://${name}.${config.baseDomain}` });
  }

  if (pathname.startsWith("/api/sites/")) {
    const rest = pathname.slice("/api/sites/".length);
    const [rawName, ...subParts] = rest.split("/");
    const name = decodeURIComponent(rawName);
    const sub = subParts.join("/");

    if (sub === "" && req.method === "DELETE") {
      if (!validateName(name)) return json({ error: "Nom invalide" }, { status: 400 });
      await deleteSite(name);
      return json({ ok: true });
    }

    if (sub === "rename" && req.method === "POST") {
      if (!validateName(name)) return json({ error: "Nom invalide" }, { status: 400 });
      const body = await readJson(req);
      const next = String(body.name ?? "").toLowerCase().trim();
      if (!validateName(next)) {
        return json({ error: "Nouveau nom invalide (a-z, 0-9, -, 2-32 caractères)" }, { status: 400 });
      }
      try {
        await renameSite(name, next);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Renommage échoué";
        const status = msg.includes("existe déjà") ? 409 : msg.includes("introuvable") ? 404 : 400;
        return json({ error: msg }, { status });
      }
      return json({ ok: true, name: next, url: `${config.scheme}://${next}.${config.baseDomain}` });
    }

    if (sub === "auth" && req.method === "PUT") {
      if (!validateName(name)) return json({ error: "Nom invalide" }, { status: 400 });
      const body = await readJson(req);
      const user = String(body.user ?? "");
      const password = String(body.password ?? "");
      if (!validateUser(user)) {
        return json({ error: "Utilisateur invalide (lettres, chiffres, _, 1-32 caractères)" }, { status: 400 });
      }
      if (!validatePassword(password)) {
        return json({ error: "Mot de passe trop court (4 caractères minimum)" }, { status: 400 });
      }
      const passwordHash = await Bun.password.hash(password, "bcrypt");
      await setSiteAuth(name, { user, passwordHash });
      await syncCaddy();
      return json({ ok: true, auth: { user } });
    }

    if (sub === "auth" && req.method === "DELETE") {
      if (!validateName(name)) return json({ error: "Nom invalide" }, { status: 400 });
      await clearSiteAuth(name);
      await syncCaddy();
      return json({ ok: true });
    }

    if (sub === "domains" && req.method === "PUT") {
      if (!validateName(name)) return json({ error: "Nom invalide" }, { status: 400 });
      const body = await readJson(req);
      const raw = body.domains;
      if (!Array.isArray(raw)) {
        return json({ error: "Liste de domaines manquante" }, { status: 400 });
      }
      const normalized: string[] = [];
      for (const d of raw) {
        if (typeof d !== "string") {
          return json({ error: "Domaine invalide" }, { status: 400 });
        }
        const v = d.trim().toLowerCase();
        if (!v) continue;
        if (!validateCustomDomain(v)) {
          return json({ error: `Domaine invalide: ${d}` }, { status: 400 });
        }
        if (isSubdomainOfBase(v)) {
          return json({ error: `Domaine réservé (sous-domaine de ${config.baseDomain}): ${v}` }, { status: 400 });
        }
        if (!normalized.includes(v)) normalized.push(v);
      }

      const meta = await readMeta();
      for (const [other, m] of Object.entries(meta.sites)) {
        if (other === name) continue;
        for (const d of m.customDomains ?? []) {
          if (normalized.includes(d.toLowerCase())) {
            return json({ error: `Domaine déjà utilisé par un autre site: ${d}` }, { status: 409 });
          }
        }
      }

      await setSiteCustomDomains(name, normalized);
      await syncCaddy();
      return json({ ok: true, customDomains: normalized });
    }
  }

  if (pathname === "/api/domains" && req.method === "GET") {
    return json(await listDomains());
  }

  if (pathname === "/api/domains" && req.method === "POST") {
    const body = await readJson(req);
    const domain = String(body.domain ?? "").trim().toLowerCase();
    if (!validateCustomDomain(domain)) {
      return json({ error: "Domaine invalide" }, { status: 400 });
    }
    if (isSubdomainOfBase(domain)) {
      return json({ error: `Domaine réservé (sous-domaine de ${config.baseDomain})` }, { status: 400 });
    }
    await addKnownDomain(domain);
    return json({ ok: true, domain });
  }

  if (pathname.startsWith("/api/domains/")) {
    const rest = pathname.slice("/api/domains/".length);
    const [rawDomain, ...subParts] = rest.split("/");
    const domain = decodeURIComponent(rawDomain).toLowerCase();
    const sub = subParts.join("/");

    if (!validateCustomDomain(domain)) {
      return json({ error: "Domaine invalide" }, { status: 400 });
    }

    if (sub === "" && req.method === "DELETE") {
      const meta = await readMeta();
      for (const [siteName, m] of Object.entries(meta.sites)) {
        if ((m.customDomains ?? []).some((d) => d.toLowerCase() === domain)) {
          return json({ error: `Domaine assigné à « ${siteName} » — retirez-le d'abord du site.` }, { status: 409 });
        }
      }
      await removeKnownDomain(domain);
      return json({ ok: true });
    }

    if (sub === "check" && req.method === "GET") {
      return json(await resolveDomain(domain));
    }
  }

  return new Response("Not found", { status: 404 });
}

Bun.serve({
  port: config.port,
  hostname: config.hostname,
  maxRequestBodySize: config.maxUploadMb * 1024 * 1024 + 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(req, url.pathname);
      }
      return await serveStatic(url.pathname);
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : "Internal error";
      return json({ error: message }, { status: 500 });
    }
  },
});

console.log(`multiweb listening on http://${config.hostname}:${config.port} (base: ${config.baseDomain})`);

await cleanupStaging();

const initialSync = async (attempt = 1): Promise<void> => {
  try {
    await syncCaddy();
    console.log("Caddy config synced");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (attempt <= 5) {
      console.warn(`Caddy sync attempt ${attempt} failed (${msg}), retrying in 2s…`);
      setTimeout(() => initialSync(attempt + 1), 2000);
    } else {
      console.error("Caddy initial sync gave up — fix Caddy and trigger a deploy.");
    }
  }
};

initialSync();
