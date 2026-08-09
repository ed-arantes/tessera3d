const ACCESS_COOKIE = "tessera_dev_access";
const ACCESS_TTL_SECONDS = 60 * 60 * 12;

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(value),
      ),
    ),
  );
}

function redirect(path, headers = {}) {
  return new Response(null, {
    status: 303,
    headers: { Location: path, ...headers },
  });
}

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!context.env.DEV_SITE_PASSWORD) {
    return new Response("Development password is not configured", { status: 500 });
  }

  const form = await context.request.formData();
  const password = String(form.get("password") || "");
  const returnTo = String(form.get("returnTo") || "/");
  const safeReturnTo =
    returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";

  const submittedHash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(password),
  );
  const configuredHash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(context.env.DEV_SITE_PASSWORD),
  );
  const submitted = toBase64Url(new Uint8Array(submittedHash));
  const configured = toBase64Url(new Uint8Array(configuredHash));

  if (submitted !== configured) {
    return new Response(
      "Incorrect password. <a href=\"/\">Try again</a>",
      {
        status: 401,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const payload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS,
      }),
    ),
  );
  const signature = await sign(payload, context.env.DEV_SITE_PASSWORD);

  return redirect(safeReturnTo, {
    "Set-Cookie":
      ACCESS_COOKIE +
      "=" +
      payload +
      "." +
      signature +
      "; Max-Age=" +
      ACCESS_TTL_SECONDS +
      "; Path=/; HttpOnly; Secure; SameSite=Lax",
    "Cache-Control": "no-store",
  });
}
