import { API_TOKEN_PREFIX, findApiTokenBySecret } from "./meta.ts";
import { SESSION_PREFIX, validateSession } from "./sessions.ts";

export async function checkAuth(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  const [scheme, token] = auth.split(" ");
  if (scheme !== "Bearer" || !token) return false;

  if (token.startsWith(SESSION_PREFIX)) {
    return validateSession(token);
  }
  if (token.startsWith(API_TOKEN_PREFIX)) {
    const found = await findApiTokenBySecret(token);
    return found !== undefined;
  }
  return false;
}

export const unauthorized = () =>
  new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
