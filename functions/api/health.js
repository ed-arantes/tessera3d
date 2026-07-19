import { jsonResponse } from "./_auth.js";

export async function onRequest() {
  return jsonResponse({ status: "ok", message: "Functions are reachable" });
}
