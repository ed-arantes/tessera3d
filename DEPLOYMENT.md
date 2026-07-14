Cloudflare Pages deployment (recommended)
=======================================

This project is intended to be deployed on Cloudflare Pages with Functions enabled. Pages will serve static files and automatically expose `functions/api/*.js` under `/api/*`.

Quick steps (Dashboard)
-----------------------
1. Go to the Cloudflare Dashboard → Pages → Create a project.
2. Connect your GitHub repo `tessera3d` and choose the branch you want to publish (e.g. `main`).
3. In the Build settings:
   - Framework preset: `None` (or leave blank)
   - Build command: leave empty
   - Build output directory: `.` (root of repo)
4. Functions directory: set to `functions` (this exposes `functions/api/*.js` at `/api/*`).
5. Environment variables / D1 binding:
   - If you are using a D1 database, add a D1 binding and name it `DB` (or `D1`). The worker code picks `env.DB` or `env.D1`.
   - If your D1 database uses a different name, set an environment variable mapping in Pages and ensure it matches one of `DB`, `D1`, `TESSERA`, `TESSERA_DB`, or `DATABASE`.
6. Deploy the project. After a few minutes your site will be available on `https://<project>.pages.dev`.

Test endpoints
--------------
- Health: `https://<project>.pages.dev/api/health` should return JSON: `{ "status": "ok", ... }`.
- Signup: POST to `https://<project>.pages.dev/api/signup` with JSON body `{ "username":"...", "password":"..." }`.

Local testing (Wrangler)
------------------------
You can test locally using Wrangler Pages dev. Install Wrangler locally (npx will run it without a global install):

```powershell
npm init -y
npm install --save-dev wrangler
npx wrangler pages dev . --bindings DB=<your-d1-name>
```

Notes and troubleshooting
-------------------------
- If the frontend is served from a different origin than Pages (e.g. `workers.dev`), the client must call the Pages origin. `auth.js` is already configured to use the same origin when `AUTH_URL` is blank.
- If you get 404 for `/api/*`, ensure the Functions directory is set to `functions` in the Pages project settings and that the correct branch was deployed.
- To verify the deployed JS is updated, open DevTools → Sources → look for `auth.js` and confirm it contains `parseResponse`.
- Ensure D1 bindings / environment variables are configured in the Pages project settings (Settings → Environment variables and secrets / Functions bindings).

If you want, I can generate a `wrangler.toml` for local testing or a small GitHub Actions workflow to automatically publish. Tell me which and I will add it.
