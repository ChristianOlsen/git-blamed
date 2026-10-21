# git blamed

[Play it](https://git-blamed.vercel.app)

A commit message appears on screen. Everyone guesses which of you wrote it.
Then it reveals the author's GitHub username and you argue about it. Enter two
to eight GitHub usernames, and it pulls their real commits and picks the ones
worth reading aloud. There is also a demo with fictitious commits if you want
to see it first.

## Run locally

```sh
npm install
npm run dev
```

Node.js 22.18 or newer. No configuration or sign-in needed; it plays with
public commits out of the box.

Optional, in `.env.local`: `GITHUB_TOKEN` for private repository access in
local development, and `GEMINI_API_KEY`
([get one](https://aistudio.google.com/apikey)) to let a model pick the funniest
commits instead of the built-in heuristic. Neither is required. Never prefix
either with `NEXT_PUBLIC_`.
