import { ReactNode } from 'react';
import { SystemCard } from '@/components/dashboard/SystemCard';
import { Badge } from '@/components/ui/badge';
import { PlugZap } from 'lucide-react';

interface PlannedFeature {
  icon: ReactNode;
  title: string;
  description: string;
}

interface AwaitingIntegrationProps {
  /** System name shown as the card title, e.g. "Starlink Internet". */
  title: string;
  /** Card icon (lucide icon element). */
  icon: ReactNode;
  /** Tailwind accent background class for the icon chip, e.g. "bg-sky-500/10". */
  accentColor?: string;
  /** One-line honest explanation of why this isn't wired up yet. */
  description: string;
  /** Optional ETA / status note, e.g. "Planned for Q3 2026". */
  eta?: string;
  /** Optional list of planned features to preview. */
  plannedFeatures?: PlannedFeature[];
  /** data-testid prefix for the placeholder block (defaults to a slug of title). */
  testIdPrefix?: string;
}

/**
 * Single, honest placeholder card for systems that are not yet wired to a
 * real data source. Use this anywhere a system is "coming soon" instead of
 * shipping mock data or bespoke placeholder markup.
 *
 * It renders metrics as em-dashes and an explicit "Awaiting integration"
 * badge so users understand the card is intentionally empty — not broken.
 */
export function AwaitingIntegration({
  title,
  icon,
  accentColor,
  description,
  eta,
  plannedFeatures = [],
  testIdPrefix,
}: AwaitingIntegrationProps) {
  const slug =
    testIdPrefix ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  return (
    <SystemCard
      title={title}
      icon={icon}
      status="idle"
      statusText="Not Connected"
      accentColor={accentColor}
      metrics={[
        { label: 'Status', value: '—' },
        { label: 'Data', value: '—' },
      ]}
      expandable={true}
    >
      <div
        className="flex flex-col items-center gap-4 py-6 px-4 text-center"
        data-testid={`awaiting-${slug}`}
      >
        <div className={accentColor ? `rounded-full p-4 ${accentColor}` : 'rounded-full bg-muted p-4'}>
          {icon}
        </div>
        <div className="space-y-2">
          <p className="text-sm font-semibold" data-testid={`text-${slug}-placeholder`}>
            {title} — Awaiting Integration
          </p>
          <p className="text-xs text-muted-foreground max-w-sm">{description}</p>
          {eta && (
            <p className="text-[11px] text-muted-foreground/80 font-medium">{eta}</p>
          )}
        </div>

        {plannedFeatures.length > 0 && (
          <div className="w-full border-t border-border pt-4 space-y-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Planned Features
            </p>
            <div className="grid grid-cols-1 gap-2 text-xs text-left">
              {plannedFeatures.map((f) => (
                <div
                  key={f.title}
                  className="flex items-start gap-2 bg-muted/50 rounded-lg p-3"
                >
                  <span className="mt-0.5 shrink-0">{f.icon}</span>
                  <div>
                    <p className="font-medium">{f.title}</p>
                    <p className="text-[10px] text-muted-foreground">{f.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <Badge
          variant="outline"
          className="text-[10px] mt-2"
          data-testid={`badge-${slug}-status`}
        >
          <PlugZap className="h-3 w-3 mr-1" />
          Awaiting integration
        </Badge>
      </div>
    </SystemCard>
  );
}
