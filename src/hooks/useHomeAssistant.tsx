import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '@/lib/apiClient';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';

interface HomeAssistantSettings {
  id: string;
  ha_url: string | null;
  is_connected: boolean | null;
  last_connected_at: string | null;
  has_token?: boolean;
}

export function useHomeAssistant() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [settings, setSettings] = useState<HomeAssistantSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const fetchSettings = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      // Settings are read through the scoped HA endpoint — the table itself is
      // not accessible via the generic DB proxy (it holds the encrypted token).
      const data = await apiClient.post<{ settings: HomeAssistantSettings | null }>('/api/home-assistant', {
        action: 'get-settings',
      });
      setSettings(data?.settings ?? null);
    } catch (error) {
      console.error('Error fetching HA settings:', error);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (user) {
      fetchSettings();
    }
  }, [user, fetchSettings]);

  const saveSettings = async (haUrl: string, accessToken: string) => {
    if (!user) return { success: false };

    setSaving(true);

    try {
      const data = await apiClient.post<{ error?: string }>('/api/home-assistant', {
        action: 'save-settings',
        ha_url: haUrl,
        access_token: accessToken,
      });

      if (data?.error) throw new Error(data.error);

      await fetchSettings();
      toast({
        title: 'Settings saved',
        description: 'Your Home Assistant configuration has been saved securely.',
      });

      return { success: true };
    } catch (error: unknown) {
      console.error('Error saving HA settings:', error);
      toast({
        title: 'Error saving settings',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
      return { success: false };
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async (haUrl: string, accessToken: string) => {
    setTesting(true);

    try {
      const data = await apiClient.post<{ connected?: boolean; data?: { version?: string } & Record<string, unknown> }>('/api/home-assistant', {
        action: 'test-connection',
        ha_url: haUrl,
        access_token: accessToken,
      });

      if (data?.connected) {
        if (settings?.id) {
          await fetchSettings();
        }

        toast({
          title: 'Connection successful!',
          description: `Connected to Home Assistant ${data.data?.version || ''}`,
        });

        return { success: true, data: data.data };
      } else {
        throw new Error('Home Assistant did not respond successfully');
      }
    } catch (error: unknown) {
      console.error('Connection test failed:', error);
      toast({
        title: 'Connection failed',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });

      return { success: false, error };
    } finally {
      setTesting(false);
    }
  };

  const disconnect = async () => {
    if (!settings?.id) return;

    setSaving(true);
    try {
      // Server-side disconnect: only ever clears the authenticated user's own
      // stored token.
      const data = await apiClient.post<{ success?: boolean; error?: string }>('/api/home-assistant', {
        action: 'disconnect',
      });
      if (data?.error) throw new Error(data.error);

      await fetchSettings();
      toast({
        title: 'Disconnected',
        description: 'Home Assistant has been disconnected.',
      });
    } catch (error: unknown) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return {
    settings,
    loading,
    saving,
    testing,
    saveSettings,
    testConnection,
    disconnect,
    refetch: fetchSettings,
  };
}
