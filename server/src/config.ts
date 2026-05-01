const required = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var ${key}`);
  return v;
};

const baseDomain = required("MULTIWEB_BASE_DOMAIN");

export const config = {
  password: required("MULTIWEB_PASSWORD"),
  baseDomain,
  sitesDir: process.env.MULTIWEB_SITES_DIR ?? "/var/www/sites",
  caddyAdminUrl: process.env.MULTIWEB_CADDY_ADMIN_URL ?? "http://localhost:2019",
  caddyAdminListen: process.env.MULTIWEB_CADDY_ADMIN_LISTEN ?? "localhost:2019",
  scheme: (process.env.MULTIWEB_SCHEME ?? "https") as "http" | "https",
  email: process.env.MULTIWEB_EMAIL ?? "",
  port: Number(process.env.MULTIWEB_PORT ?? 3000),
  hostname: process.env.MULTIWEB_HOSTNAME ?? "127.0.0.1",
  maxUploadMb: Number(process.env.MULTIWEB_MAX_UPLOAD_MB ?? 100),
  dashboardHost: process.env.MULTIWEB_DASHBOARD_HOST || `dash.${baseDomain}`,
  dashboardUpstream: process.env.MULTIWEB_DASHBOARD_UPSTREAM ?? "127.0.0.1:3000",
};
