import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  LoaderCircle,
  RotateCcw,
  X,
} from "lucide-react";
import { matchingCommitAuthors } from "@/lib/game";
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
  onConnect,
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
  onConnect: () => void;
}) {
  const index = Math.floor(game.step / 2);
  const commit = game.commits[index];
  const revealed = game.step % 2 === 1;
  const finished = game.exhausted && !commit;
  const authors = commit ? matchingCommitAuthors(commit, game.players) : [];
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
        <div className="game-header-actions">
          {game.demo && (
            <span className="demo-badge">
              Demo
              <span className="sr-only">: fictional commits and usernames</span>
            </span>
          )}
          <button
            type="button"
            className="icon-button"
            onClick={onEnd}
            aria-label="End game"
            title="End game"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
      </header>

      <main className="game-main">
        {!finished && <p className="round-label">Round {index + 1}</p>}
        <ul className="participants" aria-label="Participants">
          {game.players.map((player) => (
            <li key={player.username}>@{player.username}</li>
          ))}
        </ul>
        <div
          className="game-stage"
          aria-live="polite"
          aria-atomic="true"
          aria-busy={loading}
        >
          {commit ? (
            <div className="round-content" key={`${commit.id}-${revealed}`}>
              <blockquote
                className={`commit-message${commit.message.length > 100 ? " long-message" : ""}`}
              >
                {commit.message}
              </blockquote>
              {revealed && (
                <>
                  <div className="authors-reveal">
                    <h1 className="sr-only">
                      {authors.length > 1 ? "Authors" : "Author"}
                    </h1>
                    <ul className="authors-list">
                      {authors.map((author) => (
                        <li className="author-reveal" key={author.login}>
                          <Avatar
                            name={author.login}
                            index={Math.max(
                              0,
                              game.players.findIndex(
                                ({ username }) =>
                                  username === author.login.toLowerCase(),
                              ),
                            )}
                            url={author.avatarUrl}
                            large
                          />
                          <span className="author-username">
                            @{author.login}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {!game.demo && (
                    <a
                      className="commit-link"
                      href={commit.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View commit <ArrowUpRight size={16} aria-hidden="true" />
                    </a>
                  )}
                </>
              )}
            </div>
          ) : finished ? (
            <div className="end-screen">
              <h1>
                {game.demo
                  ? "Demo complete"
                  : game.commits.length
                    ? "No more commits"
                    : "Not enough commits"}
              </h1>
              <p>
                No unused commits remain for{" "}
                {game.exhaustedPlayers
                  .map((username) => `@${username}`)
                  .join(", ")}
                . The game ends when everyone runs out.
              </p>
              {!game.demo && !game.commits.length && (
                <p>
                  {game.authenticated
                    ? "Check the usernames, repository access, and organization SSO permissions."
                    : "Check the usernames and whether their commits are public and indexed by GitHub."}
                </p>
              )}
            </div>
          ) : (
            <div className="loading-state">
              {loading && (
                <LoaderCircle
                  size={24}
                  className="animate-spin"
                  aria-hidden="true"
                />
              )}
              <p>{loading ? "Loading commits..." : "Unable to load commits"}</p>
            </div>
          )}
        </div>

        {error && (
          <div className="game-error" role="alert">
            <p>
              {error}
              {needsAuth && " Reconnecting will start a new game."}
            </p>
            {needsAuth ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={onConnect}
              >
                Reconnect GitHub <ArrowUpRight size={16} aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="button button-secondary"
                onClick={onRetry}
                disabled={loading || retryIn > 0}
              >
                <RotateCcw size={16} aria-hidden="true" />{" "}
                {retryIn > 0 ? `Retry in ${retryIn}s` : "Retry"}
              </button>
            )}
          </div>
        )}
        {game.warnings.length > 0 && (
          <details className="search-notice">
            <summary>Search limits</summary>
            {game.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </details>
        )}
      </main>

      <footer className="game-controls">
        <button
          type="button"
          className="button button-secondary"
          onClick={onPrevious}
          disabled={game.step === 0 || loading}
          aria-label="Previous screen"
          aria-keyshortcuts="ArrowLeft ArrowUp"
        >
          <ArrowLeft size={18} aria-hidden="true" /> Previous
        </button>
        {finished ? (
          <button
            type="button"
            className="button button-primary next-button"
            onClick={onEnd}
          >
            Back to setup <ArrowRight size={18} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="button button-primary next-button"
            onClick={onNext}
            disabled={waiting || !commit}
            aria-keyshortcuts="Enter Space ArrowRight ArrowDown"
          >
            {loading ? (
              <>
                <LoaderCircle
                  size={18}
                  className="animate-spin"
                  aria-hidden="true"
                />{" "}
                Loading...
              </>
            ) : retryIn > 0 && nextNeedsFetch ? (
              `Retry in ${retryIn}s`
            ) : revealed ? (
              "Next commit"
            ) : (
              "Reveal authors"
            )}
            {!loading && <ArrowRight size={18} aria-hidden="true" />}
          </button>
        )}
      </footer>
    </div>
  );
}
