import { config } from "./config.ts";
import { API_TOKEN_PREFIX, findApiTokenBySecret } from "./meta.ts";

export async function checkAuth(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  const [scheme, token] = auth.split(" ");
  if (scheme !== "Bearer" || !token) return false;
  if (timingSafeEqual(token, config.password)) return true;
  if (token.startsWith(API_TOKEN_PREFIX)) {
    const found = await findApiTokenBySecret(token);
    return found !== undefined;
  }
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export const unauthorized = () =>
  new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
