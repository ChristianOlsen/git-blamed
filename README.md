# git blamed

A GitHub commit guessing game. Read a commit message, guess the author, then reveal their GitHub username.

## Run locally

Use **Node.js 22.18 or newer**.

```sh
npm install
npm run dev
```

Open [localhost:3000](http://localhost:3000), add GitHub usernames, and play with **real public commits**. No sign-in, OAuth app, or environment variables are required. The optional **demo uses fictitious commits and authors**; it never substitutes fake commits into a real game.

To optionally include private repositories, copy `.env.example` to `.env.local`, then:

1. Register your own **GitHub OAuth App** under GitHub → Settings → Developer settings → OAuth Apps.
2. Set its homepage to `http://localhost:3000` and authorization callback URL to `http://localhost:3000/api/auth/callback`.
3. Put its client ID and client secret in `.env.local`.
4. Generate a session encryption secret with `openssl rand -hex 32` and set `SESSION_SECRET` to that output (at least 32 characters). Do not commit or share either secret.
5. Set `APP_URL=http://localhost:3000`, restart the dev server, and sign in as the host.

When OAuth is configured, `APP_URL` is the trusted canonical origin, not a value inferred from request headers. It must have no path, query, or fragment. For a non-local environment, use HTTPS and update both `APP_URL` and the OAuth App callback accordingly. Environment variables are server-only; none use `NEXT_PUBLIC_`. Rotating `SESSION_SECRET` invalidates existing sessions. Without OAuth configuration, public games use the app request's own origin for same-origin protection.

## Play

- Enter **2–8 GitHub usernames**, separated by commas or new lines. GitHub usernames are used throughout; there are no display names. Only those accounts' linked author identities are eligible—not repository owners, raw author-name strings, or committers.
- Supply the entire list in the URL: `/?users=alice,bob,charlie`. Repeated `users` or `user` parameters also work, such as `/?users=alice&users=bob`. Starting a game updates the URL with the current list. Legacy `name` parameters are ignored.
- Start immediately with public commits. Optionally sign in as the host to include accessible private repositories, or choose the demo.
- Guess, reveal the author, then move on. **Enter / Space / Right / Down** advance the game; **Left / Up** revisit previous cards.
- Messages are ranked with local text heuristics and shuffled with a preference for expressive, short subjects. Only the first line is shown; explanatory bodies and author trailers stay out of the guessing screen. Obvious merge and automated dependency-update noise is filtered, while ordinary short messages can still appear. Text is capped at 1,000 characters.
- The game loads more pages as needed and avoids repeated SHAs and messages within the session. It stops honestly when the searchable source runs out rather than replaying messages or inventing replacements.

## Permissions and privacy

Without sign-in, GitHub requests omit the Authorization header and return **public data only**. Optional GitHub sign-in requests **`repo` and `read:user`**. The broad `repo` OAuth scope includes write capabilities even though **this app only reads GitHub data**; GitHub's classic OAuth scopes do not offer an equivalent read-only scope covering private repositories. Apart from the OAuth token exchange, the backend makes only GET requests to GitHub. It does not create commits, issues, repositories, or other remote content.

Private commits visible to the **host's account** can appear on the shared screen. Other players do not sign in and do not acquire independent GitHub permissions, but anyone using the signed-in browser can see the returned commit data. Play only with people authorized to see those repositories. Do not screen-share, record, or publicly host a signed-in game containing private work without permission. Commit subjects themselves can contain sensitive information. Avatars load from GitHub's image service, and opening a commit link sends you to GitHub.

The browser receives only the viewer profile and game data—not the plaintext GitHub token. The token is stored in an authenticated, encrypted **JWE HTTP-only cookie** with a fixed **12-hour** session lifetime, `SameSite=Lax`, and `Secure` on HTTPS. OAuth uses PKCE S256 and a separate encrypted, single-use-in-the-browser state cookie that expires after 10 minutes. Logout clears the browser cookies; it **does not revoke** the OAuth authorization at GitHub. You can revoke it in GitHub's application settings. If GitHub expires or revokes a token earlier, sign in again; this small app does not retain or rotate refresh tokens.

There is no database or application-side commit persistence. Loaded commits, guesses, and history live in client memory and are lost on refresh. Requests and sensitive responses use `no-store`; commit text is not sent to an AI service or logged by application code. Infrastructure operators can still control their own access logs and hosting environment.

Do not share a host account, session cookie, or session secret between unrelated groups. Signed-in games use the host's repository access. Public games share the server IP's anonymous GitHub quotas; signed-in games share quotas with other activity using that account. Changing players or starting another game does not reset those quotas. Public games stay public if someone signs in in another tab; private games prompt for reauthentication if their session expires rather than silently changing their search scope. This is a small, trusted-group app—not a multi-tenant service or an access-control boundary between people sharing a browser.

## Search limits: “endless” is not infinite

The app calls GitHub's **commit search API**, anonymously for public games or with the host's OAuth token for signed-in games, separately for each requested `author:username`, newest committer date first, with up to **100 results per page per user**.

- GitHub exposes **at most 1,000 results per search** (10 pages). A warning identifies this limit; the app never claims it has traversed complete repository history.
- Commit search depends on GitHub's search index and **default-branch** data. Unmerged feature branches, newly pushed or unindexed commits, inaccessible repositories, and commits without a matching linked GitHub author can be absent. This is not a `git log` over every branch.
- Search results are not a frozen snapshot. New commits, rebases, deleted repositories, and indexing changes can shift page boundaries while you play. Deduplication prevents repeat cards but cannot recover every commit displaced by a changing index.
- Even with `repo`, access depends on the host's actual permissions. Organization OAuth restrictions, approval requirements, and **SAML SSO authorization** can exclude private organization data. Authorize the OAuth App for the organization when required. Detectable partial SSO results are treated as an error; the app cannot detect every repository excluded by GitHub.
- Anonymous search generally permits **10 requests per minute per server IP**; authenticated search generally permits **30 requests per minute**, subject to GitHub's current primary and secondary limits. One batch can make one search request for each of up to eight active users. `Retry-After`/rate-reset headers are honored in surfaced retry information.
- Errors, rate limits, and GitHub's `incomplete_results` flag fail the **whole batch**. Cursors are unchanged on failure, so retrying does not silently skip a failed page. An empty filtered page can still have more pages to search.

These limits explain why a game can run out even when the users have more commits elsewhere on GitHub. Changing the player list can start a different search; it cannot bypass GitHub's indexing or access rules.

## Backend contract

- `GET /api/auth/github?returnTo=...` starts OAuth. `returnTo` allows only `/` and root query strings such as `/?users=alice,bob`, never an external URL.
- `GET /api/auth/callback` validates encrypted state and PKCE, exchanges the code, obtains the viewer, and returns to the app. Failures redirect to `/?authError=<safe message>`.
- `POST /api/auth/logout` clears session and state cookies, then redirects to `/` with status 303.
- `POST /api/commits` accepts JSON `{ "usernames": ["alice", "bob"], "cursors": {}, "requireAuth": false }` without sign-in. The API accepts 1–8 distinct valid usernames and normalizes them to lowercase; the game UI requires at least two. `requireAuth: false` pins the game to public results; `true` requires a valid host session. If omitted, an available session is used, otherwise the search is public.
- A successful batch is `{ commits, cursors, warnings, exhausted }`. Each commit is `{ id, message, author, avatarUrl, url, repository, committedAt }`, where `id` is the SHA and `author` is the verified lowercase linked author login.
- Each cursor is `{ page, exhausted }`: `page` is the **next** page, missing means page 1, and an exhausted cursor makes no request. Live pages are 1–10; an exhausted cursor may have page 11. Send returned cursors unchanged to continue. Requests may mention only their specified usernames.
- Failure responses are non-2xx JSON `{ error, retryAfter? }`; `retryAfter` is seconds and is also sent as an HTTP header. Never advance local cursors on an error. Identical warnings can recur across stateless requests; clients should deduplicate them.
- POST endpoints require `Origin` to exactly match `APP_URL` when OAuth is configured; otherwise public commit requests must match the app request's own origin. No credentialed CORS is enabled. Request bodies, usernames, pagination, upstream records, URLs, and response sizes are validated; upstream calls have timeouts.
- Server components use `getViewer(): Promise<Viewer | null>` and `isAuthConfigured(): boolean` from `src/lib/auth.ts`. Missing configuration allows public games and the demo to render unsigned-in.

## Development

The manifest pins **Next.js 16.3.5**, **React 19.3.0**, **Tailwind CSS 4.3.3**, and **jose 6.2.12**; `package.json` and the lockfile are authoritative.

```sh
npm run dev        # Development server
npm run build      # Production build
npm start          # Run the production build
npm run typecheck  # TypeScript
npm run lint       # Biome checks
npm run format     # Biome formatting
npm test           # Node's test runner with TypeScript stripping
```

Tests cover pure game helpers, encrypted auth/state handling, request validation, origin and redirect protections, local ranking, author attribution, pagination and caps, deduplication, and mocked GitHub/OAuth success/error responses. They require no real GitHub account or credentials.
