"use client";

import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  Fingerprint,
  GitCommitHorizontal,
  Keyboard,
  LoaderCircle,
  RotateCcw,
  Search,
  Users,
} from "lucide-react";
import { partyUrl, playerName } from "@/lib/game";
import type { GameSession } from "./git-blamed";
import { Avatar, Logo } from "./ui";

export function GameScreen({
  game,
  loading,
  error,
  needsAuth,
  retryIn,
  onNext,
  onPrevious,
  onEnd,
  onRetry,
}: {
  game: GameSession;
  loading: boolean;
  error: string | null;
  needsAuth: boolean;
  retryIn: number;
  onNext: () => void;
  onPrevious: () => void;
  onEnd: () => void;
  onRetry: () => void;
}) {
  const index = Math.floor(game.step / 2);
  const commit = game.commits[index];
  const revealed = game.step % 2 === 1;
  const finished = game.exhausted && !commit;
  const authorIndex = game.players.findIndex(
    (player) => player.username === commit?.author.toLowerCase(),
  );
  const author = game.players[authorIndex];
  const name = author ? playerName(author) : commit?.author;
  const nextNeedsFetch =
    game.step + 1 >= game.commits.length * 2 && !game.exhausted;
  const waiting = loading || (retryIn > 0 && nextNeedsFetch);

  return (
    <div className={`app-shell game-shell${revealed ? " is-revealed" : ""}`}>
      <header className="site-header">
        <button
          type="button"
          className="logo-button"
          onClick={onEnd}
          aria-label="End game and go to setup"
        >
          <Logo />
        </button>
        <div className="flex items-center gap-4">
          {game.demo && (
            <span className="demo-badge">DEMO / FICTIONAL COMMITS</span>
          )}
          <button type="button" className="nav-link" onClick={onEnd}>
            <XIcon /> End game
          </button>
        </div>
      </header>

      <main className="game-main">
        <div className="game-topline">
          <span className="round-label">
            <span className="status-dot" />{" "}
            {finished
              ? "ALL CAUGHT UP"
              : `ROUND ${String(index + 1).padStart(2, "0")}`}{" "}
            <span className="round-branch">
              on branch <span>bad-decisions</span>
            </span>
          </span>
          <span className="suspect-count">
            <Users size={15} aria-hidden="true" /> {game.players.length}{" "}
            suspects
          </span>
        </div>

        {game.warnings.length > 0 && (
          <details className="search-notice">
            <summary>GitHub search notes ({game.warnings.length})</summary>
            {game.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </details>
        )}

        <div
          className="game-stage"
          aria-live="polite"
          aria-atomic="true"
          aria-busy={loading}
        >
          {commit ? (
            <div className="round-content" key={`${commit.id}-${revealed}`}>
              <span className="giant-round" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="stage-eyebrow">
                {revealed ? (
                  <Fingerprint size={17} aria-hidden="true" />
                ) : (
                  <GitCommitHorizontal size={17} aria-hidden="true" />
                )}
                {revealed ? "GIT BLAME HAS SPOKEN" : "WHO COMMITTED THIS?"}
              </div>
              <blockquote
                className={`commit-message${commit.message.length > 100 ? " long-message" : ""}`}
              >
                <span className="commit-quote" aria-hidden="true">
                  &ldquo;
                </span>
                {commit.message}
                <span className="commit-quote" aria-hidden="true">
                  &rdquo;
                </span>
              </blockquote>
              {revealed ? (
                <div className="author-reveal">
                  <Avatar
                    name={name ?? ""}
                    index={Math.max(0, authorIndex)}
                    url={commit.avatarUrl}
                    large
                  />
                  <div className="min-w-0">
                    <p className="culprit-label">
                      <Check size={13} aria-hidden="true" /> FOUND THE CULPRIT
                    </p>
                    <h1 className="author-name">{name}</h1>
                    <p className="author-handle">@{commit.author}</p>
                  </div>
                </div>
              ) : (
                <div className="guess-prompt">
                  <span className="point-line" /> Look around. Point a finger.
                  Lock it in.
                </div>
              )}
              {revealed && (
                <div className="evidence">
                  {game.demo ? (
                    <span>
                      Fictional people. Fictional commits. You get the idea.
                    </span>
                  ) : (
                    <a
                      href={commit.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View the evidence{" "}
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </a>
                  )}
                </div>
              )}
            </div>
          ) : finished ? (
            <div className="end-screen">
              <div className="end-icon">
                <GitCommitHorizontal size={35} aria-hidden="true" />
              </div>
              <p className="eyebrow">
                {game.demo ? "DEMO COMPLETE" : "END OF THE GIT TRAIL"}
              </p>
              <h1>
                {game.commits.length
                  ? "No more receipts."
                  : "Nothing to blame. Yet."}
              </h1>
              <p>
                {game.demo
                  ? "Now imagine what we'll find in your friends' actual commits."
                  : game.commits.length
                    ? "You've seen every unique message in this search. GitHub's indexing and search limits apply — not every commit is searchable."
                    : game.authenticated
                      ? "No eligible commits were found for this lineup. Check the usernames, repository access, and organization SSO permissions."
                      : "No eligible public commits were found for this lineup. Check the usernames and whether their commits are public and indexed by GitHub."}
              </p>
              <button
                className="button button-primary"
                type="button"
                onClick={onEnd}
              >
                <RotateCcw size={17} aria-hidden="true" />{" "}
                {game.demo ? "Bring your own suspects" : "Back to the lineup"}
              </button>
              {game.commits.length > 0 && (
                <span className="end-hint">
                  Your round history is still here. Use the left arrow to
                  revisit.
                </span>
              )}
            </div>
          ) : (
            <div className="end-screen">
              <div className="end-icon">
                {loading ? (
                  <LoaderCircle
                    size={32}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Search size={32} aria-hidden="true" />
                )}
              </div>
              <p className="eyebrow">SEARCHING THE GIT HISTORY</p>
              <h1>
                {loading ? "Collecting receipts." : "A small interruption."}
              </h1>
              <p>
                {loading
                  ? "Finding the questionable commits. Leaving the merge noise behind."
                  : "Your lineup is saved. Resolve the message below, then try again."}
              </p>
            </div>
          )}
        </div>

        {error && (
          <div className="game-error" role="alert">
            <p>
              {error}
              {needsAuth && " Reconnecting will start a fresh game."}
            </p>
            {needsAuth ? (
              <a
                className="button button-secondary"
                href={`/api/auth/github?returnTo=${encodeURIComponent(partyUrl(game.players))}`}
              >
                Reconnect GitHub <ArrowUpRight size={15} aria-hidden="true" />
              </a>
            ) : (
              <button
                type="button"
                className="button button-secondary"
                onClick={onRetry}
                disabled={loading || retryIn > 0}
              >
                <RotateCcw size={15} aria-hidden="true" />{" "}
                {retryIn > 0 ? `Retry in ${retryIn}s` : "Try again"}
              </button>
            )}
          </div>
        )}

        {!finished && commit && (
          <section className="lineup-strip" aria-label="Players in this game">
            <span className="lineup-label">THE SUSPECTS</span>
            <div className="lineup-players">
              {game.players.map((player, playerIndex) => (
                <span
                  className={`lineup-player${revealed && playerIndex === authorIndex ? " guilty" : ""}`}
                  key={player.username}
                >
                  <Avatar name={playerName(player)} index={playerIndex} />
                  <span>{playerName(player)}</span>
                  {revealed && playerIndex === authorIndex && (
                    <Check size={13} aria-hidden="true" />
                  )}
                </span>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="game-controls">
        <button
          type="button"
          className="button previous-button"
          onClick={onPrevious}
          disabled={game.step === 0 || loading}
          aria-label="Previous screen"
        >
          <ArrowLeft size={18} aria-hidden="true" />
          <span>Previous</span>
        </button>
        <section
          className="phase-indicator"
          aria-label={
            finished
              ? "Game finished"
              : revealed
                ? "Author revealed"
                : "Guess the author"
          }
        >
          <span className={!revealed && !finished ? "active" : ""}>
            01 <span>GUESS</span>
          </span>
          <span className="phase-line" />
          <span className={revealed ? "active" : ""}>
            02 <span>REVEAL</span>
          </span>
        </section>
        {!finished ? (
          <button
            type="button"
            className="button button-primary next-button"
            onClick={onNext}
            disabled={waiting || !commit}
          >
            {loading ? (
              <>
                <LoaderCircle
                  size={18}
                  className="animate-spin"
                  aria-hidden="true"
                />{" "}
                Digging deeper
              </>
            ) : retryIn > 0 && nextNeedsFetch ? (
              `Retry in ${retryIn}s`
            ) : revealed ? (
              "Next commit"
            ) : (
              "Reveal author"
            )}
            {!loading && <ArrowRight size={19} aria-hidden="true" />}
          </button>
        ) : (
          <button
            type="button"
            className="button button-primary next-button"
            onClick={onEnd}
          >
            Back to setup <ArrowRight size={18} aria-hidden="true" />
          </button>
        )}
        <div className="keyboard-help">
          <Keyboard size={14} aria-hidden="true" />
          <span>
            <kbd>Enter</kbd> <kbd>Space</kbd> or <kbd>→</kbd> to advance{" "}
            <span className="mx-2">/</span> <kbd>←</kbd> to go back
          </span>
          <span className="ml-auto">No context. No alibis.</span>
        </div>
      </footer>
    </div>
  );
}

function XIcon() {
  return (
    <span className="exit-icon" aria-hidden="true">
      ×
    </span>
  );
}
