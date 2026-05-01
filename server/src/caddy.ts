import { readdir } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { readMeta, type SiteMeta } from "./meta.ts";

const withScheme = (host: string): string =>
  config.scheme === "http" ? `http://${host}` : host;

async function listSiteNames(): Promise<string[]> {
  try {
    const entries = await readdir(config.sitesDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function buildCaddyfile(names: string[], metaBySite: Record<string, SiteMeta>): string {
  const lines: string[] = [];

  lines.push("{");
  lines.push(`    admin ${config.caddyAdminListen}`);
  if (config.email) lines.push(`    email ${config.email}`);
  if (config.scheme === "http") lines.push("    auto_https off");
  lines.push("}");
  lines.push("");

  lines.push(`${withScheme(config.dashboardHost)} {`);
  lines.push(`    header {`);
  lines.push(`        X-Frame-Options "DENY"`);
  lines.push(`        X-Content-Type-Options "nosniff"`);
  lines.push(`        Referrer-Policy "strict-origin-when-cross-origin"`);
  lines.push(`        Permissions-Policy "interest-cohort=()"`);
  lines.push(`        -Server`);
  lines.push(`    }`);
  lines.push(`    reverse_proxy ${config.dashboardUpstream}`);
  lines.push(`    encode gzip`);
  lines.push("}");

  for (const name of names) {
    const root = path.join(config.sitesDir, name);
    const autoHost = `${name}.${config.baseDomain}`;
    const m = metaBySite[name];
    const customs = m?.customDomains ?? [];
    const hosts = [autoHost, ...customs].map(withScheme);
    lines.push("");
    lines.push(`${hosts.join(", ")} {`);
    if (m?.auth) {
      lines.push(`    basic_auth {`);
      lines.push(`        ${m.auth.user} ${m.auth.passwordHash}`);
      lines.push(`    }`);
    }
    lines.push(`    header {`);
    lines.push(`        X-Content-Type-Options "nosniff"`);
    lines.push(`        Referrer-Policy "strict-origin-when-cross-origin"`);
    lines.push(`        -Server`);
    lines.push(`    }`);
    lines.push(`    root * ${root}`);
    lines.push(`    encode gzip`);
    lines.push(`    try_files {path} /index.html`);
    lines.push(`    file_server`);
    lines.push("}");
  }

  return lines.join("\n") + "\n";
}

export async function syncCaddy(): Promise<void> {
  const names = await listSiteNames();
  const meta = await readMeta();
  const caddyfile = buildCaddyfile(names, meta.sites);

  const res = await fetch(`${config.caddyAdminUrl}/load`, {
    method: "POST",
    headers: { "content-type": "text/caddyfile" },
    body: caddyfile,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(
      `Caddy reload échoué (${res.status}): ${err.trim() || "réponse vide"}`
    );
  }
}
