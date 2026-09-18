import { ArrowUpRight, LoaderCircle, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  isAvatarUrl,
  isRecord,
  isSecureTokenOrigin,
  isUsername,
} from "@/lib/backend-errors";
import type { Viewer } from "@/lib/types";

export function ConnectDialog({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: (token: string, viewer: Viewer) => void;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    dialogRef.current?.showModal();
    inputRef.current?.focus();
    return () => requestRef.current?.abort();
  }, []);

  async function connect() {
    if (requestRef.current) return;
    if (!isSecureTokenOrigin(window.location.origin)) {
      setError("Use HTTPS to connect GitHub outside localhost.");
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(true);
    setError(null);
    const value = token.trim();
    try {
      const response = await fetch("/api/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: value }),
        cache: "no-store",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(20_000),
        ]),
      });
      if (!response.headers.get("content-type")?.includes("application/json")) {
        throw new Error("Unable to connect to GitHub. Try again.");
      }
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
          isRecord(body) && typeof body.error === "string"
            ? body.error
            : "Unable to connect to GitHub. Try again.",
        );
      }
      if (
        !isRecord(body) ||
        !isUsername(body.login) ||
        !isAvatarUrl(body.avatarUrl)
      ) {
        throw new Error("GitHub returned an invalid profile. Try again.");
      }
      if (controller.signal.aborted) return;
      setToken("");
      onConnected(value, { login: body.login, avatarUrl: body.avatarUrl });
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(
          cause instanceof Error && cause.name === "TimeoutError"
            ? "GitHub took too long to respond. Try again."
            : cause instanceof Error
              ? cause.message
              : "Unable to connect to GitHub. Try again.",
        );
      }
    } finally {
      if (!controller.signal.aborted) setPending(false);
      requestRef.current = null;
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="connect-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={onClose}
    >
      <div className="dialog-header">
        <h2 id={`${id}-title`}>Connect GitHub</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close connection dialog"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        <div className="token-label">
          <label htmlFor={`${id}-token`}>Personal access token</label>
          <a
            href="https://github.com/settings/tokens"
            target="_blank"
            rel="noopener noreferrer"
          >
            Create token <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </div>
        <input
          ref={inputRef}
          id={`${id}-token`}
          className="token-input"
          type="password"
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
            setError(null);
          }}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={512}
          required
          disabled={pending}
          aria-invalid={!!error}
          aria-describedby={`${id}-privacy${error ? ` ${id}-error` : ""}`}
        />
        <p className="token-help" id={`${id}-privacy`}>
          Kept in memory for this page only. Refreshing or signing out clears
          it.
        </p>
        <details className="token-permissions">
          <summary>Private repositories and SSO</summary>
          <p>
            For a classic token, enable <code>repo</code> and authorize your
            organization under Configure SSO. Fine-grained tokens must include
            the organization&apos;s repositories and may need admin approval.
            Only connect tokens you are authorized to use here.
          </p>
        </details>
        {error && (
          <p id={`${id}-error`} className="error-notice" role="alert">
            {error}
          </p>
        )}
        <button
          className="button button-primary token-submit"
          type="submit"
          disabled={pending || !token.trim()}
        >
          {pending ? (
            <>
              <LoaderCircle
                className="animate-spin"
                size={18}
                aria-hidden="true"
              />{" "}
              Connecting...
            </>
          ) : (
            "Connect"
          )}
        </button>
      </form>
    </dialog>
  );
}
