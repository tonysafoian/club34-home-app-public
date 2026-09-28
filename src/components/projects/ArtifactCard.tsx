import { FileText, Image, Table, Code, BookOpen, ListChecks, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { JanusProjectArtifact } from '@/hooks/useProjects';
import ReactMarkdown from 'react-markdown';
import { format } from 'date-fns';

const TYPE_ICONS: Record<string, React.ElementType> = {
  text: FileText,
  image: Image,
  table: Table,
  code: Code,
  summary: BookOpen,
  action_plan: ListChecks,
};

interface Props {
  artifact: JanusProjectArtifact;
  onDelete: (id: string) => void;
}

export function ArtifactCard({ artifact, onDelete }: Props) {
  const Icon = TYPE_ICONS[artifact.artifact_type] || FileText;

  // Detect markdown image syntax: ![alt](url)
  const mdImageMatch = artifact.content.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
  const isImage = artifact.artifact_type === 'image' || !!mdImageMatch;
  const imageUrl = artifact.artifact_type === 'image' ? artifact.content : mdImageMatch?.[2];

  return (
    <Card className="group relative overflow-hidden">
      <CardHeader className="p-3 pb-1 flex flex-row items-start gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">{artifact.title}</p>
            <p className="text-[10px] text-muted-foreground">
              {format(new Date(artifact.created_at), 'MMM d, h:mm a')}
              {artifact.saved_by_display_name && (
                <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded bg-muted text-[9px] font-medium">
                  Saved by {artifact.saved_by_display_name}
                </span>
              )}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
          onClick={() => onDelete(artifact.id)}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </CardHeader>
      <CardContent className="p-3 pt-1">
        {isImage && imageUrl ? (
          <img
            src={imageUrl}
            alt={artifact.title}
            className="rounded-lg max-w-full max-h-48 object-contain cursor-pointer"
            onClick={() => window.open(imageUrl, '_blank')}
          />
        ) : (
          <div className="text-xs text-muted-foreground prose prose-sm dark:prose-invert max-w-none max-h-32 overflow-hidden relative">
            <ReactMarkdown components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{artifact.content.slice(0, 500)}</ReactMarkdown>
            {artifact.content.length > 500 && (
              <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-card to-transparent" />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
