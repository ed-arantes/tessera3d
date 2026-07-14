export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

export function getDb(env) {
  return env.DB || env.D1 || env.TESSERA || env.TESSERA_DB || env.DATABASE;
}

export async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function createToken() {
  return crypto.randomUUID();
}

export async function getUserByUsername(db, username) {
  return db.prepare('SELECT username, passwordHash, token, createdAt FROM users WHERE LOWER(username) = LOWER(?)')
    .bind(username)
    .first();
}

export async function getUserByToken(db, token) {
  return db.prepare('SELECT username, passwordHash, token, createdAt FROM users WHERE token = ?')
    .bind(token)
    .first();
}

export function extractToken(request) {
  const header = request.headers.get('Authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return header.trim() || null;
}
