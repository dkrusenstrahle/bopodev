export const uiStyles = {
  shell: "min-h-screen bg-bopo-bg text-bopo-text",
  card: "rounded-xl border border-bopo-border bg-bopo-panel",
  cardHeader: "border-b border-bopo-border px-4 py-3 text-base font-medium tracking-tight",
  cardBody: "px-4 py-4",
  muted: "text-bopo-muted",
  tableHeader: "bg-bopo-panel-elevated text-base uppercase tracking-wide text-bopo-muted",
  input:
    "h-9 w-full rounded-lg border border-bopo-border bg-bopo-panel-elevated px-3 text-base text-bopo-text outline-none transition placeholder:text-bopo-muted/80 focus:border-bopo-accent focus:ring-2 focus:ring-bopo-accent/20",
  buttonBase:
    "inline-flex h-9 items-center justify-center rounded-lg border px-3 text-base font-medium transition disabled:cursor-not-allowed disabled:opacity-60",
  buttonGhost: "border-bopo-border bg-transparent text-bopo-text hover:bg-bopo-panel-elevated",
  buttonPrimary: "border-bopo-accent bg-bopo-accent text-white hover:brightness-110",
  badge: "inline-flex items-center rounded-md border px-2 py-0.5 text-base",
  modalOverlay: "fixed inset-0 z-50 bg-black/70 backdrop-blur-sm",
  modalContent:
    "fixed left-1/2 top-1/2 z-50 w-[min(720px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-bopo-border bg-bopo-panel p-5",
  modalTitle: "text-base font-semibold tracking-tight text-bopo-text",
  modalDescription: "mt-1 text-base leading-6 text-bopo-muted"
} as const;
