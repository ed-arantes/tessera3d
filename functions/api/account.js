import { jsonResponse, getDb, readJsonBody, hashPassword, getUserByToken, extractToken } from './_auth.js';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'DELETE') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const body = await readJsonBody(request);
  const password = (body?.password || '').toString();
  const token = extractToken(request);

  if (!token || !password) {
    return jsonResponse({ error: 'Token and password are required' }, 400);
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

  await db.prepare('DELETE FROM users WHERE username = ?').bind(user.username).run();

  return jsonResponse({ ok: true });
}
