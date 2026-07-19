import {
  jsonResponse,
  getDb,
  readJsonBody,
  hashPassword,
  createToken,
  getUserByUsername,
} from "./_auth.js";

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const body = await readJsonBody(request);
  const username = (body?.username || "").toString().trim();
  const password = (body?.password || "").toString();

  if (!username || !password) {
    return jsonResponse({ error: "Username and password are required" }, 400);
  }

  const db = getDb(env);
  if (!db) {
    return jsonResponse(
      { error: "D1 database binding is not configured" },
      500,
    );
  }

  const user = await getUserByUsername(db, username);
  if (!user) {
    return jsonResponse({ error: "Invalid username or password" }, 401);
  }

  const passwordHash = await hashPassword(password);
  if (user.passwordHash !== passwordHash) {
    return jsonResponse({ error: "Invalid username or password" }, 401);
  }

  const token = createToken();
  await db
    .prepare("UPDATE users SET token = ? WHERE LOWER(username) = LOWER(?)")
    .bind(token, username)
    .run();

  return jsonResponse({
    token,
    username: user.username,
    createdAt: user.createdAt,
  });
}
