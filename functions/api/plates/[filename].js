export async function onRequestGet(context) {
  const filename = context.params.filename;
  const key = `assets/plates/${filename}`;
  const obj = await context.env.R2.get(key);

  if (!obj) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Cache-Control", "public, max-age=60");

  return new Response(obj.body, { headers });
}
