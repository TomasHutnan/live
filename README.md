# live

A small self-hosted service for presenting Quarto reveal.js decks at `live.hutnan.dev`.
Upload a built deck, share a link, and present from a password-protected page while drawing
on the slides. Viewers follow slide by slide and step by step. Afterwards, download the
annotated deck as one HTML file that works offline.

One process, one container, one presenter. SQLite and files under `/data`. No build tools
for decks: Quarto stays on your machine, and the server never runs anything you upload.

## Setup

You need Docker with Compose.

```sh
cp .env.example .env
docker compose run --rm --no-deps live npm run -s hash-password   # type a password, paste the line into .env
# set LIVE_ADMIN_USER and LIVE_PUBLIC_ORIGIN in .env
docker compose up -d --build
```

The app listens on `127.0.0.1:8090` only. Open `/dashboard` through your proxy, or directly on
the machine with `LIVE_PUBLIC_ORIGIN` left empty.

| Variable | Meaning |
| --- | --- |
| `LIVE_ADMIN_USER` | Presenter's username. Required. |
| `LIVE_ADMIN_PASSWORD_HASH` | Argon2id hash from `npm run hash-password`, in single quotes. Required. |
| `LIVE_PUBLIC_ORIGIN` | Exact site origin. Empty means "compare with the Host header". |
| `LIVE_TRUST_PROXY` | Peers allowed to set `X-Forwarded-*`. Default `loopback,uniquelocal`. |

If `LIVE_PUBLIC_ORIGIN` doesn't match the address in your browser, the dashboard's forms and
the WebSocket are refused. That check is deliberate.

## Caddy

The service has no TLS of its own and must run behind HTTPS. Add this to the Caddyfile:

```caddyfile
live.hutnan.dev {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8090
}
```

### With caddy-docker-proxy

`compose.vps.yaml` is the production setup and the only file the server needs. It uses the published
image, the shared `web` network, and labels for caddy-docker-proxy and homepage.

```sh
mkdir ~/live && cd ~/live
curl -fsSLo compose.yaml https://raw.githubusercontent.com/TomasHutnan/live/main/compose.vps.yaml
sudo install -d -o 1000 -g 1000 /home/deploy/data/live
docker run --rm -it ghcr.io/tomashutnan/live npm run -s hash-password
nano compose.yaml   # replace the LIVE_ADMIN_PASSWORD_HASH line with the printed compose line
docker compose up -d
```

To update, run `docker compose pull && docker compose up -d`. Every image is also tagged by commit
(`sha-1a2b3c4`), so to roll back, put that tag in `image:`. Tagging a release `v1.2.3` adds the tag `1.2.3`.

The hash line needs its doubled `$$` signs and no quotes: quotes in an `environment:` list become part
of the value, and every login then fails. The repository is public, so keep real hashes out of it.

The data directory must belong to uid 1000, the user inside the container. Backups read from
`/home/deploy/data/live` rather than the volume path below.

Every container on `web` counts as a trusted proxy under the default `LIVE_TRUST_PROXY`. That only
affects which client address the rate limit sees.

### Images

`.github/workflows/image.yml` runs all tests on every push, then publishes
`ghcr.io/tomashutnan/live` for amd64 and arm64 from `main` and `v*` tags. A failing test publishes nothing.

## Upload

From the dashboard, or at the end of a build:

```sh
curl -u tomas -F file=@index.html https://live.hutnan.dev/api/decks
```

`curl` asks for the password. The file must be the built, self-contained HTML
(`embed-resources: true`), at most 50 MB. A file with no `Reveal.initialize` is rejected, and
relative references to external files give a warning. Decks are immutable: a changed file makes
a new deck, so existing ink keeps its slide and step numbers. Uploading identical bytes reuses
the deck.

## Presenting

1. On the dashboard, pick a deck and create a session. Each seminar group gets its own session,
   with its own ink. The slug is suggested from the filename.
2. Show the viewer link or QR code. Open **Controls** on your laptop or tablet.
3. Choose a tool to draw. Keys keep working, and on a tablet use the arrows in the toolbar. The
   first button switches back to navigating, where a click or swipe drives the deck as usual.
   Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z redoes.
4. In a text box, Enter finishes, Shift+Enter starts a new line, and Esc cancels.
5. **Export** on the dashboard downloads `<slug>-<date>-annotated.html` as often as you like.

Ink belongs to the slide and step it was drawn on: it hides when you step back past that step
and returns when you step forward. A drop in Wi-Fi loses nothing. Ink and moves made offline
are sent after the reconnect.

