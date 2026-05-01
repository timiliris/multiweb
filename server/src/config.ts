const required = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var ${key}`);
  return v;
};

export const config = {
  password: required("MULTIWEB_PASSWORD"),
  baseDomain: required("MULTIWEB_BASE_DOMAIN"),
  sitesDir: process.env.MULTIWEB_SITES_DIR ?? "/var/www/sites",
  caddySitesDir: process.env.MULTIWEB_CADDY_SITES_DIR ?? "/etc/caddy/sites.d",
  caddyConfigPath: process.env.MULTIWEB_CADDY_CONFIG ?? "/etc/caddy/Caddyfile",
  port: Number(process.env.MULTIWEB_PORT ?? 3000),
  maxUploadMb: Number(process.env.MULTIWEB_MAX_UPLOAD_MB ?? 100),
};
