import {
  BackendError,
  isRecord,
  isRepositoryName,
  isUsername,
} from "./backend-errors.ts";
import {
  type CommitAuthorResolver,
  createCommitAuthorResolver,
  primaryCommitAuthors,
} from "./commit-authors.ts";
import { type Fetcher, githubGet } from "./github-client.ts";
import {
  COMMITS_PER_PAGE,
  parseSearchPage,
  SEARCH_RESULT_LIMIT,
} from "./search-page.ts";
import type {
  CommitCard,
  IndexedCommitBatch,
  IndexedCommitRequest,
  Viewer,
} from "./types.ts";

const PER_PAGE = COMMITS_PER_PAGE;
const MAX_PAGE = SEARCH_RESULT_LIMIT / PER_PAGE;

export function validateCommitRequest(value: unknown): IndexedCommitRequest {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["usernames", "cursors", "requireAuth"].includes(key),
    ) ||
    !Array.isArray(value.usernames) ||
    value.usernames.length < 1 ||
    value.usernames.length > 8 ||
    !isRecord(value.cursors) ||
    (value.requireAuth !== undefined && typeof value.requireAuth !== "boolean")
  ) {
    throw new BackendError(
      "Provide 1–8 GitHub usernames and a cursors object.",
      400,
    );
  }
  const usernames = value.usernames.map((name: unknown) => {
    if (typeof name !== "string" || !isUsername(name.trim())) {
      throw new BackendError("One of the GitHub usernames is invalid.", 400);
    }
    return name.trim().toLowerCase();
  });
  if (new Set(usernames).size !== usernames.length) {
    throw new BackendError("GitHub usernames must be unique.", 400);
  }
  const cursors: IndexedCommitRequest["cursors"] = {};
  for (const [username, cursor] of Object.entries(value.cursors)) {
    if (
      !usernames.includes(username) ||
      !isRecord(cursor) ||
      Object.keys(cursor).some((key) => !["page", "exhausted"].includes(key)) ||
      typeof cursor.page !== "number" ||
      !Number.isInteger(cursor.page) ||
      cursor.page < 1 ||
      cursor.page > MAX_PAGE + 1 ||
      typeof cursor.exhausted !== "boolean" ||
      (!cursor.exhausted && cursor.page > MAX_PAGE)
    ) {
      throw new BackendError(
        "Invalid commit cursor. Restart the game to start a fresh search.",
        400,
      );
    }
    cursors[username] = {
      page: cursor.page,
      exhausted: cursor.exhausted,
    };
  }
  return {
    usernames,
    cursors,
    ...(value.requireAuth === undefined
      ? {}
      : { requireAuth: value.requireAuth }),
  };
}

export function isCommitNoise(message: string): boolean {
  return (
    /^merge (?:pull request|branch|remote-tracking branch|tag)\b/i.test(
      message,
    ) ||
    /^(?:(?:build|chore|ci)(?:\([^)]*\))?!?:\s*)?(?:bump|update|upgrade) (?:dependencies|devdependencies|lockfile)\b/i.test(
      message,
    ) ||
    /^(?:(?:build|chore|ci)(?:\([^)]*\))?!?:\s*)?bump .+ from \S+ to \S+/i.test(
      message,
    ) ||
    /^(?:build|chore|ci)\(deps(?:-dev)?\):/i.test(message)
  );
}

/**
 * How much random noise `rankCommits` adds on top of a message score. Large
 * enough that two similar subjects trade places between games, small enough
 * that a genuinely funny commit still beats a changelog entry.
 */
export const RANKING_JITTER = 4;

const WIT_CEILING = 14;

/**
 * Vocabulary and phrasing that separates a commit somebody wrote at 3am from
 * one a release script wrote. Ordered by how reliably each signal predicts a
 * subject worth reading aloud.
 */