Removing a session permanently deletes its ink, so the dashboard asks you to type the slug and
offers the export first. Decks can be deleted once no session uses them.

## Security notes

- **Speaker notes are public.** They are in the deck HTML that every viewer downloads. Don't put
  anything in them that you wouldn't put on a slide.
- **Viewer links are public.** Slugs are easy to guess, so treat every viewer page as open.
- **Only the owner may upload decks.** A deck is a web page that runs on the same origin as the
  dashboard, so it could use the browser's stored credentials.
- Basic auth is handled in the app, always behind HTTPS. There is no login page or logout. To log
  out, close the browser. Ten failed attempts from one address block it for five minutes, except
  for credentials that have already worked since the last restart, so someone guessing on a shared
  university address can't lock out the presenter.
- Non-GET requests with a foreign `Origin` are refused, as are WebSocket upgrades without a matching
  `Origin`. Requests with no `Origin`, like `curl`, still need the password.
- The container runs as a non-root user with a read-only filesystem. Only `/data` is writable.

## Backup

Everything is in `/data`: `live.db` and `decks/`. Copy the database with SQLite's backup command,
because a plain copy of a live WAL database can be inconsistent.

With `sqlite3` on the host (the default volume path is shown):

```sh
V=/var/lib/docker/volumes/live_live-data/_data
sqlite3 "$V/live.db" ".backup '/backup/live.db'"
cp -r "$V/decks" /backup/
```

Or from inside the container, with no `sqlite3` needed:

```sh
docker compose exec live node -e "require('better-sqlite3')('/data/live.db').backup('/data/backup.db').then(()=>console.log('ok'))"
docker compose cp live:/data/backup.db ./live.db
docker compose cp live:/data/decks ./decks
docker compose exec live rm /data/backup.db
```

To restore, stop the service, put `live.db` and `decks/` back in the volume, and start it.
Files must belong to uid 1000.

## Development

Requires Node 26. Everything else comes from npm.

```sh
npm ci
npm run typecheck
npm test                # unit tests
npm run test:e2e        # Playwright on the real fixture deck, in Chromium
```

To run locally, create `.env` with `LIVE_DATA_DIR=./data`, `HOST=127.0.0.1` and an empty
`LIVE_PUBLIC_ORIGIN`, then run `npm run dev`.

The controls flow also runs in WebKit. Playwright's WebKit needs Ubuntu libraries, so on other
hosts use the official image, whose tag must match the installed `@playwright/test`:

```sh
npm run build
docker run --rm --network host --ipc=host -v "$PWD":/work -w /work -e LIVE_E2E_WEBKIT=1 -e HOME=/tmp \
  --user "$(id -u):$(id -g)" mcr.microsoft.com/playwright:v1.64.1-noble \
  npx playwright test --project=webkit --output=/tmp/pw
```

### Layout

- `src/server`: Fastify routes (`app.ts`), rooms and the per-role dispatch tables (`rooms.ts`), SQLite (`store.ts`).
- `src/shared`: the wire protocol, step rule and slug rules, used by both sides.
- `src/client/overlay.ts`: ink rendering, shared by the live client and the export.
- `src/client/live-client.ts`: the script injected into decks. The URL picks viewer, controls or preview.
- `migrations/NNN_name.sql`: numbered migrations, applied in order at startup.

### Tuning pen feel

Stroke smoothing, batching, highlighter look and reconnect timing are all in
`src/client/tuning.ts`. `PEN_SHAPE` holds the `perfect-freehand` options, and `STROKE_BATCH_MS` sets
how often live points go out.

### Realtime protocol

JSON messages with a protocol version `v` and a type `t`. Slide indices sit in a nested `position`
or `slide` object so their `v` can't collide with the version. Beyond the core types, the server
sends `ack` for each position or mutation it has applied and `pong` for each `ping`. A browser can't
see WebSocket ping frames, so `pong` is how a client notices a dead connection.

Live `stroke.start` and `stroke.points` are best-effort previews. `stroke.end` carries the whole
stroke and sits in the outbox until acknowledged, so losing a preview batch loses no ink.
Close codes: 4400 invalid message, 4401 bad token, 4403 viewer sent a presenter message, 4404 no such
session, 4410 session removed.

### Adding audience questions

Sessions are the unit of live state, so questions belong to a session in a new migration. New
`question.*` types go in the dispatch tables in `rooms.ts`. `viewerHandlers` is the single path for
everything a viewer can trigger, so rate limits, length limits and validation belong there. The
side panel is a flex column, so another section can join it. Render question text with
`textContent`.
