// Development-only server-side access gate.
// Set DEV_ACCESS_ENABLED to false before production deployment.
const DEV_ACCESS_ENABLED = true;
const ACCESS_COOKIE = "tessera_dev_access";
const ACCESS_TTL_SECONDS = 60 * 60 * 12;

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(value),
    ),
  );
}

async function verifyAccessCookie(request, secret) {
  if (!secret) return false;
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(
    new RegExp("(?:^|;\\s*)" + ACCESS_COOKIE + "=([^;]+)"),
  );
  if (!match) return false;

  try {
    const [payload, signature] = match[1].split(".");
    const actual = fromBase64Url(signature);
    const expected = await sign(payload, secret);
    if (actual.length !== expected.length) return false;

    let difference = 0;
    for (let i = 0; i < expected.length; i++) {
      difference |= actual[i] ^ expected[i];
    }
    if (difference !== 0) return false;

    const data = JSON.parse(
      new TextDecoder().decode(fromBase64Url(payload)),
    );
    return data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>\"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}

function lockPage(pathname) {
  const safePath = escapeHtml(pathname || "/");
  return [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>Tessera - Development Access</title>",
    "<style>",
    ":root{font-family:system-ui,sans-serif;color-scheme:light}",
    "*{box-sizing:border-box}",
    "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f7;color:#111827}",
    "main{width:min(400px,calc(100% - 32px));padding:32px;border:1px solid #e5e7eb;border-radius:16px;background:#fff;box-shadow:0 20px 50px #0f172a1f}",
    "h1{margin:0 0 8px;font-size:22px}p{margin:0 0 20px;color:#6b7280;font-size:14px}",
    "label{display:block;margin-bottom:6px;font-size:13px;font-weight:600}",
    "input{width:100%;padding:11px 12px;border:1px solid #d1d5db;border-radius:8px;font:inherit}",
    "button{width:100%;margin-top:14px;padding:11px 12px;border:0;border-radius:8px;background:#55ba08;color:#fff;font-weight:700;cursor:pointer}",
    "</style></head><body><main><h1>Development access</h1>",
    "<p>This development site is temporarily locked.</p>",
    "<form method=\"post\" action=\"/api/dev-unlock\">",
    "<input type=\"hidden\" name=\"returnTo\" value=\"" + safePath + "\">",
    "<label for=\"password\">Password</label>",
    "<input id=\"password\" name=\"password\" type=\"password\" autocomplete=\"current-password\" required autofocus>",
    "<button type=\"submit\">Unlock</button></form></main></body></html>",
  ].join("");
}

export async function onRequest(context) {
  if (!DEV_ACCESS_ENABLED) return context.next();

  const { request, env } = context;
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/dev-unlock") return context.next();
  if (await verifyAccessCookie(request, env.DEV_SITE_PASSWORD)) {
    return context.next();
  }

  return new Response(lockPage(pathname), {
    status: 401,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
