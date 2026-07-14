import { jsonResponse, getDb, getUserByToken } from './_auth.js';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const token = request.headers.get('Authorization');
  if (!token) {
    return jsonResponse({ error: 'Missing token' }, 401);
  }

  const db = getDb(env);
  if (!db) {
    return jsonResponse({ error: 'D1 database binding is not configured' }, 500);
  }

  const user = await getUserByToken(db, token);
  if (!user) {
    return jsonResponse({ error: 'Invalid session' }, 401);
  }

  return jsonResponse({ username: user.username, createdAt: user.createdAt });
}
