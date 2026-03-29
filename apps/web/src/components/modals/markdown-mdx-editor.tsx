"use client";

import { useMemo } from "react";
import {
  MDXEditor,
  codeBlockPlugin,
  codeMirrorPlugin,
  headingsPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  thematicBreakPlugin
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";

import { cn } from "@/lib/utils";
import styles from "./markdown-mdx-editor.module.scss";

export type MarkdownMdxEditorProps = {
  markdown: string;
  /** Second arg is MDXEditor’s `initialMarkdownNormalize` — true when the editor adjusted markdown on load, not user input. */
  onChange: (value: string, initialMarkdownNormalize?: boolean) => void;
  editorKey: string;
  placeholder?: string;
  /** Larger surface for long documents; `false` matches the issue attachment editor. */
  compact?: boolean;
  /** Shorter surface for inline issue comments (mutually exclusive with `compact` sizing). */
  issueComment?: boolean;
  /** Merged onto the editor root after built-in styles; use for page-specific height/layout. */
  className?: string;
  /**
   * Where MDXEditor mounts its `mdxeditor-popup-container` (toolbars, dialogs).
   * Defaults to `document.body`; set to a local element to avoid a duplicate tall root on `body`
   * inheriting this editor's `className` / min-heights and stretching the page.
   */
  overlayContainer?: HTMLElement | null;
  /** Rich markdown preview without editing (uses MDXEditor styling; no Tailwind `prose` required). */
  readOnly?: boolean;
};

export function MarkdownMdxEditor({
  markdown,
  onChange,
  editorKey,
  placeholder = "Write markdown…",
  compact = true,
  issueComment = false,
  className,
  overlayContainer: overlayContainerProp,
  readOnly = false
}: MarkdownMdxEditorProps) {
  const plugins = useMemo(
    () => [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      linkPlugin(),
      linkDialogPlugin(),
      thematicBreakPlugin(),
      codeBlockPlugin({ defaultCodeBlockLanguage: "txt" }),
      codeMirrorPlugin({
        codeBlockLanguages: {
          txt: "Plain text",
          js: "JavaScript",
          ts: "TypeScript",
          tsx: "TypeScript",
          json: "JSON",
          md: "Markdown"
        }
      }),
      markdownShortcutPlugin()
    ],
    []
  );

  const rootClass = issueComment
    ? cn(styles.mdxEditorRoot, styles.mdxEditorRootIssueComment)
    : cn(styles.mdxEditorRoot, compact && styles.mdxEditorRootCompact);
  const contentClass = issueComment
    ? styles.mdxEditorContentIssueComment
    : cn(styles.mdxEditorContent, compact && styles.mdxEditorContentCompact);

  return (
    <MDXEditor
      key={editorKey}
      markdown={markdown}
      readOnly={readOnly}
      onChange={(next, initialMarkdownNormalize) => onChange(next, initialMarkdownNormalize)}
      plugins={plugins}
      className={cn("dark-theme", rootClass, className)}
      contentEditableClassName={contentClass}
      placeholder={placeholder}
      overlayContainer={
        overlayContainerProp ??
        (typeof document !== "undefined" ? document.body : undefined)
      }
    />
  );
}
