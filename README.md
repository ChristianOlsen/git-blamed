# git blamed

A GitHub commit guessing game. Read a commit message, guess the author, then reveal their GitHub username.

## Run locally

Use **Node.js 22.18 or newer**.

```sh
npm install
npm run dev
```

Open [localhost:3000](http://localhost:3000), add GitHub usernames, and play with **real public commits**. No configuration or sign-in is required. The optional **demo uses fictitious commits and authors**; it never substitutes fake commits into a real game.

## Optional GitHub connection

Click **Connect GitHub** and paste a personal access token. No environment configuration is needed. The app validates the token with GitHub and uses its repository access for subsequent games.

- Create a token in [GitHub settings](https://github.com/settings/tokens). Prefer limited, read-only repository access and a short expiration.
- For a fine-grained token, select the organization as the resource owner and include the repositories you want to use. Organization approval may be required.
- A classic token needs the broad `repo` scope for private repositories. For SSO-protected organizations, use **Configure SSO** in GitHub's token settings to authorize the organization.
- The token is kept only in browser memory for this page, never in local storage, session storage, cookies, or URLs. Refreshing or signing out clears it. The backend receives it only to validate it or make GitHub API requests, without persisting it.
- Use only a trusted instance of this app. Tokens are available to JavaScript on the page and to the server handling requests. HTTPS is required outside localhost.

## Play

- Enter **2–8 GitHub usernames**, separated by commas or new lines. GitHub usernames are used throughout; there are no display names. Only those accounts' linked author identities are eligible—not repository owners, raw author-name strings, or committers.
- Supply the entire list in the URL: `/?users=alice,bob,charlie`. Repeated `users` or `user` parameters also work, such as `/?users=alice&users=bob`. Starting a game updates the URL with the current list. Legacy `name` parameters are ignored.
- Start immediately with public commits. Optionally connect the host's token to include accessible private repositories, or choose the demo.
- Guess, reveal the author, then move on. **Enter / Space / Right / Down** advance the game; **Left / Up** revisit previous cards.
- Messages are ranked with local text heuristics and shuffled with a preference for expressive, short subjects. Only the first line is shown; explanatory bodies and author trailers stay out of the guessing screen. Obvious merge and automated dependency-update noise is filtered, while ordinary short messages can still appear. Text is capped at 1,000 characters.
- The game loads more pages as needed and avoids repeated SHAs and messages within the session. It stops honestly when the searchable source runs out rather than replaying messages or inventing replacements.

## Permissions and privacy

Without a connection, GitHub requests omit the Authorization header and return **public data only**. Personal tokens use the permissions assigned to them. A classic token's broad `repo` scope includes write capabilities even though **this app only reads GitHub data**; classic tokens do not offer an equivalent read-only scope covering private repositories. The backend makes only GET requests to GitHub. It does not create commits, issues, repositories, or other remote content.

Private commits visible to the **host's account** can appear on the shared screen. Other players do not sign in and do not acquire independent GitHub permissions, but anyone using the connected browser can see the returned commit data. Play only with people authorized to see those repositories. Do not screen-share, record, or publicly host a connected game containing private work without permission. Commit subjects themselves can contain sensitive information. Avatars load from GitHub's image service, and opening a commit link sends you to GitHub.

Tokens remain in browser memory and are sent to this app's backend in an Authorization header for commit requests. Signing out clears the local token and profile immediately, without a server request. It **does not revoke** the token at GitHub; revoke it separately in GitHub's settings. There are no server-side sessions or authentication cookies.

There is no database or application-side commit persistence. Loaded commits, guesses, and history live in client memory and are lost on refresh. Requests and sensitive responses use `no-store`; commit text is not sent to an AI service or logged by application code. Infrastructure operators can still control their own access logs and hosting environment.

Do not share a host account or token between unrelated groups. Connected games use the token's repository access. Public games share the server IP's anonymous GitHub quotas; connected games share quotas with other activity using that account. Changing players or starting another game does not reset those quotas. Public games stay public; private games prompt for reconnection if their token expires rather than silently changing their search scope. This is a small, trusted-group app—not a multi-tenant service or an access-control boundary between people sharing a browser.

## Search limits: “endless” is not infinite

The app calls GitHub's **commit search API**, anonymously for public games or with the host's personal access token for connected games, separately for each requested `author:username`, newest committer date first, with up to **100 results per page per user**.

- GitHub exposes **at most 1,000 results per search** (10 pages). A warning identifies this limit; the app never claims it has traversed complete repository history.
- Commit search depends on GitHub's search index and **default-branch** data. Unmerged feature branches, newly pushed or unindexed commits, inaccessible repositories, and commits without a matching linked GitHub author can be absent. This is not a `git log` over every branch.
- Search results are not a frozen snapshot. New commits, rebases, deleted repositories, and indexing changes can shift page boundaries while you play. Deduplication prevents repeat cards but cannot recover every commit displaced by a changing index.
- Access depends on the host's actual permissions and the token's repository access. Organization token restrictions, approval requirements, and **SSO authorization** can exclude private organization data. Authorize the token for the organization when required. Detectable partial SSO results are treated as an error; the app cannot detect every repository excluded by GitHub.
- Anonymous search generally permits **10 requests per minute per server IP**; authenticated search generally permits **30 requests per minute**, subject to GitHub's current primary and secondary limits. One batch can make one search request for each of up to eight active users. `Retry-After`/rate-reset headers are honored in surfaced retry information.
- Errors, rate limits, and GitHub's `incomplete_results` flag fail the **whole batch**. Cursors are unchanged on failure, so retrying does not silently skip a failed page. An empty filtered page can still have more pages to search.

These limits explain why a game can run out even when the users have more commits elsewhere on GitHub. Changing the player list can start a different search; it cannot bypass GitHub's indexing or access rules.

## Backend contract

- `POST /api/auth/token` validates JSON `{ "token": "..." }` using GitHub's `/user` endpoint and returns only `{ login, avatarUrl }`. It does not create a cookie or retain the token.
- `POST /api/commits` accepts JSON `{ "usernames": ["alice", "bob"], "cursors": {}, "requireAuth": false }` without sign-in. The API accepts 1–8 distinct valid usernames and normalizes them to lowercase; the game UI requires at least two. `requireAuth: false` pins the game to public results; `true` requires an `Authorization: Bearer ...` header. When `requireAuth` is omitted, a supplied token is used, otherwise the search is public. Rejected tokens never fall back to public access.
- A successful batch is `{ commits, cursors, warnings, exhausted }`. Each commit is `{ id, message, author, avatarUrl, url, repository, committedAt }`, where `id` is the SHA and `author` is the verified lowercase linked author login.
- Each cursor is `{ page, exhausted }`: `page` is the **next** page, missing means page 1, and an exhausted cursor makes no request. Live pages are 1–10; an exhausted cursor may have page 11. Send returned cursors unchanged to continue. Requests may mention only their specified usernames.
- Failure responses are non-2xx JSON `{ error, retryAfter? }`; `retryAfter` is seconds and is also sent as an HTTP header. Never advance local cursors on an error. Identical warnings can recur across stateless requests; clients should deduplicate them.
- Requests must come from the app's own origin. Token requests also require HTTPS (HTTP is permitted on localhost only). No credentialed CORS is enabled. Request bodies, usernames, pagination, upstream records, URLs, and response sizes are validated; upstream calls have timeouts.

## Development

The manifest pins **Next.js 16.3.5**, **React 19.3.0**, and **Tailwind CSS 4.3.3**; `package.json` and the lockfiles are authoritative.

```sh
npm run dev        # Development server
npm run build      # Production build
npm start          # Run the production build
npm run typecheck  # TypeScript
npm run lint       # Biome checks
npm run format     # Biome formatting
npm test           # Node's test runner with TypeScript stripping
```

Tests cover pure game helpers, token validation, same-origin and HTTPS protections, local ranking, author attribution, pagination and caps, deduplication, and mocked GitHub success/error responses. They require no real GitHub account or credentials.
