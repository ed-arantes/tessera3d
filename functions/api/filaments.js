import { jsonResponse, getDb } from "./_auth.js";

export async function onRequest(context) {
  const db = getDb(context.env);
  if (!db) {
    return jsonResponse({ error: "Database not available" }, 500);
  }

  try {
    const { results } = await db
      .prepare(
        "SELECT id, brand, material, name, hex, td FROM filaments ORDER BY brand, name",
      )
      .all();

    return jsonResponse({ ok: true, filaments: results });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to fetch filaments", details: err.message },
      500,
    );
  }
}
