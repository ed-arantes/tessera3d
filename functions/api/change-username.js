import { jsonResponse, getDb, readJsonBody, hashPassword, createToken, getUserByToken, getUserByUsername, extractToken } from './_auth.js';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const body = await readJsonBody(request);
  const newUsername = (body?.newUsername || '').toString().trim();
  const password = (body?.password || '').toString();
  const token = extractToken(request);

  if (!newUsername || !password || !token) {
    return jsonResponse({ error: 'New username, password, and token are required' }, 400);
  }

  const db = getDb(env);
  if (!db) {
    return jsonResponse({ error: 'D1 database binding is not configured' }, 500);
  }

  const user = await getUserByToken(db, token);
  if (!user) {
    return jsonResponse({ error: 'Invalid session' }, 401);
  }

  const passwordHash = await hashPassword(password);
  if (user.passwordHash !== passwordHash) {
    return jsonResponse({ error: 'Incorrect password' }, 401);
  }

  const existingUser = await getUserByUsername(db, newUsername);
  if (existingUser && existingUser.username !== user.username) {
    return jsonResponse({ error: 'Username already exists' }, 409);
  }

  const newToken = createToken();
  await db.prepare('UPDATE users SET username = ?, token = ? WHERE LOWER(username) = LOWER(?)')
    .bind(newUsername, newToken, user.username)
    .run();

  return jsonResponse({ token: newToken, username: newUsername, createdAt: user.createdAt });
}
