# tools/browse — Claude's browser tooling

Isolated Playwright setup so Claude can:

- Open the Janus web app (production or a preview URL) and take screenshots / read DOM
- Drive Home Assistant via its REST/websocket API using a Long-Lived Access Token (LLAT)

This directory is **completely separate** from the main app's `package.json`. Standard
production installs never see Playwright or its browser binaries.

## First-time setup (per fresh container)

```bash
cd tools/browse
npm install
npm run install:browsers     # downloads chromium (~150MB) into ms-playwright cache
```

In Claude Code on the web, the container is ephemeral, so this runs again at the
start of each session. A SessionStart hook can automate it — see the root
`.claude/` config (if present) or ask Claude to add one.

## Environment

Create `tools/browse/.env` (gitignored). Example:

```
APP_URL=http://localhost:5000
HA_BASE_URL=https://your-ha.example.com
HA_TOKEN=ey...your_long_lived_access_token...
```

`HA_TOKEN` is a Home Assistant Long-Lived Access Token. Create one in HA at:
**Profile → Security → Long-Lived Access Tokens → Create Token**. Treat it like
a password — it grants full API access to your HA instance.

## Scripts

- `npm run open -- <url> [--state <path>]` — open a URL in headless chromium,
  save a full-page screenshot to `screenshots/` and dump `<title>` + console
  errors. Pass `--state` to reuse a captured login session (see below).
- `npm run capture -- <url> [--out <path>]` — **run this locally on your
  laptop, not in the cloud container.** Opens a real Chrome window so you can
  sign in by hand, then writes a Playwright `storageState` JSON. Default
  output: `tools/browse/.state/<host>.json` (gitignored).
- `npm run ha:ping` — hit `GET /api/` on your HA instance with the token to
  verify connectivity.

## Capturing a login session (storageState)

Auth flows (Google OAuth, MFA, magic links) are hostile to headless browsers
and must not be scripted. Instead, sign in once in a real browser window and
save the cookies + localStorage as a JSON file. Then headless chromium can
reuse it.

**On your laptop:**

```bash
git clone <this repo>
cd tools/browse
npm install
npm run install:browsers
npm run capture -- https://example.com --out janus.json
# (a Chrome window opens; sign in; come back to the terminal; press Enter)
```

That writes `janus.json` (a small JSON file with cookies + storage). Upload
it to the cloud Claude session. Claude stores it under `tools/browse/.state/`
(gitignored) and screenshots run with `--state .state/janus.json`.

### Notes

- **example.com** uses standard cookie auth → storageState works cleanly.
- **Home Assistant** stores auth in IndexedDB, which `storageState` does NOT
  capture. Browser-UI screenshots of HA from a fresh container won't be
  authenticated even with a captured state file; use the REST API
  (`ha:ping` and friends) for verification instead, or capture state and
  immediately screenshot from the same machine without closing the browser.
- A storageState file is a session cookie — treat it like a password. It
  expires when the underlying session expires (days to months depending on
  the site); regenerate when screenshots start showing a login screen.

Add more scripts in `scripts/` as needed (logging in, clicking through a flow,
checking an automation, etc.).
