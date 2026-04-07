"use client";

import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import MarkdownIt from "markdown-it";
import TurndownService from "turndown";
import { useEffect, useMemo, useRef } from "react";

const markdownIt = new MarkdownIt({ html: false, linkify: true, breaks: true });

export function KnowledgeTiptapEditor({
  hydrateVersion,
  markdown,
  onMarkdownChange,
  placeholder = "Write markdown…"
}: {
  /** Increment when a file load completes so the editor hydrates from disk without clobbering typing. */
  hydrateVersion: number;
  markdown: string;
  onMarkdownChange: (value: string) => void;
  placeholder?: string;
}) {
  const turndown = useMemo(
    () =>
      new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        bulletListMarker: "-"
      }),
    []
  );

  const markdownRef = useRef(markdown);
  markdownRef.current = markdown;

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] }
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { class: "ui-knowledge-tiptap-link" }
      }),
      Placeholder.configure({ placeholder })
    ],
    content: "<p></p>",
    editorProps: {
      attributes: {
        class: "ui-knowledge-tiptap-prosemirror",
        spellCheck: "true"
      }
    },
    onUpdate: ({ editor: ed }) => {
      const raw = turndown.turndown(ed.getHTML()).trim();
      onMarkdownChange(raw);
    }
  });

  useEffect(() => {
    if (!editor) {
      return;
    }
    const md = markdownRef.current ?? "";
    const html = md.trim() ? markdownIt.render(md) : "<p></p>";
    editor.commands.setContent(html, { emitUpdate: false });
  }, [editor, hydrateVersion]);

  return (
    <div className="ui-knowledge-tiptap-shell">
      <EditorContent editor={editor} className="ui-knowledge-tiptap-editor-root" />
    </div>
  );
}
