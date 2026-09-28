import { useState, useEffect } from 'react';
import { apiClient } from '@/lib/apiClient';
import { useAuth } from './useAuth';
import { useToast } from './use-toast';

interface AmazonSettings {
  id: string;
  amazon_email: string;
  configured_by: string;
  created_at: string;
  updated_at: string;
}

async function vaultRequest(action: string, body?: object) {
  return apiClient.post(`/api/credential-vault?action=${action}`, body);
}

export function useAmazonSettings() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [settings, setSettings] = useState<AmazonSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    fetchSettings();
  }, [user]);

  const fetchSettings = async () => {
    try {
      const { data } = await apiClient.dbMaybeSingle<AmazonSettings>({
        table: 'amazon_settings',
        select: 'id, amazon_email, configured_by, created_at, updated_at',
      });
      if (data) {
        setSettings(data);
      }
    } catch (error) {
      console.error('Error fetching Amazon settings:', error);
    }
    setLoading(false);
  };

  const saveSettings = async (email: string, password: string) => {
    if (!user) return { success: false };
    setSaving(true);

    try {
      await vaultRequest('save-amazon-settings', { email, password });
      toast({ title: 'Amazon settings saved' });
      await fetchSettings();
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save';
      toast({ title: 'Error', description: message, variant: 'destructive' });
      return { success: false };
    } finally {
      setSaving(false);
    }
  };

  const deleteSettings = async () => {
    if (!settings) return;
    setSaving(true);

    try {
      await vaultRequest('delete-amazon-settings', { id: settings.id });
      setSettings(null);
      toast({ title: 'Amazon account disconnected' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to delete';
      toast({ title: 'Error', description: message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return { settings, loading, saving, saveSettings, deleteSettings, isConfigured: !!settings };
}
