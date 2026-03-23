"use client";

import { useState, type ComponentProps } from "react";
import { Apple, Folder, HelpCircle, Monitor, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { FieldLabel } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export function RuntimeCwdPathHelpDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="gap-4">
        <DialogHeader>
          <DialogTitle>How to get a full path</DialogTitle>
          <DialogDescription className="text-base text-foreground/90">
            Paste the absolute path (e.g. <code className="rounded bg-muted px-1.5 py-0.5 text-sm">/Users/you/project</code>) into
            the input field.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="macos" className="w-full">
          <TabsList className="mb-2 grid h-auto w-full grid-cols-3 gap-1 p-1">
            <TabsTrigger
              value="macos"
              className="gap-1.5 data-[state=active]:border data-[state=active]:border-primary data-[state=active]:bg-background"
            >
              <Apple className="size-4 shrink-0" aria-hidden />
              macOS
            </TabsTrigger>
            <TabsTrigger
              value="windows"
              className="gap-1.5 data-[state=active]:border data-[state=active]:border-primary data-[state=active]:bg-background"
            >
              <Monitor className="size-4 shrink-0" aria-hidden />
              Windows
            </TabsTrigger>
            <TabsTrigger
              value="linux"
              className="gap-1.5 data-[state=active]:border data-[state=active]:border-primary data-[state=active]:bg-background"
            >
              <Terminal className="size-4 shrink-0" aria-hidden />
              Linux
            </TabsTrigger>
          </TabsList>
          <TabsContent value="macos" className="mt-0 space-y-4">
            <ol className="list-decimal space-y-2 pl-5 text-base text-foreground">
              <li>Open Finder and navigate to the folder.</li>
              <li>Right-click (or Control-click) the folder.</li>
              <li>
                Hold the Option (⌥) key — <strong>Copy</strong> changes to <strong>Copy as Pathname</strong>.
              </li>
              <li>
                Click <strong>Copy as Pathname</strong>, then paste into the field.
              </li>
            </ol>
            <blockquote className="border-l-4 border-muted pl-4 text-sm text-muted-foreground">
              You can also open Terminal, type <code className="rounded bg-muted px-1 py-0.5 text-xs">cd</code>, drag the folder into
              the terminal window, and press Enter. Then type <code className="rounded bg-muted px-1 py-0.5 text-xs">pwd</code> to see
              the full path.
            </blockquote>
          </TabsContent>
          <TabsContent value="windows" className="mt-0 space-y-4">
            <ol className="list-decimal space-y-2 pl-5 text-base text-foreground">
              <li>Open File Explorer and go to the folder.</li>
              <li>Click the address bar once so the full path is selected, then press Ctrl+C to copy.</li>
              <li>
                Or: Shift+right-click the folder and choose <strong>Copy as path</strong>.
              </li>
              <li>Paste into the field (remove surrounding quotes if you do not want them).</li>
            </ol>
            <blockquote className="border-l-4 border-muted pl-4 text-sm text-muted-foreground">
              In PowerShell, you can run <code className="rounded bg-muted px-1 py-0.5 text-xs">(Get-Location).Path</code> after{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">cd</code> into the folder.
            </blockquote>
          </TabsContent>
          <TabsContent value="linux" className="mt-0 space-y-4">
            <ol className="list-decimal space-y-2 pl-5 text-base text-foreground">
              <li>Open your file manager and navigate to the folder.</li>
              <li>
                Press Ctrl+L (in many managers) to focus the location bar, select all, and copy the path — or copy it from the path
                display if your file manager shows it.
              </li>
              <li>
                Or: open a terminal, type <code className="rounded bg-muted px-1 py-0.5 text-xs">cd </code> (with a trailing space),
                drag the folder into the window, press Enter, then run <code className="rounded bg-muted px-1 py-0.5 text-xs">pwd</code>.
              </li>
            </ol>
            <blockquote className="border-l-4 border-muted pl-4 text-sm text-muted-foreground">
              For a given folder in the shell: <code className="rounded bg-muted px-1 py-0.5 text-xs">realpath your-folder</code> or{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">readlink -f your-folder</code> prints the absolute path.
            </blockquote>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

type RuntimeCwdPathInputProps = Omit<ComponentProps<"input">, "type"> & {
  label: string;
};

export function RuntimeCwdPathInput({
  id,
  label,
  className,
  placeholder = "/path/to/workspace",
  ...inputProps
}: RuntimeCwdPathInputProps) {
  const [helpOpen, setHelpOpen] = useState(false);

  const openHelp = () => setHelpOpen(true);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <button
          type="button"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border/80 bg-background text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          onClick={openHelp}
          aria-label="How to get a full path"
        >
          <HelpCircle className="size-3.5" aria-hidden />
        </button>
      </div>
      <div
        className={cn(
          "flex h-9 w-full min-w-0 items-center rounded-md border border-input bg-transparent text-base transition-[color,box-shadow] outline-none dark:bg-input/30",
          "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
        )}
      >
        <span className="flex shrink-0 items-center pl-3 text-muted-foreground" aria-hidden>
          <Folder className="size-4" />
        </span>
        <input
          {...inputProps}
          id={id}
          type="text"
          autoComplete="off"
          placeholder={placeholder}
          className={cn(
            "h-9 min-w-0 flex-1 border-0 bg-transparent px-2 py-0 text-base text-sidebar-foreground shadow-none outline-none",
            "placeholder:text-sidebar-foreground/60",
            "focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50",
            "dark:bg-transparent"
          )}
        />
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="mr-1.5 h-6 shrink-0 rounded-full px-2.5 text-xs font-medium"
          onClick={openHelp}
        >
          Choose
        </Button>
      </div>
      <RuntimeCwdPathHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

type RuntimeCwdPathHelpProps = {
  triggerLabel?: string;
  className?: string;
};

/** Text link trigger; prefer {@link RuntimeCwdPathInput} for the primary field layout. */
export function RuntimeCwdPathHelp({ triggerLabel = "How to get a full path", className }: RuntimeCwdPathHelpProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="link"
        className={cn(
          "h-auto p-0 text-base font-normal text-muted-foreground underline-offset-4 hover:text-foreground",
          className
        )}
        onClick={() => setOpen(true)}
      >
        {triggerLabel}
      </Button>
      <RuntimeCwdPathHelpDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
