import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Clock, Home, LogOut } from 'lucide-react';
import { JanusLogo } from '@/components/brand/JanusLogo';

interface PendingApprovalProps {
  isRejected?: boolean;
}

export function PendingApproval({ isRejected = false }: PendingApprovalProps) {
  const { signOut } = useAuth();

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
      style={{ background: '#141519' }}
    >
      {/* Ambient blobs */}
      <div
        className="absolute -top-32 -left-32 w-96 h-96 rounded-full blur-3xl pointer-events-none"
        style={{ background: 'radial-gradient(circle, #f1a32914 0%, transparent 70%)' }}
      />
      <div
        className="absolute -bottom-24 -right-24 w-72 h-72 rounded-full blur-3xl pointer-events-none"
        style={{ background: 'radial-gradient(circle, #c56a1d0d 0%, transparent 70%)' }}
      />

      <div
        className="w-full max-w-sm relative z-10 rounded-2xl shadow-2xl animate-fade-in"
        style={{
          background: 'rgba(28,29,36,0.97)',
          backdropFilter: 'blur(24px)',
          border: '1px solid rgba(241,163,41,0.10)',
          boxShadow: '0 0 60px -20px rgba(241,163,41,0.12), 0 25px 60px -15px rgba(0,0,0,0.6)',
        }}
      >
        {/* Logo + status icon */}
        <div className="flex flex-col items-center pt-10 pb-6 px-8">
          <div className="relative mb-5">
            <div className="janus-glow-soft rounded-full">
              <JanusLogo size="lg" variant="icon" />
            </div>
            {/* Status badge overlaid bottom-right */}
            <div
              className={`absolute -bottom-1 -right-1 w-7 h-7 rounded-full flex items-center justify-center shadow-lg ${
                isRejected ? 'bg-destructive' : 'bg-amber-500'
              }`}
            >
              {isRejected ? (
                <Home className="w-4 h-4 text-white" />
              ) : (
                <Clock className="w-4 h-4 text-[#141519]" />
              )}
            </div>
          </div>

          <h1 className="font-display text-3xl font-semibold janus-text-gradient tracking-tight">
            {isRejected ? 'Access Denied' : 'Pending Approval'}
          </h1>

          <div
            className="mt-6 w-full h-px"
            style={{ background: 'linear-gradient(to right, transparent, rgba(241,163,41,0.18), transparent)' }}
          />
        </div>

        {/* Content */}
        <div className="px-8 pb-10 space-y-5">
          <p className="text-sm font-body text-center leading-relaxed" style={{ color: 'rgba(236,229,219,0.60)' }}>
            {isRejected
              ? 'Your access request has been denied. Please contact the administrator for more information.'
              : 'Your account is awaiting approval from the administrator. You will be notified once your access has been granted.'}
          </p>
          {!isRejected && (
            <p className="text-xs text-center" style={{ color: 'rgba(236,229,219,0.35)' }}>
              This usually takes less than 24 hours.
            </p>
          )}
          <Button
            variant="outline"
            className="w-full gap-2 h-11"
            style={{ borderColor: 'rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.03)' }}
            onClick={signOut}
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </Button>
        </div>
      </div>
    </div>
  );
}
