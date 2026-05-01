import path from "node:path";
import { config } from "./config.ts";
import { checkAuth, unauthorized } from "./auth.ts";
import { listSites, deploySite, deleteSite, validateName } from "./sites.ts";
import { syncCaddy } from "./caddy.ts";

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

  if (pathname.startsWith("/api/sites/") && req.method === "DELETE") {
    const name = decodeURIComponent(pathname.slice("/api/sites/".length));
    if (!validateName(name)) return json({ error: "Nom invalide" }, { status: 400 });
    await deleteSite(name);
    return json({ ok: true });
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
