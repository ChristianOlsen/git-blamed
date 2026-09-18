import { GitBlamed } from "@/components/git-blamed";
import { playersFromParams, type SearchParams } from "@/lib/game";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  return <GitBlamed initialPlayers={playersFromParams(params)} />;
}
