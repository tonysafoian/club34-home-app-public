import { useState, useEffect, useCallback, ReactNode } from 'react';
import { clearStoredToken } from '@/lib/api/fetchWithAuth';
import { apiClient } from '@/lib/apiClient';
import { AuthContext, AuthUser } from '@/hooks/useAuth';
import { resolveAppPath } from '@/lib/ingress';

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
      // Use resolveAppPath to prevent breaking out to Home Assistant root in Ingress
      window.location.href = resolveAppPath('/');
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, signOut, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}
