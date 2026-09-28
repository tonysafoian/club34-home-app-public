import { useState, useEffect, useCallback, ReactNode } from 'react';
import { clearStoredToken } from '@/lib/api/fetchWithAuth';
import { apiClient } from '@/lib/apiClient';
import { AuthContext, AuthUser } from '@/hooks/useAuth';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const data = await apiClient.get<{ user: AuthUser | null }>('/api/auth/me');
      setUser(data.user || null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const signOut = async () => {
    try {
      await apiClient.post('/api/auth/logout');
    } finally {
      clearStoredToken();
      setUser(null);
      window.location.href = '/';
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, signOut, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}
