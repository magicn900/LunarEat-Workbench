export type Account = { id: string; username: string; administrator: number; disabled: number };
export type Member = { userId: string; projectId: string; scopes: string[] };
export type AdminData = { users: Account[]; projects: { id: string; name: string; archived: number; version: number }[]; members: Member[]; tokens: { id: string; userId: string; username: string; projectId: string; name: string; scopes: string[]; created: string }[] };
export type RemovalTarget = { kind: 'account' | 'project' | 'member'; id: string; projectId?: string };
export type RemovalImpact = RemovalTarget & { name: string; expected: string; projects: { id: string; name: string }[]; counts: { members: number; workspaces: number; unpublished: number; tokens: number; revisions: number; notes: number }; drafts: { projectId: string; projectName: string }[]; blockers: string[] };
