import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, Zap, CheckCircle } from 'lucide-react';
import { useSharedHAEntities } from '@/hooks/useHAEntitiesContext';
import { activateScene } from '@/lib/api/homeAssistant';
import { useToast } from '@/hooks/use-toast';

export function HAScenesCard() {
  const { entities, loading, unavailable } = useSharedHAEntities('scene');
  const { toast } = useToast();
  const [activating, setActivating] = useState<string | null>(null);
  const [lastActivated, setLastActivated] = useState<string | null>(null);

  const handleActivate = async (entity_id: string, name: string) => {
    setActivating(entity_id);
    try {
      await activateScene(entity_id);
      setLastActivated(entity_id);
      toast({ title: `Scene activated`, description: name });
      setTimeout(() => setLastActivated(null), 3000);
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setActivating(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Zap className="h-5 w-5 text-yellow-400" />
          Scenes
        </CardTitle>
      </CardHeader>
      <CardContent>
        {unavailable ? (
          <p className="text-sm text-muted-foreground text-center py-4">Home Assistant is not connected</p>
        ) : loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : entities.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No scenes found</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {entities.map(entity => {
              const name = String(entity.attributes?.friendly_name || entity.entity_id.replace('scene.', ''));
              const isActivating = activating === entity.entity_id;
              const justActivated = lastActivated === entity.entity_id;
              return (
                <Button
                  key={entity.entity_id}
                  variant={justActivated ? 'default' : 'outline'}
                  size="sm"
                  className="h-8"
                  onClick={() => handleActivate(entity.entity_id, name)}
                  disabled={!!activating}
                >
                  {isActivating && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                  {justActivated && !isActivating && <CheckCircle className="mr-1 h-3 w-3" />}
                  {name}
                </Button>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
