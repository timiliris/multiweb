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

export async function listSites(): Promise<Site[]> {
  await mkdir(config.sitesDir, { recursive: true });
  const entries = await readdir(config.sitesDir, { withFileTypes: true });
  const sites: Site[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(config.sitesDir, e.name);
    const st = await stat(dir);
    sites.push({
      name: e.name,
      url: `https://${e.name}.${config.baseDomain}`,
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

  const target = path.join(config.sitesDir, name);
  const tmpZip = path.join("/tmp", `multiweb-${name}-${Date.now()}.zip`);
  const tmpDir = path.join("/tmp", `multiweb-${name}-${Date.now()}-extract`);

  await writeFile(tmpZip, new Uint8Array(await zipFile.arrayBuffer()));
  await mkdir(tmpDir, { recursive: true });

  const proc = Bun.spawn(["unzip", "-q", "-o", tmpZip, "-d", tmpDir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await proc.exited;
  await rm(tmpZip, { force: true });

  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    await rm(tmpDir, { recursive: true, force: true });
    throw new Error(`Échec de l'extraction: ${err.trim() || `exit ${exit}`}`);
  }

  await flattenIfSingleDir(tmpDir);

  await mkdir(config.sitesDir, { recursive: true });
  await rm(target, { recursive: true, force: true });
  await rename(tmpDir, target);

  await syncCaddy();
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
