import React from 'react';
import { RefreshCw, AlertTriangle, WifiOff } from 'lucide-react';
import { reportError, isChunkLoadError, isOffline, attemptChunkRecovery, hardReload } from '@/lib/errorReporter';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  name?: string;
  /** When true, renders the actual error.message in the fallback so the admin can read it. */
  showDetails?: boolean;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  isChunkError: boolean;
  isOffline: boolean;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, isChunkError: false, isOffline: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    const chunkError = isChunkLoadError(error);
    // A failed dynamic import while offline is a connectivity problem, not a
    // deploy problem — flag it so the fallback shows a friendly offline message
    // instead of the misleading "new version was deployed" card.
    return { hasError: true, error, isChunkError: chunkError, isOffline: chunkError && isOffline() };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`ErrorBoundary [${this.props.name || 'unnamed'}]:`, error, info.componentStack);
    reportError(error, info.componentStack || undefined, `error-boundary:${this.props.name || 'unnamed'}`);

    // attemptChunkRecovery is a no-op while offline (it would wipe caches and
    // leave nothing to load), so this only fires for genuine deploy errors.
    if (isChunkLoadError(error)) {
      attemptChunkRecovery();
    }
  }

  resetErrorBoundary = () => {
    this.setState({ hasError: false, error: null, isChunkError: false, isOffline: false });
  };

  render() {
    if (this.state.hasError) {
      if (this.state.isOffline) {
        return (
          <div className="rounded-lg border border-border bg-card p-4 flex items-start gap-3">
            <WifiOff className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">You appear to be offline</p>
              <p className="text-xs text-muted-foreground mt-0.5">This page couldn't load because there's no network connection. Reconnect and try again.</p>
            </div>
            <button
              data-testid="button-retry-offline"
              onClick={this.resetErrorBoundary}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors shrink-0"
            >
              <RefreshCw className="h-3 w-3" />
              Try again
            </button>
          </div>
        );
      }

      if (this.state.isChunkError) {
        return (
          <div className="rounded-lg border border-border bg-card p-4 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">Couldn't load this page</p>
              <p className="text-xs text-muted-foreground mt-0.5">This usually means a new version was deployed. Hard reload to fetch it.</p>
            </div>
            <button
              data-testid="button-hard-reload"
              onClick={hardReload}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors shrink-0"
            >
              <RefreshCw className="h-3 w-3" />
              Hard reload
            </button>
          </div>
        );
      }

      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Something went wrong</p>
            <button
              data-testid="button-retry-error-boundary"
              onClick={this.resetErrorBoundary}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors shrink-0"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          </div>
          {this.props.showDetails && this.state.error && (
            <p className="text-xs font-mono text-destructive break-all bg-destructive/5 rounded px-2 py-1">
              {this.props.name ? `[${this.props.name}] ` : ''}{this.state.error.message}
            </p>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
