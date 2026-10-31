# live

Self-hosted live presentation service for Quarto reveal.js decks, at `live.hutnan.dev`. The owner
uploads a built HTML deck, the audience follows at `/<slug>`, and the owner presents and draws from
`/controls/<slug>`, then downloads the annotated deck. One presenter, 15-40 viewers, Slovak seminars.
It's a small personal tool, so don't build for scale.

Read this file first, then only the files the task needs. `README.md` covers setup, deployment,
backup and the protocol in more detail.

## Current state

Keep this section short and true. `/live-start handoff` updates it.

- Built, pushed to `origin/main`, and running on the VPS from `ghcr.io/tomashutnan/live:latest`.
- VPS: caddy-docker-proxy and homepage, both label-driven, on the external `web` network. Data in
  `/home/deploy/data/live`, owned by uid 1000.
- Untested: pen feel on a real tablet, a real iPad or phone, and 40 real browsers on Wi-Fi.

## Rules from the owner

- Commit or push only when asked. The owner often commits and pushes themselves.
- Never touch the VPS, DNS or Caddy config without explicit go-ahead. Give commands to run instead.
- The repository is public: no real hashes, passwords or tokens in any file.
- Out of scope unless asked: `.qmd` upload, Quarto or Chromium in the image, PDF export, multiple
  users or roles, recording, cookies or a login page.
- Don't change the `lean` Quarto extension. The service must work on unmodified decks.
- Audience questions are planned but unbuilt. Add no placeholder UI, tables or endpoints. The seams are
  in README's "Adding audience questions".

## Commands

The shell's default Node is 24, so prefix everything with `mise exec node@26 --`.

```sh
mise exec node@26 -- npm ci --ignore-scripts
mise exec node@26 -- npm run typecheck
mise exec node@26 -- npm test                  # unit tests, about 1 s
mise exec node@26 -- npm run test:e2e          # builds, then Chromium, about 30 s
mise exec node@26 -- npx playwright test ink.spec --project=chromium -g "pen pressure"
```

e2e tests run `dist/`, so use `test:e2e` or `npm run build` after changing `src/`, not a bare
`playwright test`. A focused test run is enough while working. Run everything before finishing.

WebKit won't run directly on this Fedora host. After a build, use the official image, whose tag must
match the installed `@playwright/test`:

```sh
docker run --rm --network host --ipc=host -v "$PWD":/work -w /work -e LIVE_E2E_WEBKIT=1 -e HOME=/tmp \
  --user "$(id -u):$(id -g)" mcr.microsoft.com/playwright:v1.64.1-noble \
  npx playwright test --project=webkit --output=/tmp/pw
```

## Where things are

| Need | File |
| --- | --- |
| HTTP routes, Origin hook, WebSocket route, export route | `src/server/app.ts` |
| Rooms, tokens, per-role dispatch tables, heartbeat | `src/server/rooms.ts` |
| SQLite queries | `src/server/store.ts` |
| Basic auth, login rate limit | `src/server/auth.ts` |
| Upload and deck files | `src/server/decks.ts` |
| Injection, export assembly, deck inspection | `src/server/inject.ts` |
| Env vars | `src/server/config.ts` |
| Schema changes | new `migrations/NNN_name.sql`, applied at startup |
| Wire types, validators, close codes | `src/shared/protocol.ts` |
| Step rule | `src/shared/step.ts` |
| Slug rules | `src/shared/slug.ts` |
| Client entry, role chosen from the URL | `src/client/live-client.ts` |
| Ink rendering, shared with the export | `src/client/overlay.ts` |
| Outbox, undo, redo | `src/client/ink.ts` |
| Pointer input, palm rejection, text editor | `src/client/pen.ts` |
| Toolbar, side panel, presenter sync | `src/client/controls.ts` |
| Follow, browse, Slovak strings | `src/client/viewer.ts` |
| Next-step frame | `src/client/preview.ts` |
| Reconnect, heartbeat | `src/client/connection.ts` |
| Pen feel, batching, reconnect timing | `src/client/tuning.ts` |
| Styles | `src/client/live.css`, `src/client/dashboard.css` |
| Test helpers, `ownServer`, cuttable `Proxy` | `tests/e2e/harness.ts` |
| Real fixture deck, 5 MB, never read it whole | `tests/fixtures/pb016-cv05.html` |
| Publishing the image | `.github/workflows/image.yml` |
| Local compose | `compose.yaml` |
| Production compose, values from `.env` | `compose.vps.yaml` |

## Conventions

- TypeScript with `.ts` import paths. esbuild bundles the server to `dist/server.js` and the browser
  code to `dist/public/`. Vanilla DOM, no framework.
- Commit subjects are plain imperative sentences. The owner also uses `feat:`.
- Text the audience sees goes in `STRINGS` in `viewer.ts`, in Slovak and English, chosen by the deck's
  `lang`. Dashboard and controls are English.
- New behaviour gets a test. Protocol rules go in `tests/unit/rooms.test.ts`, browser behaviour in e2e.
- Tests that stop a server or change its env use the `ownServer` fixture, which always cleans up.

## Things that must stay true

- Step rule: `step = getIndices().f ?? -1`. An item shows when the slide matches and `currentStep >=
  item.step`. Use reveal's state and never count fragments: `lean` rewrites their indices during init.
- Slide indices are always nested (`position`, `slide`) in messages, because the top-level `v` is the
  protocol version.
- `stroke.start` and `stroke.points` are best-effort previews. `stroke.end` carries the whole stroke,
  and every mutation is idempotent by item id and sits in the outbox until `ack`.
- `slide.clear` names its ids, so a resend can't erase ink drawn later.
- `leave()` drops only strokes still in `room.live`: a reconnected presenter may have finished one
  on a new socket before the old socket closes.
- Render ink text with `textContent`, never `innerHTML`. `viewerHandlers` is the only path from viewers.
- Inject before the last `</body>` only. Export starts from the original deck, not the served copy.
- Keep `keepSlideView()`: below 435 px reveal switches to scroll view, which breaks phones in portrait
  and the preview frame.
- Keep `etagMatches`: Caddy's `encode` adds `-zstd` to ETags.
- Credentials that already passed stay exempt from the login lockout, because a university shares one IP.

## Caveats

- Stored decks hold `CLIENT_TAG`, so changing it doesn't affect decks already uploaded. Client code
  changes reach them through `/assets/live-client.js`.
- `compose.vps.yaml` holds only `${VAR}` placeholders, and real values stay in `.env` on the VPS.
- Compose expands `$`. In `.env` use the single-quoted line. In an `environment:` list use doubled `$$`
  and no quotes. A wrong form gives a plain 401. `read -rs` plus `argon2.verify` inside the container
  separates a bad hash from a browser problem.
- A bind-mounted `/data` must be owned by uid 1000, or startup fails with `SQLITE_CANTOPEN`.
- `npm ci` needs `--ignore-scripts` in clean environments: `better-sqlite3` bundles prebuilds, and its
  install script fails without a compiler.
- `kill` on a `mise exec` background job stops the wrapper, not node. Start servers with the real node
  path or kill the PID found through `ss -ltnp`. Broad `pkill` patterns get denied.
- One-off `ws` scripts need `process.exit()`: a refused socket keeps node alive and blocks later steps.
- Tool limits here: no `gh`, no `script`, no `sqlite3`. Use `curl` for the GitHub API and Python's `pty`
  to test prompts.
- `git push` is the only trigger for publishing: the workflow tests, then pushes `latest`. The VPS picks
  it up with `docker compose pull && docker compose up -d`.
