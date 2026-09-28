import { useState, useEffect } from 'react';
import { Plus, PackageOpen, FileStack, Loader2, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ArtifactCard } from './ArtifactCard';
import { useProjectArtifacts, useAddArtifact, useDeleteArtifact, useProject, JanusProjectArtifact } from '@/hooks/useProjects';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { apiClient } from '@/lib/apiClient';
import { addNotionComment } from '@/lib/api/notion';

interface Props {
  projectId: string;
}

export function ProjectArtifacts({ projectId }: Props) {
  const { data: artifacts = [], isLoading } = useProjectArtifacts(projectId);
  const { data: project } = useProject(projectId);
  const addArtifact = useAddArtifact();
  const deleteArtifact = useDeleteArtifact();
  const { user } = useAuth();
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [assembling, setAssembling] = useState(false);

  useEffect(() => {
    if (!user) return;
    apiClient.dbMaybeSingle<{ display_name?: string | null }>({
      table: 'profiles',
      select: 'display_name',
      filters: [{ column: 'user_id', op: 'eq', value: user.userId }],
    }).then(({ data }) => {
      setDisplayName(data?.display_name || user.email || null);
    });
  }, [user]);

  const handleAdd = () => {
    if (!content.trim()) return;
    const artifactTitle = title.trim() || 'Note';
    const artifactContent = content.trim();
    addArtifact.mutate(
      {
        project_id: projectId,
        artifact_type: 'text',
        title: artifactTitle,
        content: artifactContent,
        sort_order: artifacts.length,
        saved_by_user_id: user?.userId,
        saved_by_display_name: displayName || undefined,
      },
      {
        onSuccess: () => {
          // Fire-and-forget Notion comment
          if (project?.notion_page_id) {
            addNotionComment(
              project.notion_page_id,
              `📌 Artifact: ${artifactTitle}\n\n${artifactContent.slice(0, 1800)}`
            ).catch(() => {});
          }
        },
      }
    );
    setTitle('');
    setContent('');
    setShowForm(false);
  };

  const handleDelete = (id: string) => {
    deleteArtifact.mutate({ id, project_id: projectId });
  };

  const handleAssemble = async () => {
    if (artifacts.length === 0) { toast({ title: 'No artifacts to assemble' }); return; }
    setAssembling(true);
    try {
      const resp = await apiClient.invokeFn<{ doc_url?: string }>('assemble-report', { project_id: projectId });
      const url = resp?.doc_url;
      toast({
        title: 'Report assembled',
        description: 'Google Doc created and emailed to all project participants.',
        action: url ? (
          <ToastAction altText="Open Doc" asChild>
            <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1">
              <ExternalLink className="h-3 w-3" /> Open
            </a>
          </ToastAction>
        ) : undefined,
      });
    } catch (e) {
      toast({ title: 'Assemble failed', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally { setAssembling(false); }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
        <h2 className="text-sm font-semibold">
          Artifacts {artifacts.length > 0 && <span className="text-muted-foreground">({artifacts.length})</span>}
        </h2>
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={handleAssemble} disabled={assembling || artifacts.length === 0}>
            {assembling ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FileStack className="h-3.5 w-3.5 mr-1" />}
            Assemble
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowForm(!showForm)}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            New
          </Button>
        </div>
      </div>

      {showForm && (
        <div className="p-3 border-b border-border space-y-2 flex-shrink-0">
          <Input
            placeholder="Title (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="text-sm"
          />
          <Textarea
            placeholder="Paste or type content..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="text-sm min-h-[80px]"
          />
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button size="sm" onClick={handleAdd} disabled={!content.trim()}>Save</Button>
          </div>
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="p-3 space-y-3">
          {isLoading && (
            <p className="text-sm text-muted-foreground text-center py-8">Loading...</p>
          )}
          {!isLoading && artifacts.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
              <PackageOpen className="h-10 w-10 text-muted-foreground/30" />
              <div>
                <p className="text-sm font-medium">No artifacts yet</p>
                <p className="text-xs mt-1">
                  Save responses from chat or add notes manually.
                </p>
              </div>
            </div>
          )}
          {artifacts.map((a) => (
            <ArtifactCard key={a.id} artifact={a} onDelete={handleDelete} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
