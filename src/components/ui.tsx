import { GitBranch, GitCommitHorizontal } from "lucide-react";
import Image from "next/image";
import { initials } from "@/lib/game";

export function Logo() {
  return (
    <span className="wordmark">
      <span className="logo-mark">
        <GitBranch size={23} strokeWidth={2.3} aria-hidden="true" />
      </span>
      <span>
        git<span className="text-[var(--green)]">blamed</span>
        <span className="text-[var(--muted)]">.</span>
      </span>
    </span>
  );
}

export function Avatar({
  name,
  index = 0,
  url,
  large = false,
}: {
  name: string;
  index?: number;
  url?: string;
  large?: boolean;
}) {
  return (
    <span
      className={`avatar avatar-${index % 4}${large ? " avatar-large" : ""}`}
    >
      {url ? (
        <Image
          src={url}
          alt=""
          width={large ? 104 : 36}
          height={large ? 104 : 36}
          referrerPolicy="no-referrer"
          unoptimized
        />
      ) : (
        initials(name) || <GitCommitHorizontal size={18} aria-hidden="true" />
      )}
    </span>
  );
}
