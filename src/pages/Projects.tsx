import { useState } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useNavigate } from 'react-router-dom';
import { Plus, FolderOpen, Loader2, ArrowLeft, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useProjects, useCreateProject } from '@/hooks/useProjects';
import { useAuth } from '@/hooks/useAuth';
import { format } from 'date-fns';
import { MobileBottomNav } from '@/components/dashboard/MobileBottomNav';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';

export default function Projects() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: projects, isLoading } = useProjects();
  const createProject = useCreateProject();
  const [search, setSearch] = useState('');

  if (!user) {
    navigate('/');
    return null;
  }

  const handleNew = async () => {
    const project = await createProject.mutateAsync('New Project');
    navigate(`/projects/${project.id}`);
  };

  const filtered = projects?.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-8">
      <DashboardHeader />
      <ErrorBoundary name="projects">
      <div className="max-w-3xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate('/')}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold">Projects</h1>
              <p className="text-sm text-muted-foreground">Janus workspaces with saved artifacts</p>
            </div>
          </div>
          <Button onClick={handleNew} disabled={createProject.isPending}>
            {createProject.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Plus className="h-4 w-4 mr-1.5" />}
            New Project
          </Button>
        </div>

        {/* Search */}
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search projects…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
          {search && filtered && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              {filtered.length} result{filtered.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {isLoading && (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {!isLoading && (!filtered || filtered.length === 0) && (
          <div className="flex flex-col items-center gap-4 py-20 text-center text-muted-foreground">
            <FolderOpen className="h-12 w-12 text-muted-foreground/30" />
            <div>
              <p className="text-base font-medium">{search ? 'No matching projects' : 'No projects yet'}</p>
              <p className="text-sm mt-1">{search ? 'Try a different search term.' : 'Create a project to start a Janus workspace with artifact tracking.'}</p>
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {filtered?.map((p) => (
            <Card
              key={p.id}
              className="cursor-pointer hover:border-primary/40 transition-colors"
              onClick={() => navigate(`/projects/${p.id}`)}
            >
              <CardHeader className="p-4 pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{p.name}</CardTitle>
                  {(p.artifact_count ?? 0) > 0 && (
                    <Badge variant="secondary" className="text-[10px] flex-shrink-0">{p.artifact_count} artifacts</Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <p className="text-xs text-muted-foreground">
                  {p.owner_name && <span>By {p.owner_name} · </span>}
                  Created {format(new Date(p.created_at), 'MMM d, yyyy')}
                  {p.updated_at !== p.created_at && ` · Updated ${format(new Date(p.updated_at), 'MMM d')}`}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
      </ErrorBoundary>
      <MobileBottomNav />
    </div>
  );
}
