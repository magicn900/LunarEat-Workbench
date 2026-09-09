import { createContext, useContext } from 'react';
import type { Preferences } from '../shared/preferences';
export type AccountIdentity = { id: string; username: string; administrator: boolean; preferences: Preferences; projects: { id: string; name: string; archived?: boolean; scopes: string[] }[] };
export type AccountActions = {
    identity: AccountIdentity;
    projectId: string;
    preferences: Preferences;
    savePreferences: (next: Preferences) => Promise<void>;
    openSettings: (trigger: HTMLElement) => void;
    switchProject: (id: string) => Promise<void>;
    signOut: () => Promise<void>;
    refreshIdentity: () => Promise<void>;
};
export const AccountContext = createContext<AccountActions | null>(null);
export function useAccount() { const context = useContext(AccountContext); if (!context) throw Error('AccountProvider missing'); return context; }
