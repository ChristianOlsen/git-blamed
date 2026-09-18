# git blamed

A GitHub commit guessing game. Read a commit message, guess the author, then reveal their GitHub username.

## Run locally

Use **Node.js 22.18 or newer**.

```sh
npm install
npm run dev
```

Open [localhost:3000](http://localhost:3000), add GitHub usernames, and play with **real public commits**. No configuration or sign-in is required. The optional **demo uses fictitious commits and authors**; it never substitutes fake commits into a real game.

### Optional local PAT

Copy `.env.example` to `.env.local` and set:

```dotenv
GITHUB_TOKEN=your_github_pat
```

Restart `npm run dev`. The setup screen shows **Local token configured** and uses the token for new games without sending it to the browser. The same repository permissions and SSO requirements described below apply. A rejected token produces an error rather than silently switching to public access.

This option is **local-development only**: it requires development mode and a loopback host, and is disabled on Vercel and in production, including `npm start`. The development server binds to `127.0.0.1`; do not expose it through a tunnel or override that binding while a local PAT is configured. Never use a `NEXT_PUBLIC_` variable for the token or commit `.env.local`.

**Use public commits** disables the local token for the current page; **Use local token** enables it again. Refreshing restores the configured default. Remove `GITHUB_TOKEN` and restart the dev server to disable it permanently. The manual **Connect GitHub** option remains available when using public mode.

## Deploy to Vercel

The app needs a server for its commit and token APIs; GitHub Pages cannot host it.

Create a Vercel project for this repository using the **Next.js** framework preset, the repository root, and **Node.js 24.x**. Add these repository secrets under GitHub **Settings -> Secrets and variables -> Actions**:

| Secret | Value |
| --- | --- |
| `VERCEL_TOKEN` | A [Vercel access token](https://vercel.com/account/tokens) scoped to the project's team; it can be restricted to this project. |
| `VERCEL_ORG_ID` | The project's Vercel team/account ID. |
| `VERCEL_PROJECT_ID` | The Vercel project ID. |

The IDs are available in Vercel's team and project settings, or as `orgId` and `projectId` in `.vercel/project.json` if the project is already linked locally. Do not commit that directory or any tokens.

`.github/workflows/nextjs.yml` deploys pushes to `main`, or can be run manually on `main`. It installs dependencies with `npm ci` and runs the tests in GitHub Actions, then uploads the source with `vercel deploy --prod` and waits for Vercel to build and deploy the full Next.js app. These secrets authorize deployment only; the app still needs no environment configuration for public commits or the optional PAT connection.

The workflow deliberately avoids `vercel pull`: that command reads team settings and fails with project-restricted tokens, even when the project IDs are correct. Direct deployment supports those restricted tokens, so no broader team access is needed.

`vercel.json` selects npm explicitly because the repository contains both npm and pnpm lockfiles. It also disables Vercel's automatic Git deployments so GitHub Actions is the only deployment path. The workflow does not deploy to GitHub Pages.

## Optional GitHub connection

Click **Connect GitHub** and paste a personal access token. No environment configuration is needed. The app validates the token with GitHub and uses its repository access for subsequent games.

- Create a token in [GitHub settings](https://github.com/settings/tokens). Prefer limited, read-only repository access and a short expiration.
- For a fine-grained token, select the organization as the resource owner and include the repositories you want to use, with **Pull requests: read** permission for original PR commits. If GitHub denies commit/co-author access, also check the selected repositories and **Contents: read** permission. Organization approval may be required.
- A classic token needs the broad `repo` scope for private repositories. For SSO-protected organizations, use **Configure SSO** in GitHub's token settings to authorize the organization.
- A manually entered token is kept only in browser memory for this page, never in local storage, session storage, cookies, or URLs. Refreshing or signing out clears it. The backend receives it only to validate it or make GitHub API requests, without persisting it.
- Use only a trusted instance of this app. Tokens are available to JavaScript on the page and to the server handling requests. HTTPS is required outside localhost.

## Play

- Enter **2–8 GitHub usernames**, separated by commas or new lines. GitHub usernames are used throughout; there are no display names. Only those accounts' GitHub-linked author identities are eligible—not repository owners, raw author-name strings, or committers. Connected games include linked co-authors as well as the primary author; games without a token use only primary authors.
- Supply the entire list in the URL: `/?users=alice,bob,charlie`. Repeated `users` or `user` parameters also work, such as `/?users=alice&users=bob`. Starting a game updates the URL with the current list. Legacy `name` parameters are ignored.
- Start immediately with public commits. Optionally connect the host's token to include accessible private repositories and verified co-authors, or choose the demo. GitHub's co-author API requires authentication even for public repositories.
- Original commits from each player's pull requests are loaded first, including open, closed, and merged PRs. Later batches mix these with regular commit search results, so squash-merge titles are not the only source. Attribution uses each commit's linked authors and, when connected, co-authors—not the PR creator. A human co-author of a Copilot-authored commit can therefore be eligible.
- Guess, reveal **all matching players** who authored or co-authored the commit, then move on. Accounts outside the lineup are not revealed. A shared commit is eligible for every matching player but is shown only once. **Enter / Space / Right / Down** advance the game; **Left / Up** revisit previous cards.
- Each new round first picks a participant with equal probability, regardless of their commit count. Consecutive rounds can have the same author; equal chances do not guarantee equal totals. Previously shown rounds stay unchanged when navigating back and forth.
- Within the selected participant's available commits, local text heuristics and randomness favor expressive, short subjects. Only the first line is shown; explanatory bodies and author trailers stay out of the guessing screen. Obvious merge and automated dependency-update noise is filtered, while ordinary short messages can still appear. Text is capped at 1,000 characters.
- The game keeps an unused commit buffer for each participant and loads more pages only for depleted buffers. It avoids repeated SHAs and messages and stops as soon as **any participant** has no unused searchable commits left, rather than favoring those with more commits. A participant with no eligible commits prevents the game from starting. The demo follows the same selection and stopping rules.

## Permissions and privacy

Without a connection, GitHub requests omit the Authorization header and return **public data only**, with primary-author attribution. Personal tokens use the permissions assigned to them. A classic token's broad `repo` scope includes write capabilities even though **this app only reads GitHub data**; classic tokens do not offer an equivalent read-only scope covering private repositories. The backend uses REST GET requests and authenticated, read-only GraphQL queries sent as POST requests. It never sends GraphQL mutations or creates commits, issues, repositories, or other remote content.

Private commits visible to the **host's account** can appear on the shared screen. Other players do not sign in and do not acquire independent GitHub permissions, but anyone using the connected browser can see the returned commit data. Play only with people authorized to see those repositories. Do not screen-share, record, or publicly host a connected game containing private work without permission. Commit subjects themselves can contain sensitive information. Avatars load from GitHub's image service, and opening a commit link sends you to GitHub.

Manually entered tokens remain in browser memory and are sent to this app's backend in an Authorization header for commit requests. Signing out clears that browser token and profile immediately, without a server request. It **does not revoke** the token at GitHub; revoke it separately in GitHub's settings. The optional local-development token instead stays in `.env.local` and the server's environment; it is never returned to the browser and is not erased by switching to public mode. There are no server-side sessions or authentication cookies.

There is no database or application-side commit persistence. Loaded commits, guesses, and history live in client memory and are lost on refresh. Requests and sensitive responses use `no-store`; commit text is not sent to an AI service or logged by application code. Infrastructure operators can still control their own access logs and hosting environment.

Do not share a host account or token between unrelated groups. Connected games use the token's repository access. Public games share the server IP's anonymous GitHub quotas; connected games share quotas with other activity using that account. Changing players or starting another game does not reset those quotas. Public games stay public; private games prompt for reconnection if their token expires rather than silently changing their search scope. This is a small, trusted-group app—not a multi-tenant service or an access-control boundary between people sharing a browser.

## Search limits: “endless” is not infinite

The app searches GitHub separately for each requested author, anonymously for public games or with the host's personal access token for connected games. It discovers PRs with an `author:username` **issue/PR search**, newest updated first, five at a time, then reads their original commits from the **pull-request commits API**. Search matches can include bot-created PRs, so the PR creator is not used for attribution; only matching linked commit authors are eligible. Regular **commit search** also contributes up to 100 results per page, newest committer date first.

- With a token, commits containing co-author trailers are checked against GitHub's GraphQL `Commit.authors` list before attribution. Only linked GitHub users count; raw trailer names and emails are never interpreted as account identities. "Verified" means GitHub-linked attribution, not cryptographic proof of authorship. These lookups also consume GitHub's GraphQL quota. Verification failures fail the batch rather than silently losing co-authors. Empty regular-search results do not imply the separate PR source has no eligible commits.
- GitHub exposes **at most 1,000 results per search** (10 commit-search pages or 200 PR-search pages). Pagination stops at this limit without a warning; this is not complete repository history.
- GitHub's PR commits endpoint exposes **at most 250 commits per PR**. The app reads one page of up to 100 original commits per player per batch, preserving its place within longer PRs. These can include pre-squash messages that are absent from default-branch history; availability depends on what GitHub retains and exposes.
- Regular commit search depends on GitHub's search index and **default-branch** data. PR discovery additionally covers commits on open, closed, and merged PRs returned by the player's author search, but not every branch or contribution to somebody else's PR. Newly pushed or unindexed commits, inaccessible repositories, and commits without a matching linked GitHub author can still be absent. This is not a `git log` over every branch.
- Search results are not a frozen snapshot. New commits, rebases, deleted repositories, and indexing changes can shift page boundaries while you play. Deduplication prevents repeat cards but cannot recover every commit displaced by a changing index.
- Access depends on the host's actual permissions and the token's repository access. Organization token restrictions, approval requirements, and **SSO authorization** can exclude private organization data. Authorize the token for the organization when required. Detectable partial SSO results are treated as an error; the app cannot detect every repository excluded by GitHub.
- Anonymous search generally permits **10 requests per minute per server IP**; authenticated search generally permits **30 requests per minute**, subject to GitHub's current primary and secondary limits. Each batch makes at most one search request and one PR-commit request per player. PR discovery takes the search slot when its queue is empty; otherwise indexed commits and queued PR commits can load together. PR-commit requests also consume the ordinary REST quota (typically 60 anonymous requests per hour). `Retry-After`/rate-reset headers are honored in surfaced retry information.
- Errors, rate limits, and GitHub's `incomplete_results` flag fail the **whole batch**. Cursors are unchanged on failure, so retrying does not silently skip a failed page. An empty filtered page can still have more pages to search.

These limits explain why a participant can run out even when they have more commits elsewhere on GitHub. The game stops at that point, even if other participants still have unused commits. Changing the player list can start a different search; it cannot bypass GitHub's indexing or access rules.

## Backend contract

- `POST /api/auth/token` validates JSON `{ "token": "..." }` using GitHub's `/user` endpoint and returns only `{ login, avatarUrl }`. It does not create a cookie or retain the token.
- `POST /api/commits` accepts JSON `{ "usernames": ["alice", "bob"], "cursors": {}, "requireAuth": false }` without sign-in. The API accepts 1–8 distinct valid usernames and normalizes them to lowercase; the game UI requires at least two. `requireAuth: false` pins the game to public results; `true` requires an `Authorization: Bearer ...` header or the local-development token. An explicit header takes precedence and never falls back to the local token if rejected. When `requireAuth` is omitted, a supplied header token is used, otherwise the search is public; the local token is used only when `requireAuth` is explicitly `true`. Rejected tokens never fall back to public access.
- A successful batch is `{ commits, cursors, warnings, exhausted }`. `exhausted` means all requested search cursors are exhausted, not that the buffered commits have been used. Each commit is `{ id, message, authors, url, repository, committedAt }`, where `id` is the SHA and `authors` is a nonempty array of `{ login, avatarUrl }` for linked GitHub authors, with lowercase logins. At least one author matches a requested username; the full linked author list is retained so clients can recognize other players' co-authorship during later refills. Only lineup members are revealed. Games using the old single-author response format need a page refresh.
- Each cursor is `{ search, pullRequests, exhausted }`. `search` is `{ page, exhausted }` for indexed commits (live pages 1–10). `pullRequests` is `{ page, exhausted, pending, commitPage }`: PR-search pages are 1–200, `pending` holds up to five `{ repository, number }` references, and `commitPage` is the next page (1–3) within the first pending PR. Each search page advances by one and may sit just beyond its limit when exhausted. Top-level `exhausted` becomes true only when both searches and all pending PR commits are exhausted. Missing cursors start fresh; send returned cursors unchanged. Requests may mention only their specified usernames. Games opened before this cursor format changed need to be restarted.
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

Tests cover pure game helpers, token validation, same-origin and HTTPS protections, local ranking, author attribution, indexed and original PR commit pagination, caps, deduplication, and mocked GitHub success/error responses. They require no real GitHub account or credentials.
