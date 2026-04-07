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
      <DialogContent size="lg" className="ui-runtime-cwd-dialog-content">
        <DialogHeader>
          <DialogTitle>How to get a full path</DialogTitle>
          <DialogDescription className="ui-text-foreground-90">
            Paste the absolute path (e.g. <code className="ui-inline-code-sm">/Users/you/project</code>) into
            the input field.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="macos" className="ui-runtime-cwd-tabs">
          <TabsList className="ui-runtime-cwd-tabs-list">
            <TabsTrigger value="macos" className="ui-runtime-cwd-tabs-trigger">
              <Apple className="ui-icon-size-4 ui-shrink-0" aria-hidden />
              macOS
            </TabsTrigger>
            <TabsTrigger value="windows" className="ui-runtime-cwd-tabs-trigger">
              <Monitor className="ui-icon-size-4 ui-shrink-0" aria-hidden />
              Windows
            </TabsTrigger>
            <TabsTrigger value="linux" className="ui-runtime-cwd-tabs-trigger">
              <Terminal className="ui-icon-size-4 ui-shrink-0" aria-hidden />
              Linux
            </TabsTrigger>
          </TabsList>
          <TabsContent value="macos" className="ui-runtime-cwd-tabs-content">
            <ol className="ui-runtime-cwd-ol">
              <li>Open Finder and navigate to the folder.</li>
              <li>Right-click (or Control-click) the folder.</li>
              <li>
                Hold the Option (⌥) key — <strong>Copy</strong> changes to <strong>Copy as Pathname</strong>.
              </li>
              <li>
                Click <strong>Copy as Pathname</strong>, then paste into the field.
              </li>
            </ol>
            <blockquote className="ui-runtime-cwd-blockquote">
              You can also open Terminal, type <code className="ui-inline-code-xs">cd</code>, drag the folder into
              the terminal window, and press Enter. Then type <code className="ui-inline-code-xs">pwd</code> to see
              the full path.
            </blockquote>
          </TabsContent>
          <TabsContent value="windows" className="ui-runtime-cwd-tabs-content">
            <ol className="ui-runtime-cwd-ol">
              <li>Open File Explorer and go to the folder.</li>
              <li>Click the address bar once so the full path is selected, then press Ctrl+C to copy.</li>
              <li>
                Or: Shift+right-click the folder and choose <strong>Copy as path</strong>.
              </li>
              <li>Paste into the field (remove surrounding quotes if you do not want them).</li>
            </ol>
            <blockquote className="ui-runtime-cwd-blockquote">
              In PowerShell, you can run <code className="ui-inline-code-xs">(Get-Location).Path</code> after{" "}
              <code className="ui-inline-code-xs">cd</code> into the folder.
            </blockquote>
          </TabsContent>
          <TabsContent value="linux" className="ui-runtime-cwd-tabs-content">
            <ol className="ui-runtime-cwd-ol">
              <li>Open your file manager and navigate to the folder.</li>
              <li>
                Press Ctrl+L (in many managers) to focus the location bar, select all, and copy the path — or copy it from the path
                display if your file manager shows it.
              </li>
              <li>
                Or: open a terminal, type <code className="ui-inline-code-xs">cd </code> (with a trailing space),
                drag the folder into the window, press Enter, then run <code className="ui-inline-code-xs">pwd</code>.
              </li>
            </ol>
            <blockquote className="ui-runtime-cwd-blockquote">
              For a given folder in the shell: <code className="ui-inline-code-xs">realpath your-folder</code> or{" "}
              <code className="ui-inline-code-xs">readlink -f your-folder</code> prints the absolute path.
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
    <div className={cn("ui-runtime-cwd-field", className)}>
      <div className="ui-runtime-cwd-label-row">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <button
          type="button"
          className="ui-runtime-cwd-help-trigger"
          onClick={openHelp}
          aria-label="How to get a full path"
        >
          <HelpCircle className="ui-icon-size-3-5" aria-hidden />
        </button>
      </div>
      <div className="ui-runtime-cwd-input-shell">
        <span className="ui-runtime-cwd-input-prefix" aria-hidden>
          <Folder className="ui-icon-size-4" />
        </span>
        <input
          {...inputProps}
          id={id}
          type="text"
          autoComplete="off"
          placeholder={placeholder}
          className="ui-runtime-cwd-input-field"
        />
        <Button type="button" variant="outline" size="xs" className="ui-runtime-cwd-choose-btn" onClick={openHelp}>
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
        className={cn("ui-runtime-cwd-help-link", className)}
        onClick={() => setOpen(true)}
      >
        {triggerLabel}
      </Button>
      <RuntimeCwdPathHelpDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
