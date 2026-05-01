import { mkdir, readdir, rm, writeFile, stat, rename } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { syncCaddy } from "./caddy.ts";
import {
  deleteSiteMeta,
  pruneMeta,
  readMeta,
  removeStaleTempMeta,
  renameSiteMeta,
} from "./meta.ts";

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const RESERVED = new Set(["www", "dash", "admin", "api"]);
const USER_RE = /^[a-zA-Z0-9_]{1,32}$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export function validateName(name: string): boolean {
  return NAME_RE.test(name) && !RESERVED.has(name);
}

export function validateUser(user: string): boolean {
  return typeof user === "string" && USER_RE.test(user);
}

export function validatePassword(password: string): boolean {
  return typeof password === "string" && password.length >= 4;
}

export function validateCustomDomain(domain: string): boolean {
  if (typeof domain !== "string") return false;
  const d = domain.trim().toLowerCase();
  if (!d || d.length > 253) return false;
  if (d.includes("*") || d.includes("/") || d.includes(":") || d.includes(" ")) return false;
  if (!DOMAIN_RE.test(d)) return false;
  return true;
}

export function isSubdomainOfBase(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  const base = config.baseDomain.toLowerCase();
  return d === base || d.endsWith(`.${base}`);
}

export interface Site {
  name: string;
  url: string;
  size: number;
  updatedAt: number;
  title?: string;
  auth?: { user: string };
  customDomains?: string[];
}

const isUserSiteDir = (name: string): boolean => !name.startsWith(".");

export async function listSites(): Promise<Site[]> {
  await mkdir(config.sitesDir, { recursive: true });
  const entries = await readdir(config.sitesDir, { withFileTypes: true });
  const meta = await readMeta();
  const sites: Site[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isUserSiteDir(e.name)) continue;
    const dir = path.join(config.sitesDir, e.name);
    const st = await stat(dir);
    const title = await readTitle(dir);
    const m = meta.sites[e.name];
    const site: Site = {
      name: e.name,
      url: `${config.scheme}://${e.name}.${config.baseDomain}`,
      size: await dirSize(dir),
      updatedAt: st.mtimeMs,
    };
    if (title !== undefined) site.title = title;
    if (m?.auth) site.auth = { user: m.auth.user };
    if (m?.customDomains && m.customDomains.length > 0) site.customDomains = m.customDomains;
    sites.push(site);
  }
  return sites.sort((a, b) => b.updatedAt - a.updatedAt);
}

const TITLE_LIMIT = 64 * 1024;

async function readTitle(dir: string): Promise<string | undefined> {
  const indexPath = path.join(dir, "index.html");
  const file = Bun.file(indexPath);
  if (!(await file.exists())) return undefined;
  const slice = file.slice(0, TITLE_LIMIT);
  const html = await slice.text().catch(() => "");
  if (!html) return undefined;
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return undefined;
  const text = m[1].replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.slice(0, 200);
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await stat(p)).size;
  }
  return total;
}

export async function deploySite(name: string, zipFile: File): Promise<void> {
  if (!validateName(name)) throw new Error("Nom invalide (a-z, 0-9, -)");

  await mkdir(config.sitesDir, { recursive: true });

  const target = path.join(config.sitesDir, name);
  const stamp = Date.now();
  const tmpZip = path.join(config.sitesDir, `.zip-${name}-${stamp}.zip`);
  const tmpDir = path.join(config.sitesDir, `.tmp-${name}-${stamp}`);

  try {
    await writeFile(tmpZip, new Uint8Array(await zipFile.arrayBuffer()));
    await mkdir(tmpDir, { recursive: true });

    const proc = Bun.spawn(["unzip", "-q", "-o", tmpZip, "-d", tmpDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;

    if (exit !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`Échec de l'extraction: ${err.trim() || `exit ${exit}`}`);
    }

    await cleanZipNoise(tmpDir);
    await flattenIfSingleDir(tmpDir);
    await ensureIndexHtml(tmpDir, name);

    await rm(target, { recursive: true, force: true });
    await rename(tmpDir, target);
  } finally {
    await rm(tmpZip, { force: true });
    await rm(tmpDir, { recursive: true, force: true });
  }

  await syncCaddy();
}

async function cleanZipNoise(dir: string): Promise<void> {
  for (const noise of ["__MACOSX", ".DS_Store"]) {
    await rm(path.join(dir, noise), { recursive: true, force: true });
  }
}

async function ensureIndexHtml(dir: string, siteName: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);

  if (files.includes("index.html")) return;

  const named = files.find((f) => f.toLowerCase() === `${siteName.toLowerCase()}.html`);
  if (named) {
    await rename(path.join(dir, named), path.join(dir, "index.html"));
    return;
  }

  const htmlFiles = files.filter((f) => f.toLowerCase().endsWith(".html"));
  if (htmlFiles.length === 1) {
    await rename(path.join(dir, htmlFiles[0]), path.join(dir, "index.html"));
  }
}

async function flattenIfSingleDir(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    const inner = path.join(dir, entries[0].name);
    const innerEntries = await readdir(inner);
    for (const e of innerEntries) {
      await rename(path.join(inner, e), path.join(dir, e));
    }
    await rm(inner, { recursive: true, force: true });
  }
}

export async function deleteSite(name: string): Promise<void> {
  if (!validateName(name)) throw new Error("Nom invalide");
  const target = path.join(config.sitesDir, name);
  await rm(target, { recursive: true, force: true });
  await deleteSiteMeta(name);
  await syncCaddy();
}

export async function renameSite(from: string, to: string): Promise<void> {
  if (!validateName(from)) throw new Error("Nom invalide");
  if (!validateName(to)) throw new Error("Nouveau nom invalide (a-z, 0-9, -, 2-32 caractères)");
  if (from === to) return;

  const src = path.join(config.sitesDir, from);
  const dst = path.join(config.sitesDir, to);

  const srcStat = await stat(src).catch(() => null);
  if (!srcStat || !srcStat.isDirectory()) throw new Error("Site introuvable");

  const dstStat = await stat(dst).catch(() => null);
  if (dstStat) throw new Error("Un site avec ce nom existe déjà");

  await rename(src, dst);
  await renameSiteMeta(from, to);
  await syncCaddy();
}

export async function cleanupStaging(): Promise<void> {
  try {
    const entries = await readdir(config.sitesDir, { withFileTypes: true });
    const existing = new Set<string>();
    for (const e of entries) {
      if (e.name.startsWith(".tmp-") || e.name.startsWith(".zip-")) {
        await rm(path.join(config.sitesDir, e.name), { recursive: true, force: true });
        continue;
      }
      if (e.isDirectory() && isUserSiteDir(e.name)) existing.add(e.name);
    }
    await removeStaleTempMeta();
    await pruneMeta(existing);
  } catch {
    /* sitesDir may not exist yet; ignore */
  }
}
