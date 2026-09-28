import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Pencil, Archive, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUpdateProject, JanusProject } from '@/hooks/useProjects';
import { ShareProjectDialog } from './ShareProjectDialog';
import { NotionLinkDialog } from './NotionLinkDialog';

interface Props {
  project: JanusProject;
}

export function ProjectHeader({ project }: Props) {
  const navigate = useNavigate();
  const updateProject = useUpdateProject();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setName(project.name); }, [project.name]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const saveName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== project.name) {
      updateProject.mutate({ id: project.id, name: trimmed });
    }
    setEditing(false);
  };

  const archive = () => {
    updateProject.mutate({ id: project.id, status: 'archived' });
    navigate('/projects');
  };

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-background/95 backdrop-blur-sm flex-shrink-0 pt-[calc(0.75rem+env(safe-area-inset-top))]">
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate('/projects')}>
        <ArrowLeft className="h-4 w-4" />
      </Button>

      <div className="flex-1 min-w-0 flex items-center gap-2">
        {editing ? (
          <form onSubmit={(e) => { e.preventDefault(); saveName(); }} className="flex items-center gap-2 flex-1">
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              className="flex-1 bg-transparent text-lg font-semibold border-b border-primary outline-none"
            />
            <Button type="submit" variant="ghost" size="icon" className="h-7 w-7">
              <Check className="h-3.5 w-3.5" />
            </Button>
          </form>
        ) : (
          <button
            className="flex items-center gap-2 text-lg font-semibold truncate hover:text-primary transition-colors"
            onClick={() => setEditing(true)}
          >
            <span className="truncate">{project.name}</span>
            <Pencil className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          </button>
        )}
      </div>

      <NotionLinkDialog projectId={project.id} notionPageId={project.notion_page_id} />

      <ShareProjectDialog projectId={project.id} projectName={project.name} />

      <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={archive}>
        <Archive className="h-4 w-4 mr-1.5" />
        <span className="hidden sm:inline">Archive</span>
      </Button>
    </div>
  );
}
