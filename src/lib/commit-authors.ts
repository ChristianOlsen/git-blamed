import {
  BackendError,
  isAvatarUrl,
  isRecord,
  isRepositoryName,
  isUsername,
} from "./backend-errors.ts";
import {
  COMMIT_AUTHOR_QUERY_SIZE,
  type CommitAuthorTarget,
  type Fetcher,
  githubCommitAuthors,
} from "./github-client.ts";
import type { Viewer } from "./types.ts";

const MAX_AUTHOR_PAGES = 3;
const MAX_REQUESTS = 48;
const MAX_CONCURRENT_REQUESTS = 8;
const MAX_LOOKUP_MS = 50_000;

function invalidAuthors(): BackendError {
  return new BackendError(
    "GitHub returned invalid or conflicting commit author information. Retry the batch; no pages were skipped.",
    502,
  );
}

function linkedAuthor(login: unknown, avatarUrl: unknown): Viewer {
  if (
    !(
      isUsername(login) ||
      (typeof login === "string" &&
        login.endsWith("[bot]") &&
        isUsername(login.slice(0, -5)))
    ) ||
    !isAvatarUrl(avatarUrl)
  ) {
    throw invalidAuthors();
  }
  return { login: login.toLowerCase(), avatarUrl };
}

export function primaryCommitAuthors(value: unknown): Viewer[] {
  if (!isRecord(value)) throw invalidAuthors();
  if (value.author === null) return [];
  if (!isRecord(value.author)) throw invalidAuthors();
  return [linkedAuthor(value.author.login, value.author.avatar_url)];
}

// Trailers only trigger a lookup; their names and email addresses never identify players.
export function hasCoauthorTrailer(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.commit) &&
    typeof value.commit.message === "string" &&
    /(?:^|\n)[ \t]*co-authored-by[ \t]*:/i.test(value.commit.message)
  );
}

export type CommitAuthorResolver = (
  items: unknown[],
  repositoryName?: string,
) => Promise<Viewer[][]>;

export function createCommitAuthorResolver(
  token?: string,
  fetcher: Fetcher = fetch,
): CommitAuthorResolver {
  // Starts before REST discovery; queued requests and author pages share this deadline.
  const stageSignal = AbortSignal.timeout(MAX_LOOKUP_MS);
  const cache = new Map<string, Promise<Viewer[]>>();
  const waiting: (() => void)[] = [];
  let active = 0;
  let requests = 0;
  let failure: unknown;

  async function query(targets: CommitAuthorTarget[]) {
    if (active >= MAX_CONCURRENT_REQUESTS) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active++;
    }
    try {
      if (failure) throw failure;
      stageSignal.throwIfAborted();
      if (++requests > MAX_REQUESTS) {
        throw new BackendError(
          "Commit co-author verification exceeded its safety limit. Retry with fewer players; no pages were skipped.",
          502,
        );
      }
      return await githubCommitAuthors(
        targets,
        token ?? "",
        fetcher,
        stageSignal,
      );
    } catch (error) {
      failure = stageSignal.aborted
        ? new BackendError(
            "GitHub commit co-author verification timed out. Retry the batch; no pages were skipped.",
            503,
            15,
          )
        : error;
      throw failure;
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  async function load(targets: CommitAuthorTarget[]): Promise<Viewer[][]> {
    const authors = targets.map(() => new Map<string, Viewer>());
    let pending = targets.map((target, index) => ({
      target,
      index,
      cursors: new Set<string>(),
    }));
    for (let page = 0; pending.length && page < MAX_AUTHOR_PAGES; page++) {
      const data = await query(pending.map(({ target }) => target));
      const next: typeof pending = [];
      for (const [alias, entry] of pending.entries()) {
        const repository = data[`c${alias}`];
        if (
          !isRecord(repository) ||
          typeof repository.nameWithOwner !== "string" ||
          repository.nameWithOwner.toLowerCase() !==
            entry.target.repository.toLowerCase() ||
          !isRecord(repository.object) ||
          typeof repository.object.oid !== "string" ||
          repository.object.oid.toLowerCase() !==
            entry.target.sha.toLowerCase() ||
          !isRecord(repository.object.authors)
        ) {
          throw invalidAuthors();
        }
        const connection = repository.object.authors;
        if (
          !Array.isArray(connection.nodes) ||
          !connection.nodes.length ||
          connection.nodes.length > 100 ||
          !isRecord(connection.pageInfo) ||
          typeof connection.pageInfo.hasNextPage !== "boolean" ||
          (connection.pageInfo.endCursor !== null &&
            (typeof connection.pageInfo.endCursor !== "string" ||
              !connection.pageInfo.endCursor.length ||
              connection.pageInfo.endCursor.length > 1024 ||
              /\p{Cc}/u.test(connection.pageInfo.endCursor)))
        ) {
          throw invalidAuthors();
        }
        for (const node of connection.nodes) {
          if (!isRecord(node)) throw invalidAuthors();
          if (node.user === null) continue;
          if (!isRecord(node.user)) throw invalidAuthors();
          const author = linkedAuthor(node.user.login, node.user.avatarUrl);
          authors[entry.index].set(author.login, author);
        }
        if (connection.pageInfo.hasNextPage) {
          const cursor = connection.pageInfo.endCursor;
          if (
            typeof cursor !== "string" ||
            entry.cursors.has(cursor) ||
            page + 1 === MAX_AUTHOR_PAGES
          ) {
            throw new BackendError(
              "GitHub's commit author list exceeded its pagination safety limit. No pages were skipped.",
              502,
            );
          }
          entry.cursors.add(cursor);
          next.push({
            ...entry,
            target: { ...entry.target, after: cursor },
          });
        }
      }
      pending = next;
    }
    return authors.map((entries) => [...entries.values()]);
  }

  return async (items, repositoryName) => {
    const primaries = items.map(primaryCommitAuthors);
    const references = items.map((item) => {
      if (!token || !hasCoauthorTrailer(item)) return undefined;
      if (!isRecord(item)) throw invalidAuthors();
      const repository =
        repositoryName ??
        (isRecord(item.repository) ? item.repository.full_name : undefined);
      if (
        !isRepositoryName(repository) ||
        typeof item.sha !== "string" ||
        !/^[a-f\d]{40}$/i.test(item.sha)
      ) {
        throw invalidAuthors();
      }
      return {
        repository,
        sha: item.sha.toLowerCase(),
        key: `${repository.toLowerCase()}:${item.sha.toLowerCase()}`,
      };
    });
    const missing = [
      ...new Map(
        references
          .filter((target) => target !== undefined)
          .filter((target) => !cache.has(target.key))
          .map((target) => [target.key, target]),
      ).values(),
    ];
    for (
      let start = 0;
      start < missing.length;
      start += COMMIT_AUTHOR_QUERY_SIZE
    ) {
      const targets = missing.slice(start, start + COMMIT_AUTHOR_QUERY_SIZE);
      const promise = load(targets);
      for (const [index, target] of targets.entries()) {
        cache.set(
          target.key,
          promise.then((result) => result[index]),
        );
      }
    }
    return Promise.all(
      references.map(async (target, index) => {
        if (!target) return primaries[index];
        const authors = await cache.get(target.key);
        if (
          !authors ||
          primaries[index].some(
            (primary) =>
              !authors.some((author) => author.login === primary.login),
          )
        ) {
          throw invalidAuthors();
        }
        return authors;
      }),
    );
  };
}
