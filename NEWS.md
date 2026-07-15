# News feed

**Note:** The launcher no longer uses a static `news.json` file. The News tab now pulls live from the OctoWoW announcements forum via the website's `/news.json` endpoint, which is backed by `ForumFeedService` on the Laravel side. To publish a news item in the launcher, simply post in the configured announcements forum — the launcher will pick it up within the cache TTL (default 10 minutes). There is no JSON file to edit or deploy.

The launcher's News tab fetches `${MAIN_VITE_SERVER_URL}/news.json` and renders the entries on the landing screen. The endpoint is dynamic: it mirrors the same forum posts the website's homepage shows in its "Recent forum posts" cards, so updating the forum updates the launcher.

## Endpoint

`GET ${MAIN_VITE_SERVER_URL}/news.json` → `200 application/json`

`MAIN_VITE_SERVER_URL` comes from [main/.env](.env) at build time. With the current production setup that resolves to the public site origin (e.g. `https://octowow.st/news.json`).

The route is served by Laravel (`routes/web.php` → `news.json`) and reads from `App\Services\ForumFeedService`, which fetches the configured phpBB Atom feed (`FORUM_FEED_BASE_URL`/`FORUM_FEED_MODE`/`FORUM_FEED_FORUM_ID` in `config/customs.php` → `forum_feed`). The same service backs the homepage's `recent-forum-posts` Livewire component, so what shows in the launcher is exactly what shows on the site.

No auth. The launcher times out after 8 seconds and validates the body against the schema below — malformed payloads surface as the "Couldn't reach the news feed" error state (with a Try again button).

## Payload contract

```jsonc
{
  "items": [
    {
      "id": "2026-04-24-launch",        // required, stable, used as React key
      "title": "Welcome to the new client",  // required
      "date": "2026-04-24",             // required, anything Date.parse() accepts
      "body": "Multi-line\nbody text supported.",  // required, \n preserved
      "author": "example",               // optional
      "url": "https://example.com/changelog"  // optional, must be a full URL
    }
  ]
}
```

Source of truth for the schema: [src/common/schemas.ts](src/common/schemas.ts) (`NewsItemSchema`, `NewsFeedSchema`). If you change the contract, update both ends.

Notes:
- `items` is rendered in the order returned — sort newest-first on the server.
- `body` is rendered as plain text with `whitespace-pre-wrap`. No HTML/markdown.
- `url`, when present, becomes a "Read more" button that opens in the user's default browser via `shell.openExternal`. Skip it for inline-only posts.
- `id` should never change for an existing post (stable React keys, future bookmarking/read-state).

## Publishing

There is no static file to edit anymore. To change what the launcher shows, post on the forum (`FORUM_FEED_BASE_URL`, e.g. `https://octowow.st/forum`). The next launcher fetch picks it up subject to two cache layers:

- `forum_feed.cache_ttl` (default 600 s, env `FORUM_FEED_CACHE_TTL`) — Laravel server-side cache of the parsed Atom feed.
- `Cache-Control: public, max-age=120` on the `/news.json` response — short edge cache so launcher launches in a burst don't all hit Laravel.

The launcher's react-query cache also holds for 5 minutes per session; users can hit the refresh icon in the News header to force a re-fetch (which still hits the two cache layers above).

### Tuning what shows

- **Which forum / mode shows**: set `FORUM_FEED_MODE` (`topics_active` | `topics` | `news` | `forum`) and, if `forum`, `FORUM_FEED_FORUM_ID` in the website container's environment.
- **How fresh**: lower `FORUM_FEED_CACHE_TTL` for fresher news at the cost of more upstream forum fetches. Pair with the route's 120-second `Cache-Control` if you also want to relax the edge cache.
- **How many items**: the route currently caps at 10; the homepage shows 3. Edit the `recent(10)` argument in `routes/web.php` → `news.json` to change the launcher cap independently of the homepage.

## Testing

**Confirm Laravel is serving it:**

```bash
curl -s ${MAIN_VITE_SERVER_URL}/news.json | jq .
```

Expected: a `{"items": [...]}` body. An empty `items: []` means the forum feed is reachable but has nothing matching the configured mode (or the cache is still warm with an empty result — bust it by `php artisan cache:clear` inside the website container, or wait `FORUM_FEED_CACHE_TTL` seconds).

**No items / errors:**
- `{"items": []}` — `FORUM_FEED_BASE_URL` is unset, the feed returned non-2xx, the body wasn't parseable Atom XML, or the configured forum has no posts. Check the website container's `storage/logs/laravel.log` for `ForumFeedService` warnings.
- `Couldn't reach the news feed` in the launcher — Laravel returned a 5xx (route exception, missing `ForumFeedService` binding) or the schema validator rejected the body. Check the launcher's main-process log at `%APPDATA%\octo-launcher\logs\main.log` for `Malformed news feed`.

**End-to-end check in the launcher:**
1. Open the launcher (the News tab is the default view when no other tab is selected).
2. Click the refresh icon in the News header.
3. Entries should appear within ~1 second once Laravel + the forum cache are warm.

## Failure modes the launcher already handles

| Server response | UI behaviour |
| --- | --- |
| `200` with valid JSON | Renders entries |
| `200` with empty `items: []` | "No news yet — check back later." |
| `200` with malformed JSON or missing required fields | Error state + Try again. Reason logged in main-process logs (`%APPDATA%\octo-launcher\logs\main.log`). |
| `404`, `5xx`, network unreachable, > 8s timeout | Error state + Try again. |

You don't need to ship a placeholder `news.json` to avoid 404s — the empty/error state is intentional.

## Where the code lives

- Main-process fetcher + schema validation: [src/main/api/routers/news.ts](src/main/api/routers/news.ts)
- Schema: [src/common/schemas.ts](src/common/schemas.ts) (`NewsItemSchema`, `NewsFeedSchema`)
- Renderer UI: [src/renderer/components/tabs/NewsTab.tsx](src/renderer/components/tabs/NewsTab.tsx)
- Router wiring: [src/main/api/root.ts](src/main/api/root.ts) (`news`)
