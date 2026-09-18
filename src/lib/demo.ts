import type { CommitCard, Player } from "./types";

export const demoPlayers: Player[] = [
  { username: "demo-maya" },
  { username: "demo-alex" },
  { username: "demo-sam" },
  { username: "demo-jules" },
];

const messages = [
  ["i have made a terrible mistake", "demo-maya"],
  ["fixed the fix that fixed the fix", "demo-alex"],
  ["the tests were wrong, not me", "demo-jules"],
  ["please work i want to go home", "demo-sam"],
  ["turns out we needed that", "demo-maya"],
  ["remove the load-bearing console.log", "demo-jules"],
  ["it works if you don't look at it", "demo-alex"],
  ["a very professional panic", "demo-sam"],
];

export const demoCommits: CommitCard[] = messages.map(
  ([message, author], index) => ({
    id: `demo-${index}`,
    message,
    authors: [{ login: author, avatarUrl: "" }],
    url: "",
    repository: "",
    committedAt: "",
  }),
);
