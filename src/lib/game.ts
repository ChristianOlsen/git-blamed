import { isUsername } from "./backend-errors.ts";
import type { CommitCard, Player } from "./types.ts";

export const MAX_PLAYERS = 8;

export type SearchParams = Record<string, string | string[] | undefined>;

export function playersFromParams(params: SearchParams): Player[] {
  const users = [
    ...values(params.users).flatMap((value) => value.split(",")),
    ...values(params.user),
  ];
  const names = values(params.name);
  const seen = new Set<string>();

  return users.flatMap((value, index) => {
    const username = value.trim().replace(/^@/, "").toLowerCase();
    if (!username || seen.has(username)) return [];
    seen.add(username);
    return [{ username, displayName: (names[index] ?? "").slice(0, 40) }];
  });
}

function values(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

export function validatePlayers(players: Player[]): string | null {
  if (players.length < 2)
    return "Every good blame game needs at least 2 players.";
  if (players.length > MAX_PLAYERS) {
    return `There's room for up to ${MAX_PLAYERS} suspects in this party.`;
  }
  const seen = new Set<string>();
  for (const player of players) {
    const username = player.username.trim().replace(/^@/, "").toLowerCase();
    if (!isUsername(username)) {
      return username
        ? `"${username}" isn't a valid GitHub username.`
        : "Add a GitHub username for every player.";
    }
    if (seen.has(username)) return `@${username} is already in the lineup.`;
    if (player.displayName.length > 40) {
      return "Keep display names to 40 characters or less.";
    }
    seen.add(username);
  }
  return null;
}

export function normalizePlayers(players: Player[]): Player[] {
  return players.map((player) => ({
    username: player.username.trim().replace(/^@/, "").toLowerCase(),
    displayName: player.displayName.trim(),
  }));
}

export function partyUrl(players: Player[]): string {
  const normalized = normalizePlayers(players);
  const params = new URLSearchParams({
    users: normalized.map((player) => player.username).join(","),
  });
  if (normalized.some((player) => player.displayName)) {
    for (const player of normalized) params.append("name", player.displayName);
  }
  return `/?${params.toString()}`;
}

export function playerName(player: Player): string {
  return player.displayName || player.username;
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
