import { isUsername } from "./backend-errors.ts";
import type { CommitCard, Player } from "./types.ts";

export const MAX_PLAYERS = 8;

export type SearchParams = Record<string, string | string[] | undefined>;

export function playersFromParams(params: SearchParams): Player[] {
  const players = playersFromInput(
    [...values(params.users), ...values(params.user)].join(","),
  );
  const seen = new Set<string>();

  return players.filter(({ username }) => {
    if (seen.has(username)) return false;
    seen.add(username);
    return true;
  });
}

export function playersFromInput(value: string): Player[] {
  return normalizePlayers(
    value
      .split(/[,\r\n]+/)
      .filter((username) => username.trim())
      .map((username) => ({ username })),
  );
}

function values(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

export function validatePlayers(players: Player[]): string | null {
  if (players.length < 2) return "Enter at least 2 GitHub usernames.";
  if (players.length > MAX_PLAYERS) {
    return `Enter up to ${MAX_PLAYERS} GitHub usernames.`;
  }
  const seen = new Set<string>();
  for (const player of players) {
    const username = player.username.trim().replace(/^@/, "").toLowerCase();
    if (!isUsername(username)) {
      return username
        ? `"${username}" isn't a valid GitHub username.`
        : "Add a GitHub username for every player.";
    }
    if (seen.has(username)) return `@${username} is listed more than once.`;
    seen.add(username);
  }
  return null;
}

export function normalizePlayers(players: Player[]): Player[] {
  return players.map((player) => ({
    username: player.username.trim().replace(/^@/, "").toLowerCase(),
  }));
}

export function partyUrl(players: Player[]): string {
  const normalized = normalizePlayers(players);
  return `/?users=${normalized.map((player) => encodeURIComponent(player.username)).join(",")}`;
}

export function initials(name: string): string {
  return name
    .split(/[\s-]+/)
    .map((word) => word[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function navigationDirection(
  key: string,
  repeat: boolean,
  interactive: boolean,
  modified = false,
): -1 | 0 | 1 {
  if (repeat || interactive || modified) return 0;
  if (["ArrowLeft", "ArrowUp"].includes(key)) return -1;
  if (["ArrowRight", "ArrowDown", "Enter", " "].includes(key)) return 1;
  return 0;
}

export function appendUniqueCommits(
  existing: CommitCard[],
  incoming: CommitCard[],
): CommitCard[] {
  const ids = new Set(existing.map((commit) => commit.id));
  const messages = new Set(
    existing.map((commit) => commit.message.trim().toLowerCase()),
  );
  const next = [...existing];
  for (const commit of incoming) {
    const message = commit.message.trim().toLowerCase();
    if (ids.has(commit.id) || messages.has(message)) continue;
    ids.add(commit.id);
    messages.add(message);
    next.push(commit);
  }
  return next;
}
