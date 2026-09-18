export type Player = {
  username: string;
  displayName: string;
};

export type Viewer = {
  login: string;
  avatarUrl: string;
};

export type CommitCard = {
  id: string;
  message: string;
  author: string;
  avatarUrl: string;
  url: string;
  repository: string;
  committedAt: string;
};

export type CommitCursor = {
  page: number;
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
};
