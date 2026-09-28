import { useNavigate } from 'react-router-dom';
import { useUserRole } from '@/hooks/useUserRole';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ArrowLeft, Shield, Check, X, Eye, Loader2 } from 'lucide-react';

interface AccessRow {
  capability: string;
  admin: 'full' | 'yes' | 'no';
  member: 'full' | 'yes' | 'view' | 'no' | 'crud-no-delete';
  notes?: string;
}

const ACCESS_MATRIX: AccessRow[] = [
  { capability: 'Chat / General Q&A', admin: 'yes', member: 'yes' },
  { capability: 'Weather & Wardrobe', admin: 'yes', member: 'yes' },
  { capability: 'Send SMS', admin: 'yes', member: 'yes' },
  { capability: 'Send WhatsApp', admin: 'yes', member: 'yes' },
  { capability: 'Send Email', admin: 'yes', member: 'no', notes: 'Only admin can send emails via Janus' },
  { capability: 'Voice & Vision Input', admin: 'yes', member: 'yes' },
  { capability: 'All Household Calendars', admin: 'full', member: 'view', notes: 'Members can view all family calendars (read-only)' },
  { capability: 'Notion (Query & Update)', admin: 'full', member: 'crud-no-delete', notes: 'Members can create, read, update — but not delete' },
  { capability: 'Notion Batch Updates', admin: 'yes', member: 'no', notes: 'Bulk operations restricted to admin' },
  { capability: 'Tesla Vehicles', admin: 'full', member: 'view', notes: 'Members can view status but not send commands' },
  { capability: 'Security Cameras / POI', admin: 'full', member: 'view', notes: 'Members can view feeds and POI data, not edit' },
  { capability: 'Home Systems (Pool, Sauna, Garage, Crestron)', admin: 'full', member: 'full', notes: 'All family members can view and control' },
  { capability: 'Amazon Orders', admin: 'full', member: 'yes', notes: 'Members see own orders only' },
  { capability: 'Automations Management', admin: 'yes', member: 'no' },
  { capability: 'User / Admin Management', admin: 'yes', member: 'no' },
];

function AccessBadge({ level }: { level: string }) {
  switch (level) {
    case 'full':
      return <Badge className="bg-green-500/10 text-green-600 hover:bg-green-500/20 gap-1"><Check className="h-3 w-3" />Full</Badge>;
    case 'yes':
      return <Badge className="bg-green-500/10 text-green-600 hover:bg-green-500/20 gap-1"><Check className="h-3 w-3" />Yes</Badge>;
    case 'view':
      return <Badge className="bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 gap-1"><Eye className="h-3 w-3" />View Only</Badge>;
    case 'crud-no-delete':
      return <Badge className="bg-amber-500/10 text-amber-600 hover:bg-amber-500/20">Create/Read/Update</Badge>;
    case 'no':
      return <Badge className="bg-red-500/10 text-red-600 hover:bg-red-500/20 gap-1"><X className="h-3 w-3" />No</Badge>;
    default:
      return <Badge variant="outline">{level}</Badge>;
  }
}

export default function JanusAccess() {
  const navigate = useNavigate();
  const { isAdmin, loading } = useUserRole();

  useEffect(() => {
    if (!loading && !isAdmin) navigate('/');
  }, [isAdmin, loading, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAdmin) return null;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 w-full border-b border-border/50 bg-background/80 backdrop-blur-xl pt-[env(safe-area-inset-top)]">
        <div className="container flex h-12 md:h-14 items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/admin/users')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Shield className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">Janus Access Control</h1>
              <p className="text-xs text-muted-foreground">Role-based permissions for the Janus AI assistant</p>
            </div>
          </div>
        </div>
      </header>

      <main className="container py-6 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Access Matrix</CardTitle>
            <CardDescription>
              What each role can do through Janus. These rules are enforced server-side — restricted tools are not available to non-admin users.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[300px]">Capability</TableHead>
                  <TableHead>Admin</TableHead>
                  <TableHead>Member</TableHead>
                  <TableHead className="hidden md:table-cell">Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ACCESS_MATRIX.map((row) => (
                  <TableRow key={row.capability}>
                    <TableCell className="font-medium">{row.capability}</TableCell>
                    <TableCell><AccessBadge level={row.admin} /></TableCell>
                    <TableCell><AccessBadge level={row.member} /></TableCell>
                    <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                      {row.notes || '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>How It Works</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm dark:prose-invert max-w-none">
            <ul>
              <li><strong>Server-side enforcement:</strong> The user's role is sent with each Janus request. The backend filters available tools before the AI processes the request — restricted tools are never offered to non-admin users.</li>
              <li><strong>System prompt injection:</strong> The AI receives role-specific instructions that guide its behavior, ensuring it doesn't offer capabilities the user can't access.</li>
              <li><strong>No client-side bypass:</strong> Even if a user manipulates the frontend, the backend validates the role and rejects unauthorized tool calls.</li>
            </ul>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}