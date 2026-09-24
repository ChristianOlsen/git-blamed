export type Player = {
  username: string;
};

export type Viewer = {
  login: string;
  avatarUrl: string;
};

export type CommitCard = {
  id: string;
  message: string;
  authors: Viewer[];
  url: string;
  repository: string;
  committedAt: string;
};

export type SearchCursor = {
  page: number;
  exhausted: boolean;
};

export type PullRequestReference = {
  repository: string;
  number: number;
};

export type PullRequestCursor = SearchCursor & {
  pending: PullRequestReference[];
  commitPage: number;
};

export type CommitCursor = {
  search: SearchCursor;
  pullRequests: PullRequestCursor;
  exhausted: boolean;
};

export type CommitBatch = {
  commits: CommitCard[];
  cursors: Record<string, CommitCursor>;
  warnings: string[];
  exhausted: boolean;
};

export type CommitRequest = {
  usernames: string[];
  cursors: Record<string, CommitCursor>;
  requireAuth?: boolean;
  /** Off turns the AI ranking pass off for this game; the heuristic still runs. */
  useAi?: boolean;
};

export type IndexedCommitBatch = Omit<CommitBatch, "cursors"> & {
  cursors: Record<string, SearchCursor>;
};

export type IndexedCommitRequest = Omit<CommitRequest, "cursors"> & {
  cursors: Record<string, SearchCursor>;
};
