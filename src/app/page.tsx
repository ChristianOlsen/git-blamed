import { GitBlamed } from "@/components/git-blamed";
import { getViewer, isAuthConfigured } from "@/lib/auth";
import { playersFromParams, type SearchParams } from "@/lib/game";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [params, viewer] = await Promise.all([searchParams, getViewer()]);
  const authError = Array.isArray(params.authError)
    ? params.authError[0]
    : params.authError;

  return (
    <GitBlamed
      initialPlayers={playersFromParams(params)}
      viewer={viewer}
      authConfigured={isAuthConfigured()}
      authError={authError?.slice(0, 300)}
    />
  );
}
