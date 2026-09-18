"use client";

import {
  ArrowRight,
  ArrowUpRight,
  Globe,
  LockKeyhole,
  LogOut,
} from "lucide-react";
import { useId, useState } from "react";
import {
  MAX_PLAYERS,
  partyUrl,
  playersFromInput,
  validatePlayers,
} from "@/lib/game";
import type { Player, Viewer } from "@/lib/types";
import { Logo } from "./ui";

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
  const [input, setInput] = useState(
    initialPlayers.map((player) => player.username).join(", "),
  );
  const [error, setError] = useState<string | null>(null);
  const players = playersFromInput(input);
  const authUrl = `/api/auth/github?returnTo=${encodeURIComponent(partyUrl(players))}`;

  return (
    <div className="app-shell">
      <header className="site-header">
        <a href="/" aria-label="gitblamed home">
          <Logo />
        </a>
        {viewer && (
          <div className="host-menu">
            <span className="host-username">@{viewer.login}</span>
            <form action="/api/auth/logout" method="post">
              <button
                className="icon-button"
                type="submit"
                aria-label="Sign out of GitHub"
                title="Sign out"
              >
                <LogOut size={18} aria-hidden="true" />
              </button>
            </form>
          </div>
        )}
      </header>

      <main className="setup-main">
        <section className="setup-panel" aria-labelledby={`${id}-heading`}>
          <div className="setup-heading">
            <h1 id={`${id}-heading`}>GitHub usernames</h1>
            <output
              className="player-count"
              htmlFor={`${id}-users`}
              aria-label={`${players.length} of ${MAX_PLAYERS} players`}
            >
              {players.length}/{MAX_PLAYERS}
            </output>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const validationError = validatePlayers(players);
              setError(validationError);
              if (!validationError) onStart(players, false);
            }}
          >
            <label className="sr-only" htmlFor={`${id}-users`}>
              GitHub usernames, separated by commas or new lines
            </label>
            <textarea
              id={`${id}-users`}
              className="username-list"
              placeholder="alice, bob, charlie"
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                setError(null);
              }}
              rows={3}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={1024}
              required
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-error` : undefined}
            />
            {error && (
              <p id={`${id}-error`} className="error-notice" role="alert">
                {error}
              </p>
            )}
            <div className="setup-actions">
              <button
                className="button button-primary start-button"
                type="submit"
              >
                Start <ArrowRight size={18} aria-hidden="true" />
              </button>
              <button
                className="button button-secondary"
                type="button"
                onClick={() => onStart(players, true)}
              >
                Demo
              </button>
            </div>
          </form>

          <div className="access-mode">
            {viewer ? (
              <LockKeyhole size={15} aria-hidden="true" />
            ) : (
              <Globe size={15} aria-hidden="true" />
            )}
            {viewer ? "Public + private commits" : "Public commits"}
          </div>
          {authConfigured && !viewer && (
            <details className="auth-options">
              <summary>Include private repositories</summary>
              <p>
                Optional host sign-in. Requires GitHub&apos;s broad{" "}
                <code>repo</code> permission; this app only reads.
              </p>
              <a href={authUrl} className="button button-secondary">
                Connect GitHub <ArrowUpRight size={16} aria-hidden="true" />
              </a>
            </details>
          )}
          {authError && (
            <p className="error-notice" role="alert">
              {authError}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
