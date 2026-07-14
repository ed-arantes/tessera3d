import { jsonResponse, getDb, readJsonBody, hashPassword, createToken, getUserByUsername } from './_auth.js';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const body = await readJsonBody(request);
  const username = (body?.username || '').toString().trim();
  const password = (body?.password || '').toString();

  if (!username || !password) {
    return jsonResponse({ error: 'Username and password are required' }, 400);
  }

  const db = getDb(env);
  if (!db) {
    return jsonResponse({ error: 'D1 database binding is not configured' }, 500);
  }

  const existingUser = await getUserByUsername(db, username);
  if (existingUser) {
    return jsonResponse({ error: 'Username already exists' }, 409);
  }

  const passwordHash = await hashPassword(password);
  const token = createToken();
  const createdAt = new Date().toISOString();

  await db.prepare('INSERT INTO users (username, passwordHash, token, createdAt) VALUES (?, ?, ?, ?)')
    .bind(username, passwordHash, token, createdAt)
    .run();

  return jsonResponse({ token, username, createdAt });
}
