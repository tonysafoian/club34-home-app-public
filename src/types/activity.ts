export type ActivityEventType = 'motion' | 'access' | 'alarm' | 'camera' | 'system';
export type ActivitySeverity = 'info' | 'warning' | 'alert';

export interface ActivityEvent {
  id: string;
  user_id: string;
  event_type: ActivityEventType;
  source: string;
  zone: string | null;
  description: string;
  metadata: Record<string, unknown>;
  severity: ActivitySeverity;
  occurred_at: string;
  created_at: string;
}
