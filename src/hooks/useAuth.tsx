import { createContext, useContext } from 'react';

export interface AuthUser {
  userId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  roles: string[];
  approvalStatus: string;
}

export interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
