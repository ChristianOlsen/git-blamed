"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isRecord } from "@/lib/backend-errors";
import { demoCommits, demoPlayers } from "@/lib/demo";
import {
  appendUniqueCommits,
  navigationDirection,
  normalizePlayers,
  partyUrl,
} from "@/lib/game";
import type { CommitBatch, CommitCard, Player, Viewer } from "@/lib/types";
import { GameScreen } from "./game-screen";
import { SetupScreen } from "./setup-screen";

export type GameSession = {
  players: Player[];
  commits: CommitCard[];
  cursors: CommitBatch["cursors"];
  exhausted: boolean;
  warnings: string[];
  step: number;
  demo: boolean;
  authenticated: boolean;
};

function isCommit(value: unknown): value is CommitCard {
  return (
    isRecord(value) &&
    [
      "id",
      "message",
      "author",
      "avatarUrl",
      "url",
      "repository",
      "committedAt",
    ].every((key) => typeof value[key] === "string")
  );
}

function isBatch(value: unknown): value is CommitBatch {
  return (
    isRecord(value) &&
    Array.isArray(value.commits) &&
    value.commits.every(isCommit) &&
    typeof value.exhausted === "boolean" &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === "string") &&
    isRecord(value.cursors) &&
    Object.values(value.cursors).every(
      (cursor) =>
        isRecord(cursor) &&
        Number.isInteger(cursor.page) &&
        typeof cursor.exhausted === "boolean",
    )
  );
}