const WIT_SIGNALS: { weight: number; pattern: RegExp }[] = [
  // Confessions and asides. The best commits narrate a small tragedy.
  {
    weight: 5,
    pattern:
      /\b(?:don'?t ask|do not ask|no idea|not sure why|works on my machine|should(?:n'?t| not)(?: ever)? happen|never happens|my (?:bad|fault)|i'?m sorry|i give up|giving up|who (?:wrote|did|approved) this|what was i thinking|(?:past|future) me|sorry not sorry|trust me|don'?t touch|do not touch|here be dragons|black magic|famous last words|for real this time|this time for real|last (?:try|attempt|resort)|one more time|please work|why god|send help|good luck|god help)\b/gi,
  },
  // The nth go at the same problem, and reverts of reverts.
  { weight: 4, pattern: /\b(?:try|attempt|fix|test|round)\s*#?\s*\d+\b/gi },
  { weight: 4, pattern: /^\s*(?:revert\s+"?){2,}/gi },
  // Swearing, the most honest changelog there is.
  {
    weight: 3.5,
    pattern:
      /\b(?:wtf|ffs|omfg|damn(?:it|ed)?|hell|crap|shit(?:ty)?|fuck(?:ing|ed)?|bollocks|bloody|arse|goddamn|faen|j(?:ae|æ)vla|dritt|helvete)\b/gi,
  },
  // Regret, blame and melodrama.
  {
    weight: 3,
    pattern:
      /\b(?:o+ps|whoops|woops|yolo|sorry|forgive|facepalm|blame|shame|embarrassing|panic|rage|scream|crying|tears|sob|regret|disaster|nightmare|catastrophe|apocalypse|cursed|haunted|voodoo|witchcraft|sorcery|gremlins?|goblins?|demons?|monster|abomination|atrocity|crimes?|sin)\b/gi,
  },
  // Duct-tape engineering, described honestly.
  {
    weight: 2.5,
    pattern:
      /\b(?:hacky?|kludge|band-?aid|duct ?tape|glue|hardcoded?|temporary|quick and dirty|dirty|ugly|stupid|dumb|silly|weird|strange|bizarre|insane|crazy|broken|messy?|spaghetti|garbage|trash|junk|smells?|rotten|janky?|footgun|yak ?shav\w*)\b/gi,
  },
  // A human voice: questions, hedging, pleading, swearing it is fixed now.
  {
    weight: 2,
    pattern:
      /\b(?:why|how|please|finally|actually|somehow|apparently|seriously|literally|obviously|hopefully|surely|honestly|allegedly|supposedly|again|really|guess|hope|pray|beg|swear|promise|never|nobody|everybody|everyone|magical?)\b/gi,
  },
  // Life outside the editor leaking into the history.
  {
    weight: 2,
    pattern:
      /\b(?:sleep|sleepy|tired|coffee|caffeine|beer|wine|pizza|friday|monday|weekend|holiday|vacation|midnight|3 ?am|deadline|demo|prod(?:uction)?|customer|boss|intern|lol|lmao|rofl|haha+|rip|oof|meh|ugh|sigh|argh|hmm+)\b/gi,
  },
];

/**
 * Subjects that carry no story: bare ticket references, the defaults GitHub
 * writes for web edits, release stamps and placeholder words.
 */
const DULL_SIGNALS: { weight: number; pattern: RegExp }[] = [
  { weight: 6, pattern: /^\W*(?:[A-Z][A-Z0-9]{1,9}-\d+|#\d+|\d+)\W*$/ },
  {
    weight: 5,
    pattern:
      /^(?:update|create|add|delete|rename|initial commit)\b(?:\s+\S+\.\w{1,6})?\s*$/i,
  },
  { weight: 5, pattern: /^v?\d+\.\d+(?:\.\d+)?(?:[-+]\S+)?\s*$/ },
  {
    weight: 4,
    pattern:
      /^(?:wip|tmp|temp|asdf+|a{3,}|x{3,}|z{3,}|\.+|-+|\?+|foo|bar|baz|stuff|things|misc|minor|small|tweaks?|clean ?up|formatting|format|lint|prettier|biome|typos?|rebase|squash|amend|sync|bump|version|release|deploy|build|tests?)\b[\s.:,!-]*$/i,
  },
  // A progress marker in front of the real subject.
  { weight: 2, pattern: /^(?:wip|draft|tmp|temp)\b\W/i },
  // Conventional commits read like a form, so nudge them behind prose.
  {
    weight: 1.5,
    pattern:
      /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]*\))?!?:/i,
  },
  // Nothing but punctuation, paths or hashes.
  { weight: 3, pattern: /^[^\p{L}]*$/u },
  // A commit hash quoted in the subject, which only a script writes.
  { weight: 3, pattern: /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/i },
];

/**
 * Uppercase runs that mean nothing emotional. Without these, "Fix HTTP retries
 * in the JSON parser" would read as shouting.
 */
const TECH_ACRONYMS = new Set(
  `API APIS HTTP HTTPS URL URLS URI URIS SQL CSS SCSS HTML JSON XML YAML YML
   TOML CSV TSV PDF PNG JPG JPEG SVG GIF WEBP MP4 CI CD PR PRS MR UI UX SDK CLI
   GUI TUI AWS GCP DNS TCP UDP TLS SSL SSH JWT CRUD REST GRPC RPC SOAP IOS MAC
   OSX NPM PNPM YARN NODE ID IDS TODO FIXME XXX OK EOF EOL UTC GMT ISO RFC LGTM
   NPE OOM GPU CPU RAM ROM SSD DB ORM JS TS JSX TSX DTO DAO MVP POC QA UAT SSO
   SAML OIDC OAUTH SHA MD5 UUID GUID ASCII UTF CORS CSRF XSS SSR CSR SPA PWA
   DOM ENV AUTH NAN NULL OBOS GDPR VAT MVA BEM LTS WCAG ARIA HEAD GET POST PUT
   PATCH DELETE OPTIONS README LICENSE CHANGELOG CODEOWNERS DEBUG INFO WARN
   ERROR TRACE FATAL`
    .trim()
    .split(/\s+/),
);

/** Position of `value` between `from` and `to`, clamped to 0..1. */
function ramp(value: number, from: number, to: number): number {
  if (value <= from) return 0;
  if (value >= to) return 1;
  return (value - from) / (to - from);
}

function witScore(text: string): number {
  let score = 0;
  for (const { weight, pattern } of WIT_SIGNALS) {
    const hits = text.match(pattern);
    if (!hits) continue;
    // Repeats keep adding, with diminishing returns, so a subject that piles on
    // the drama beats one that mentions a single keyword in passing.
    score += weight * (1 + Math.min(hits.length - 1, 2) * 0.4);
  }
  return Math.min(score, WIT_CEILING);
}

/** Uppercase words that are not acronyms, i.e. actual shouting. */
function shoutedWords(subject: string): string[] {
  return (subject.match(/\b\p{Lu}{3,}\b/gu) ?? []).filter(
    (word) => !TECH_ACRONYMS.has(word),
  );
}

/**
 * Saying the same word over and over is a joke structure on its own, as in
 * "fix the fix that fixed the fix".
 */
function repetitionScore(subject: string): number {
  const counts = new Map<string, number>();
  for (const word of subject.toLowerCase().match(/\p{L}{3,}/gu) ?? []) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values()) >= 3 ? 3 : 0;
}

