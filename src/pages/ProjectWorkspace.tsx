import { useState } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useParams, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProject } from '@/hooks/useProjects';
import { useIsMobile } from '@/hooks/use-mobile';
import { ProjectHeader } from '@/components/projects/ProjectHeader';
import { ProjectChat } from '@/components/projects/ProjectChat';
import { ProjectArtifacts } from '@/components/projects/ProjectArtifacts';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useProjectArtifacts } from '@/hooks/useProjects';

export default function ProjectWorkspace() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { data: project, isLoading } = useProject(id);
  const { data: artifacts = [] } = useProjectArtifacts(id);
  const isMobile = useIsMobile();
  const [isFirstMessage, setIsFirstMessage] = useState(true);

  if (!user) return <Navigate to="/" replace />;
  if (!id) return <Navigate to="/projects" replace />;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!project) return <Navigate to="/projects" replace />;

  return (
    <div className="h-dvh flex flex-col bg-background overflow-hidden">
      <ProjectHeader project={project} />
      {isMobile ? (
        <Tabs defaultValue="chat" className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="mx-4 mt-2 flex-shrink-0">
            <TabsTrigger value="chat" className="flex-1">Chat</TabsTrigger>
            <TabsTrigger value="artifacts" className="flex-1">
              Artifacts {artifacts.length > 0 && `(${artifacts.length})`}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="chat" className="flex-1 overflow-hidden mt-0">
            <ErrorBoundary name="project-chat">
              <ProjectChat
                projectId={id}
                projectName={project.name}
                isFirstMessage={isFirstMessage}
                onFirstMessage={() => setIsFirstMessage(false)}
              />
            </ErrorBoundary>
          </TabsContent>
          <TabsContent value="artifacts" className="flex-1 overflow-hidden mt-0">
            <ErrorBoundary name="project-artifacts">
              <ProjectArtifacts projectId={id} />
            </ErrorBoundary>
          </TabsContent>
        </Tabs>
      ) : (
        <ResizablePanelGroup direction="horizontal" className="flex-1">
          <ResizablePanel defaultSize={40} minSize={25}>
            <ErrorBoundary name="project-chat">
              <ProjectChat
                projectId={id}
                projectName={project.name}
                isFirstMessage={isFirstMessage}
                onFirstMessage={() => setIsFirstMessage(false)}
              />
            </ErrorBoundary>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={60} minSize={35}>
            <ErrorBoundary name="project-artifacts">
              <ProjectArtifacts projectId={id} />
            </ErrorBoundary>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}
