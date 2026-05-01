import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";

const siteBlock = (host: string, root: string) => `${host} {
    root * ${root}
    encode gzip
    try_files {path} /index.html
    file_server
}
`;

export async function writeSiteConfig(name: string): Promise<void> {
  await mkdir(config.caddySitesDir, { recursive: true });
  const host = `${name}.${config.baseDomain}`;
  const root = path.join(config.sitesDir, name);
  const file = path.join(config.caddySitesDir, `${name}.caddy`);
  await writeFile(file, siteBlock(host, root));
  await reloadCaddy();
}

export async function deleteSiteConfig(name: string): Promise<void> {
  const file = path.join(config.caddySitesDir, `${name}.caddy`);
  try {
    await unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await reloadCaddy();
}

async function reloadCaddy(): Promise<void> {
  const proc = Bun.spawn(["caddy", "reload", "--config", config.caddyConfigPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`caddy reload failed: ${err.trim() || `exit ${exit}`}`);
  }
}
