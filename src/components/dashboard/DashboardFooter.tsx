export function DashboardFooter() {
  return (
    <footer className="hidden md:block border-t border-border/40 py-6 text-center text-xs text-muted-foreground">
      © {new Date().getFullYear()} Club 34
    </footer>
  );
}