/**
 * Subjects that are too short say nothing and subjects that run on cannot be
 * read off a card, so reward the range in between.
 */
function lengthScore(subject: string): number {
  const length = subject.trim().length;
  return (
    -2.5 +
    ramp(length, 6, 22) * 4 +
    ramp(length, 22, 45) * 1.5 -
    ramp(length, 95, 145) * 2 -
    ramp(length, 145, 260) * 2
  );
}

/** Punctuation and casing carry tone that the vocabulary lists miss. */
function typographyScore(subject: string): number {
  let score = 0;
  if (/[!?]{2,}|\?!|!\?/.test(subject)) score += 3;
  else if (/[!?]/.test(subject)) score += 1.5;
  score +=
    Math.min((subject.match(/\p{Extended_Pictographic}/gu) ?? []).length, 2) *
    1.5;
  if (/\.{3,}|…/.test(subject)) score += 1;
  if (/\([^)]{3,}\)/.test(subject)) score += 1;
  // A shout inside a normal sentence lands harder than a subject that is
  // uppercase from end to end.
  const shouts = shoutedWords(subject).length;
  if (shouts) {
    score += /^[^\p{Ll}]+$/u.test(subject) ? 1 : Math.min(shouts, 2) * 2;
  }
  return score;
}

function dullScore(subject: string): number {
  let score = 0;
  for (const { weight, pattern } of DULL_SIGNALS) {
    if (pattern.test(subject)) score += weight;
  }
  if (!/\s/.test(subject.trim())) score += 2;
  const alphanumeric = (subject.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const digits = (subject.match(/\p{N}/gu) ?? []).length;
  if (alphanumeric >= 8 && digits / alphanumeric > 0.35) score += 3;
  return score;
}

/**
 * Rates how likely a commit message is to be fun to read out in a round. Higher
 * is funnier; ordinary work lands near zero and machine-written subjects go
 * negative. Pure and deterministic: `rankCommits` adds the randomness.
 */
export function scoreMessage(message: string): number {
  const subject = message.split("\n", 1)[0] ?? "";
  const body = message.slice(subject.length).trim();
  const score =
    lengthScore(subject) +
    witScore(subject) +
    typographyScore(subject) +
    repetitionScore(subject) -
    dullScore(subject) +
    // A body can carry the joke, but only a little, because the card shows the
    // whole message and a long changelog reads as noise either way.
    Math.min(witScore(body), 3) * 0.5 -
    ramp(body.length, 200, 800) * 3;
  return Math.round(score * 100) / 100;
}

export function rankCommits(
  commits: CommitCard[],
  random: () => number = Math.random,
): CommitCard[] {
  const decorated = commits.map((commit) => ({
    commit,
    score: scoreMessage(commit.message) + random() * RANKING_JITTER,
  }));
  decorated.sort((a, b) => b.score - a.score);
  return decorated.map(({ commit }) => commit);
}

export function parseCommit(
  value: unknown,
  username: string,
  repositoryName?: string,
  verifiedAuthors?: Viewer[],
): CommitCard | null {
  if (!isRecord(value)) {
    throw new BackendError("GitHub returned an invalid commit record.", 502);
  }
  const authors = verifiedAuthors ?? primaryCommitAuthors(value);
  if (!authors.some((author) => author.login === username)) return null;
  const repository =
    repositoryName ??
    (isRecord(value.repository) ? value.repository.full_name : undefined);
  if (
    typeof value.sha !== "string" ||
    !/^[a-f\d]{40}$/i.test(value.sha) ||
    !isRepositoryName(repository) ||
    !isRecord(value.commit) ||
    typeof value.commit.message !== "string" ||
    !isRecord(value.commit.committer) ||
    typeof value.commit.committer.date !== "string" ||
    value.commit.committer.date.length > 40 ||
    !Number.isFinite(Date.parse(value.commit.committer.date))
  ) {
    throw new BackendError("GitHub returned an invalid commit record.", 502);
  }
  const message = value.commit.message
    .trim()
    .split(/\r?\n/, 1)[0]
    .replace(/\p{Cc}/gu, (char) => ("\n\r\t".includes(char) ? char : ""))
    .trim()
    .slice(0, 1000);
  if (!message || isCommitNoise(message)) return null;
  const sha = value.sha.toLowerCase();
  return {
    id: sha,
    message,
    authors,
    url: `https://github.com/${repository}/commit/${sha}`,
    repository,
    committedAt: value.commit.committer.date,
  };
}

export function deduplicateCommits(commits: CommitCard[]): CommitCard[] {
  const unique = new Map<string, CommitCard>();
  for (const commit of commits) {
    const duplicate = unique.get(commit.id);
    if (
      duplicate &&
      (duplicate.authors.length !== commit.authors.length ||
        duplicate.authors.some(
          (author) =>
            !commit.authors.some((other) => other.login === author.login),
        ))
    ) {
      throw new BackendError(
        "GitHub returned conflicting author information. Retry the batch; no pages were skipped.",
        502,
      );
    }
    if (!duplicate) unique.set(commit.id, commit);
  }
  return [...unique.values()];
}

export async function searchCommitBatch(
  input: unknown,
  token?: string,
  fetcher: Fetcher = fetch,
  random: () => number = Math.random,
  options: {
    warnOnEmpty?: boolean;
    resolveAuthors?: CommitAuthorResolver;
  } = {},
): Promise<IndexedCommitBatch> {
  const request = validateCommitRequest(input);
  if (request.requireAuth && !token) {
    throw new BackendError(
      "Connect a GitHub token to continue with private repository access.",
      401,
    );
  }
  // Keep a public game's search scope stable if the host signs in in another tab.
  const searchToken = request.requireAuth === false ? undefined : token;
  const resolveAuthors = searchToken
    ? (options.resolveAuthors ??
      createCommitAuthorResolver(searchToken, fetcher))
    : createCommitAuthorResolver(undefined, fetcher);
  const results = await Promise.all(
    request.usernames.map(async (username) => {
      const cursor = Object.hasOwn(request.cursors, username)
        ? request.cursors[username]
        : { page: 1, exhausted: false };
      if (cursor.exhausted) {
        return { username, cursor, commits: [] as CommitCard[], warnings: [] };
      }
      const query = new URLSearchParams({
        q: `author:${username}`,
        sort: "committer-date",
        order: "desc",
        per_page: String(PER_PAGE),
        page: String(cursor.page),
      });
      const data = await githubGet(
        `/search/commits?${query}`,
        searchToken,
        fetcher,
      );
      const page = parseSearchPage(data, cursor.page, PER_PAGE);
      const authors = await resolveAuthors(page.items);
      const commits: CommitCard[] = [];
      for (const [index, item] of page.items.entries()) {
        const commit = parseCommit(item, username, undefined, authors[index]);
        if (commit) commits.push(commit);
      }
      const warnings: string[] = [];
      if (
        options.warnOnEmpty !== false &&
        page.totalCount === 0 &&
        cursor.page === 1
      ) {
        warnings.push(
          searchToken
            ? `@${username}: no indexed commits visible to the host were found. Private repository access, SSO, and GitHub indexing can affect results.`
            : `@${username}: no indexed public commits were found. Check the username and GitHub indexing; private repositories require an optional token connection.`,
        );
      }
      return {
        username,
        cursor: {
          page: cursor.page + 1,
          exhausted: page.exhausted,
        },
        commits,
        warnings,
      };
    }),
  );
  const cursors: IndexedCommitBatch["cursors"] = {};
  const warnings = new Set<string>();
  for (const result of results) {
    cursors[result.username] = result.cursor;
    for (const warning of result.warnings) warnings.add(warning);
  }
  return {
    commits: rankCommits(
      deduplicateCommits(results.flatMap((result) => result.commits)),
      random,
    ),
    cursors,
    warnings: [...warnings],
    exhausted: Object.values(cursors).every((cursor) => cursor.exhausted),
  };
}