export function GitBlamed({
  initialPlayers,
  viewer,
  authConfigured,
  authError,
}: {
  initialPlayers: Player[];
  viewer: Viewer | null;
  authConfigured: boolean;
  authError?: string;
}) {
  const [setupPlayers, setSetupPlayers] = useState(initialPlayers);
  const [game, setGame] = useState<GameSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(0);
  const gameRef = useRef<GameSession | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));

  const updateGame = useCallback((session: GameSession | null) => {
    gameRef.current = session;
    setGame(session);
  }, []);

  useEffect(() => {
    if (!retryAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const fetchMore = useCallback(
    async (initial: GameSession, targetStep: number) => {
      if (requestRef.current) return;
      const controller = new AbortController();
      requestRef.current = controller;
      setLoading(true);
      setError(null);
      setNeedsAuth(false);
      setRetryAt(0);
      let session = initial;

      try {
        while (!session.exhausted) {
          const response = await fetch("/api/commits", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              usernames: session.players.map((player) => player.username),
              cursors: session.cursors,
              requireAuth: session.authenticated,
            }),
            signal: controller.signal,
            cache: "no-store",
          });
          if (
            !response.headers.get("content-type")?.includes("application/json")
          ) {
            throw new Error(
              "The server returned an unexpected response. Please try again.",
            );
          }
          const body: unknown = await response.json();
          if (!response.ok) {
            setNeedsAuth(response.status === 401 && session.authenticated);
            if (
              isRecord(body) &&
              typeof body.retryAfter === "number" &&
              Number.isFinite(body.retryAfter) &&
              body.retryAfter > 0
            ) {
              const time = Date.now();
              setNow(time);
              setRetryAt(time + body.retryAfter * 1000);
            }
            throw new Error(
              isRecord(body) && typeof body.error === "string"
                ? body.error
                : "Couldn't reach GitHub. Please try again.",
            );
          }
          if (!isBatch(body)) {
            throw new Error(
              "The server returned an invalid commit batch. Please try again.",
            );
          }
          if (controller.signal.aborted) return;
          const allowed = new Set(
            session.players.map((player) => player.username),
          );
          if (
            body.commits.some(
              (commit) => !allowed.has(commit.author.toLowerCase()),
            )
          ) {
            throw new Error(
              "GitHub returned a commit outside this player lineup.",
            );
          }
          const commits = appendUniqueCommits(session.commits, body.commits);
          const advanced =
            JSON.stringify(session.cursors) !== JSON.stringify(body.cursors);
          session = {
            ...session,
            commits,
            cursors: body.cursors,
            warnings: [...new Set([...session.warnings, ...body.warnings])],
            exhausted: body.exhausted,
            step:
              targetStep < commits.length * 2 || body.exhausted
                ? Math.min(targetStep, commits.length * 2)
                : session.step,
          };
          updateGame(session);
          if (targetStep < commits.length * 2 || session.exhausted) return;
          if (!advanced) {
            throw new Error("The commit search didn't advance. Please retry.");
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Something went wrong fetching commits. Please try again.",
          );
        }
      } finally {
        if (requestRef.current === controller) {
          requestRef.current = null;
          setLoading(false);
        }
      }
    },
    [updateGame],
  );

  const startGame = useCallback(
    (players: Player[], demo: boolean) => {
      setSetupPlayers(players);
      const session: GameSession = {
        players: demo ? demoPlayers : normalizePlayers(players),
        commits: demo ? [...demoCommits] : [],
        cursors: {},
        exhausted: demo,
        step: 0,
        warnings: [],
        demo,
        authenticated: !demo && viewer !== null,
      };
      setError(null);
      setNeedsAuth(false);
      setRetryAt(0);
      updateGame(session);
      window.scrollTo(0, 0);
      if (!demo) {
        window.history.replaceState(null, "", partyUrl(players));
        void fetchMore(session, 0);
      }
    },
    [fetchMore, updateGame, viewer],
  );

  const next = useCallback(() => {
    const session = gameRef.current;
    if (!session || requestRef.current) return;
    const target = session.step + 1;
    if (target < session.commits.length * 2 || session.exhausted) {
      updateGame({
        ...session,
        step: Math.min(target, session.commits.length * 2),
      });
    } else if (Date.now() >= retryAt) {
      void fetchMore(session, session.commits.length * 2);
    }
  }, [fetchMore, retryAt, updateGame]);

  const previous = useCallback(() => {
    const session = gameRef.current;
    if (!session || requestRef.current) return;
    updateGame({ ...session, step: Math.max(0, session.step - 1) });
  }, [updateGame]);

  useEffect(() => {
    if (!game) return;
    function handleKey(event: KeyboardEvent) {
      const target = event.target;
      const isElement = target instanceof Element;
      const typing =
        isElement &&
        !!target.closest(
          "input, textarea, select, [contenteditable], [role=textbox]",
        );
      const nativeActivation =
        isElement &&
        ["Enter", " "].includes(event.key) &&
        !!target.closest("button, a, summary, [role=button]");
      if (event.repeat && nativeActivation) {
        event.preventDefault();
        return;
      }
      const direction = navigationDirection(
        event.key,
        event.repeat,
        typing || nativeActivation,
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey,
      );
      if (!direction || event.defaultPrevented) return;
      event.preventDefault();
      if (direction === 1) next();
      else previous();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [game, next, previous]);

  function endGame() {
    const session = gameRef.current;
    const finished =
      session?.exhausted && session.step >= session.commits.length * 2;
    if (
      session?.commits.length &&
      !finished &&
      !window.confirm(
        "End this game? Your current commit history will be cleared.",
      )
    ) {
      return;
    }
    requestRef.current?.abort();
    requestRef.current = null;
    setLoading(false);
    setError(null);
    setNeedsAuth(false);
    setRetryAt(0);
    updateGame(null);
  }

  if (!game) {
    return (
      <SetupScreen
        initialPlayers={setupPlayers}
        viewer={viewer}
        authConfigured={authConfigured}
        authError={authError}
        onStart={startGame}
      />
    );
  }

  return (
    <GameScreen
      game={game}
      loading={loading}
      error={error}
      needsAuth={needsAuth}
      retryIn={remaining}
      onNext={next}
      onPrevious={previous}
      onEnd={endGame}
      onRetry={() => {
        if (Date.now() >= retryAt)
          void fetchMore(game, game.commits.length * 2);
      }}
    />
  );
}
