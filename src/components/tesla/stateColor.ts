export function stateColor(state: string) {
  switch (state) {
    case 'online': return 'bg-[hsl(var(--status-online))] text-white';
    case 'asleep': return 'bg-[hsl(var(--status-idle))] text-white';
    default: return 'bg-[hsl(var(--status-offline))] text-white';
  }
}
