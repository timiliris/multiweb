import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";

export interface SiteAuth {
  user: string;
  passwordHash: string;
}

export interface SiteMeta {
  auth?: SiteAuth;
  customDomains?: string[];
  note?: string;
}

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface MetaFile {
  version: 1;
  sites: Record<string, SiteMeta>;
  knownDomains: string[];
  apiTokens: ApiToken[];
}

const META_PATH = () => path.join(config.sitesDir, ".multiweb.json");

const empty = (): MetaFile => ({ version: 1, sites: {}, knownDomains: [], apiTokens: [] });

export async function readMeta(): Promise<MetaFile> {
  try {
    const raw = await readFile(META_PATH(), "utf8");
    const parsed = JSON.parse(raw) as Partial<MetaFile>;
    if (!parsed || typeof parsed !== "object" || !parsed.sites) return empty();
    return {
      version: 1,
      sites: parsed.sites as Record<string, SiteMeta>,
      knownDomains: Array.isArray(parsed.knownDomains) ? parsed.knownDomains : [],
      apiTokens: Array.isArray(parsed.apiTokens) ? (parsed.apiTokens as ApiToken[]) : [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw err;
  }
}

export async function writeMeta(meta: MetaFile): Promise<void> {
  await mkdir(config.sitesDir, { recursive: true });
  const dest = META_PATH();
  const tmp = path.join(config.sitesDir, `.multiweb.json.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
  await rename(tmp, dest);
}

export async function updateMeta(fn: (meta: MetaFile) => void | Promise<void>): Promise<MetaFile> {
  const meta = await readMeta();
  await fn(meta);
  await writeMeta(meta);
  return meta;
}

function isSiteEntryEmpty(entry: SiteMeta): boolean {
  if (entry.auth) return false;
  if (entry.customDomains && entry.customDomains.length > 0) return false;
  if (entry.note && entry.note.length > 0) return false;
  return true;
}

export async function clearSiteAuth(name: string): Promise<void> {
  await updateMeta((meta) => {
    const entry = meta.sites[name];
    if (!entry) return;
    delete entry.auth;
    if (isSiteEntryEmpty(entry)) {
      delete meta.sites[name];
    }
  });
}

export async function setSiteAuth(name: string, auth: SiteAuth): Promise<void> {
  await updateMeta((meta) => {
    const entry = meta.sites[name] ?? {};
    entry.auth = auth;
    meta.sites[name] = entry;
  });
}

export async function setSiteCustomDomains(name: string, domains: string[]): Promise<void> {
  await updateMeta((meta) => {
    const entry = meta.sites[name] ?? {};
    if (domains.length === 0) {
      delete entry.customDomains;
    } else {
      entry.customDomains = domains;
    }
    if (isSiteEntryEmpty(entry)) {
      delete meta.sites[name];
    } else {
      meta.sites[name] = entry;
    }
    for (const d of domains) {
      const dl = d.toLowerCase();
      if (!meta.knownDomains.some((k) => k.toLowerCase() === dl)) {
        meta.knownDomains.push(d);
      }
    }
  });
}

export async function setSiteNote(name: string, note: string): Promise<void> {
  await updateMeta((meta) => {
    const entry = meta.sites[name] ?? {};
    if (!note) {
      delete entry.note;
    } else {
      entry.note = note;
    }
    if (isSiteEntryEmpty(entry)) {
      delete meta.sites[name];
    } else {
      meta.sites[name] = entry;
    }
  });
}

export async function addKnownDomain(domain: string): Promise<void> {
  const dl = domain.toLowerCase();
  await updateMeta((meta) => {
    if (!meta.knownDomains.some((k) => k.toLowerCase() === dl)) {
      meta.knownDomains.push(domain);
      meta.knownDomains.sort((a, b) => a.localeCompare(b));
    }
  });
}

export async function removeKnownDomain(domain: string): Promise<void> {
  const dl = domain.toLowerCase();
  await updateMeta((meta) => {
    meta.knownDomains = meta.knownDomains.filter((k) => k.toLowerCase() !== dl);
  });
}

export async function renameSiteMeta(from: string, to: string): Promise<void> {
  await updateMeta((meta) => {
    const entry = meta.sites[from];
    if (!entry) return;
    delete meta.sites[from];
    meta.sites[to] = entry;
  });
}

export async function deleteSiteMeta(name: string): Promise<void> {
  await updateMeta((meta) => {
    delete meta.sites[name];
  });
}

export async function pruneMeta(existingDirs: Set<string>): Promise<void> {
  await updateMeta((meta) => {
    for (const name of Object.keys(meta.sites)) {
      if (!existingDirs.has(name)) delete meta.sites[name];
    }
  });
}

export const API_TOKEN_PREFIX = "mwt_";

export async function addApiToken(name: string): Promise<{ token: ApiToken; secret: string }> {
  const random = randomBytes(32).toString("hex");
  const secret = `${API_TOKEN_PREFIX}${random}`;
  const id = randomBytes(4).toString("hex");
  const prefix = random.slice(0, 8);
  const hash = await Bun.password.hash(secret, "bcrypt");
  const token: ApiToken = {
    id,
    name,
    prefix,
    hash,
    createdAt: Date.now(),
  };
  await updateMeta((meta) => {
    meta.apiTokens.push(token);
  });
  return { token, secret };
}

export async function removeApiToken(id: string): Promise<boolean> {
  let removed = false;
  await updateMeta((meta) => {
    const before = meta.apiTokens.length;
    meta.apiTokens = meta.apiTokens.filter((t) => t.id !== id);
    removed = meta.apiTokens.length < before;
  });
  return removed;
}

export async function findApiTokenBySecret(secret: string): Promise<ApiToken | undefined> {
  if (!secret.startsWith(API_TOKEN_PREFIX)) return undefined;
  const meta = await readMeta();
  for (const token of meta.apiTokens) {
    const ok = await Bun.password.verify(secret, token.hash).catch(() => false);
    if (ok) {
      const id = token.id;
      const now = Date.now();
      await updateMeta((m) => {
        const t = m.apiTokens.find((x) => x.id === id);
        if (t) t.lastUsedAt = now;
      });
      return { ...token, lastUsedAt: now };
    }
  }
  return undefined;
}

export async function removeStaleTempMeta(): Promise<void> {
  try {
    const entries = await readdir(config.sitesDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.startsWith(".multiweb.json.") && e.name.endsWith(".tmp")) {
        await rm(path.join(config.sitesDir, e.name), { force: true });
      }
    }
  } catch {
    /* ignore */
  }
}
