import { promises as dns } from "node:dns";
import { readMeta } from "./meta.ts";

export interface DomainStatus {
  domain: string;
  site: string | null;
}

export async function listDomains(): Promise<DomainStatus[]> {
  const meta = await readMeta();
  const map = new Map<string, string | null>();
  for (const d of meta.knownDomains) {
    map.set(d.toLowerCase(), null);
  }
  for (const [siteName, m] of Object.entries(meta.sites)) {
    for (const d of m.customDomains ?? []) {
      map.set(d.toLowerCase(), siteName);
    }
  }
  return [...map.entries()]
    .map(([domain, site]) => ({ domain, site }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

export interface ResolveResult {
  ips: string[];
  ipv6: string[];
  error?: string;
}

export async function resolveDomain(domain: string): Promise<ResolveResult> {
  const result: ResolveResult = { ips: [], ipv6: [] };
  const errors: string[] = [];
  try {
    result.ips = await dns.resolve4(domain);
  } catch (err) {
    errors.push(`A: ${(err as Error).message}`);
  }
  try {
    result.ipv6 = await dns.resolve6(domain);
  } catch {
    /* IPv6 is optional; ignore */
  }
  if (result.ips.length === 0 && result.ipv6.length === 0) {
    result.error = errors.join("; ") || "Aucun enregistrement";
  }
  return result;
}
