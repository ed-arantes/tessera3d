import { jsonResponse, getDb, readJsonBody, hashPassword, createToken, getUserByToken } from './_auth.js';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const body = await readJsonBody(request);
  const currentPassword = (body?.currentPassword || '').toString();
  const newPassword = (body?.newPassword || '').toString();
  const token = request.headers.get('Authorization');

  if (!currentPassword || !newPassword || !token) {
    return jsonResponse({ error: 'Current password, new password, and token are required' }, 400);
  }

  const db = getDb(env);
  if (!db) {
    return jsonResponse({ error: 'D1 database binding is not configured' }, 500);
  }

  const user = await getUserByToken(db, token);
  if (!user) {
    return jsonResponse({ error: 'Invalid session' }, 401);
  }

  const currentPasswordHash = await hashPassword(currentPassword);
  if (user.passwordHash !== currentPasswordHash) {
    return jsonResponse({ error: 'Incorrect password' }, 401);
  }

  const newPasswordHash = await hashPassword(newPassword);
  const newToken = createToken();
  await db.prepare('UPDATE users SET passwordHash = ?, token = ? WHERE username = ?')
    .bind(newPasswordHash, newToken, user.username)
    .run();

  return jsonResponse({ token: newToken, username: user.username, createdAt: user.createdAt });
}
