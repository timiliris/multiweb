import { mkdir, readdir, rm, writeFile, stat, rename } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { syncCaddy } from "./caddy.ts";

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const RESERVED = new Set(["www", "dash", "admin", "api"]);

export function validateName(name: string): boolean {
  return NAME_RE.test(name) && !RESERVED.has(name);
}

export interface Site {
  name: string;
  url: string;
  size: number;
  updatedAt: number;
}

const isUserSiteDir = (name: string): boolean => !name.startsWith(".");

export async function listSites(): Promise<Site[]> {
  await mkdir(config.sitesDir, { recursive: true });
  const entries = await readdir(config.sitesDir, { withFileTypes: true });
  const sites: Site[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isUserSiteDir(e.name)) continue;
    const dir = path.join(config.sitesDir, e.name);
    const st = await stat(dir);
    sites.push({
      name: e.name,
      url: `${config.scheme}://${e.name}.${config.baseDomain}`,
      size: await dirSize(dir),
      updatedAt: st.mtimeMs,
    });
  }
  return sites.sort((a, b) => b.updatedAt - a.updatedAt);
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
  await syncCaddy();
}

export async function cleanupStaging(): Promise<void> {
  try {
    const entries = await readdir(config.sitesDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".tmp-") || e.name.startsWith(".zip-")) {
        await rm(path.join(config.sitesDir, e.name), { recursive: true, force: true });
      }
    }
  } catch {
    /* sitesDir may not exist yet; ignore */
  }
}
