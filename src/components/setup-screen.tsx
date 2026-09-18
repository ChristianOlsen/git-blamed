"use client";

import {
  ArrowRight,
  ArrowUpRight,
  Check,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  LockKeyhole,
  LogOut,
  Play,
  Plus,
  Terminal,
  X,
} from "lucide-react";
import { useId, useState } from "react";
import { MAX_PLAYERS, partyUrl, validatePlayers } from "@/lib/game";
import type { Player, Viewer } from "@/lib/types";
import { Avatar, Logo } from "./ui";

type PlayerRow = Player & { key: number };

export function SetupScreen({
  initialPlayers,
  viewer,
  authConfigured,
  authError,
  onStart,
}: {
  initialPlayers: Player[];
  viewer: Viewer | null;
  authConfigured: boolean;
  authError?: string;
  onStart: (players: Player[], demo: boolean) => void;
}) {
  const id = useId();
  const [players, setPlayers] = useState<PlayerRow[]>(() => {
    const rows = [...initialPlayers];
    while (rows.length < 2) rows.push({ username: "", displayName: "" });
    return rows.map((player, index) => ({ ...player, key: index }));
  });
  const [nextKey, setNextKey] = useState(players.length);
  const [error, setError] = useState<string | null>(null);
  const authUrl = `/api/auth/github?returnTo=${encodeURIComponent(partyUrl(players))}`;

  function changePlayer(key: number, field: keyof Player, value: string) {
    setPlayers((current) =>
      current.map((player) =>
        player.key === key ? { ...player, [field]: value } : player,
      ),
    );
    setError(null);
  }

  function start() {
    const validationError = validatePlayers(players);
    setError(validationError);
    if (!validationError) onStart(players, false);
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a href="/" aria-label="gitblamed home">
          <Logo />
        </a>
        <nav className="flex items-center gap-5" aria-label="Main navigation">
          <a href="#how-to-play" className="nav-link hidden sm:inline-flex">
            How to play <ArrowUpRight size={14} aria-hidden="true" />
          </a>
          {viewer ? (
            <div className="host-menu">
              <span className="flex items-center gap-2">
                <span className="status-dot" />
                <span className="max-w-32 truncate">@{viewer.login}</span>
              </span>
              <form action="/api/auth/logout" method="post">
                <button
                  className="icon-button"
                  type="submit"
                  aria-label="Sign out of GitHub"
                  title="Sign out"
                >
                  <LogOut size={16} aria-hidden="true" />
                </button>
              </form>
            </div>
          ) : (
            <span className="header-tag">
              <GitBranch size={14} aria-hidden="true" /> a party in your git
              history
            </span>
          )}
        </nav>
      </header>

      <main id="main-content" className="setup-main">
        <section className="hero" aria-labelledby="hero-heading">
          <div className="eyebrow">
            <span className="status-dot" /> THE NO-CONTEXT COMMIT GAME
          </div>
          <h1 id="hero-heading">
            Good friends.
            <br />
            <span>Bad commits.</span>
          </h1>
          <p className="hero-description">
            Somewhere in your git history is a cry for help.
            <br className="hidden lg:block" />
            Let&apos;s find out who wrote it.
          </p>

          <figure
            className="preview-card"
            aria-label="Example game card with a fictional commit"
          >
            <div className="preview-topline">
              <span className="flex items-center gap-2">
                <GitCommitHorizontal size={17} aria-hidden="true" /> commit{" "}
                <span className="redacted">???????</span>
              </span>
              <span className="tiny-tag">AUTHOR HIDDEN</span>
            </div>
            <div className="preview-message">
              <span className="quote-mark" aria-hidden="true">
                &ldquo;
              </span>
              this should definitely
              <br />
              not be in production
            </div>
            <div className="preview-bottom">
              <div className="avatar-stack" aria-hidden="true">
                {["M", "A", "S", "?"].map((name, index) => (
                  <Avatar key={name} name={name} index={index} />
                ))}
              </div>
              <span>
                Who looks guilty? <ArrowUpRight size={15} aria-hidden="true" />
              </span>
            </div>
            <span className="preview-caption">
              FICTIONAL COMMIT. VERY REAL ENERGY.
            </span>
          </figure>

          <div className="how-it-works" id="how-to-play">
            <h2 className="sr-only">How to play</h2>
            <div>
              <span className="step-number">01</span>
              <h3>Read the commit.</h3>
              <p>No author. No context.</p>
            </div>
            <div>
              <span className="step-number">02</span>
              <h3>Point the finger.</h3>
              <p>Everyone makes a guess.</p>
            </div>
            <div>
              <span className="step-number">03</span>
              <h3>Reveal the culprit.</h3>
              <p>Own it. Laugh. Repeat.</p>
            </div>
          </div>
        </section>

        <section className="setup-card" aria-labelledby="setup-heading">
          <div className="card-terminal-bar">
            <span className="flex gap-1.5" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>~/a-questionable-evening</span>
            <Terminal size={14} aria-hidden="true" />
          </div>
          <div className="setup-card-body">
            <p className="terminal-command">
              <span>$</span> git blame --party
            </p>
            <h2 id="setup-heading">Assemble the suspects.</h2>
            <p className="setup-description">
              Your people. Their commits. Zero plausible deniability.
            </p>

            <div className="section-label">
              <span>01 / COMMIT ACCESS</span>
              {viewer ? (
                <LockKeyhole size={13} aria-hidden="true" />
              ) : (
                <Globe size={13} aria-hidden="true" />
              )}
            </div>
            {viewer ? (
              <div className="connected-card">
                <Avatar name={viewer.login} url={viewer.avatarUrl} />
                <div className="min-w-0 flex-1">
                  <strong className="block truncate">@{viewer.login}</strong>
                  <span>Public and accessible private commits.</span>
                </div>
                <Check
                  className="text-[var(--green)]"
                  size={19}
                  aria-hidden="true"
                />
              </div>
            ) : (
              <>
                <div className="connected-card">
                  <Globe
                    className="text-[var(--green)]"
                    size={24}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <strong>Public commits</strong>
                    <span>No account needed. Add names and play.</span>
                  </div>
                  <Check
                    className="text-[var(--green)]"
                    size={19}
                    aria-hidden="true"
                  />
                </div>
                <p className="access-note">
                  Public repositories only. GitHub&apos;s anonymous rate limits
                  are lower and shared by this server.
                </p>
                {authConfigured && (
                  <>
                    <a href={authUrl} className="button github-button mt-3">
                      <GitBranch size={19} aria-hidden="true" /> Connect for
                      private commits
                      <ArrowUpRight
                        className="ml-auto"
                        size={17}
                        aria-hidden="true"
                      />
                    </a>
                    <p className="access-note">
                      Optional: the host can sign in to include private repos
                      they can access. GitHub requires broad <code>repo</code>{" "}
                      permission; this app only reads.
                    </p>
                  </>
                )}
              </>
            )}
            {authError && (
              <p className="error-notice" role="alert">
                {authError}
              </p>
            )}

            <form
              onSubmit={(event) => {
                event.preventDefault();
                start();
              }}
            >
              <div className="section-label mt-7">
                <label htmlFor={`${id}-user-${players[0]?.key}`}>
                  02 / THE LINEUP
                </label>
                <span>
                  {players.length} / {MAX_PLAYERS}
                </span>
              </div>
              <div className="player-column-labels">
                <span>GITHUB USERNAME</span>
                <span>
                  NAME IN THE ROOM{" "}
                  <span className="normal-case">(optional)</span>
                </span>
              </div>
              <div className="player-list">
                {players.map((player, index) => (
                  <div className="player-row" key={player.key}>
                    <div className={`player-index player-color-${index % 4}`}>
                      {String(index + 1).padStart(2, "0")}
                    </div>
                    <div className="username-input">
                      <span aria-hidden="true">@</span>
                      <input
                        id={`${id}-user-${player.key}`}
                        aria-label={`Player ${index + 1} GitHub username`}
                        placeholder={
                          index === 0 ? "your-username" : "their-username"
                        }
                        value={player.username}
                        onChange={(event) =>
                          changePlayer(
                            player.key,
                            "username",
                            event.target.value,
                          )
                        }
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        maxLength={40}
                        required
                      />
                    </div>
                    <input
                      className="name-input"
                      aria-label={`Player ${index + 1} display name (optional)`}
                      placeholder={index === 0 ? "You" : "Your friend"}
                      value={player.displayName}
                      onChange={(event) =>
                        changePlayer(
                          player.key,
                          "displayName",
                          event.target.value,
                        )
                      }
                      maxLength={40}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="icon-button remove-player"
                      aria-label={`Remove player ${index + 1}`}
                      disabled={players.length <= 2}
                      onClick={() => {
                        setPlayers((current) =>
                          current.filter((row) => row.key !== player.key),
                        );
                        setError(null);
                      }}
                    >
                      <X size={15} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
              <button
                className="add-player"
                type="button"
                disabled={players.length >= MAX_PLAYERS}
                onClick={() => {
                  setPlayers((current) => [
                    ...current,
                    { key: nextKey, username: "", displayName: "" },
                  ]);
                  setNextKey((value) => value + 1);
                  setError(null);
                }}
              >
                <Plus size={16} aria-hidden="true" /> Add another suspect
              </button>
              {error && (
                <p className="error-notice" role="alert">
                  {error}
                </p>
              )}

              <button
                className="button button-primary start-button"
                type="submit"
              >
                Let the blaming begin{" "}
                <ArrowRight size={20} aria-hidden="true" />
              </button>
              <p className="start-caption">
                {viewer
                  ? "No round limit. No repeats. Plenty of evidence."
                  : "Public commits. No sign-in. No repeats."}
              </p>
            </form>
            <div className="demo-divider">
              <span />
              OR SKIP THE SETUP
              <span />
            </div>
            <button
              className="demo-button"
              type="button"
              onClick={() => onStart(players, true)}
            >
              <Play size={14} aria-hidden="true" /> Try a demo{" "}
              <ArrowRight size={15} aria-hidden="true" />
            </button>
            <p className="demo-note">
              Made-up commits. No sign-in. Same questionable decisions.
            </p>
          </div>
        </section>
      </main>
      <footer className="site-footer">
        <span>
          <GitCommitHorizontal size={15} aria-hidden="true" /> What happens in
          git stays in git. Until now.
        </span>
        <span>
          Bring any drink. Water counts.{" "}
          <span className="footer-separator">/</span> Not affiliated with
          GitHub.
        </span>
      </footer>
    </div>
  );
}
