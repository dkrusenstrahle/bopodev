"use client";

import type { Editor } from "@tiptap/core";
import { Extension, generateJSON, isTextSelection } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { BubbleMenu } from "@tiptap/react/menus";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Code, Heading1, Heading2, Heading3, Italic, Link2, Strikethrough } from "lucide-react";
import MarkdownIt from "markdown-it";
import TurndownService from "turndown";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type MutableRefObject } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const markdownIt = new MarkdownIt({ html: false, linkify: true, breaks: true });

const knowledgeMarkdownPasteKey = new PluginKey("knowledgeMarkdownPaste");

function tiptapEditorFromView(view: { dom: HTMLElement }): Editor | null {
  const dom = view.dom as HTMLElement & { editor?: Editor };
  return dom.editor ?? null;
}

/** Plain text from clipboard; falls back to stripping text/html when apps omit text/plain. */
function clipboardPlainText(data: ClipboardEvent["clipboardData"]): string {
  if (!data) {
    return "";
  }
  const plain = data.getData("text/plain") || data.getData("Text");
  if (plain.trim()) {
    return plain;
  }
  const html = data.getData("text/html");
  if (!html.trim()) {
    return "";
  }
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body?.innerText ?? "";
  } catch {
    return "";
  }
}

/** Heuristic: pasted plain text is probably markdown source, not a normal sentence. */
function looksLikeMarkdown(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) {
    return false;
  }
  if (/^#{1,6}\s/m.test(t)) {
    return true;
  }
  if (/^\s*[-*+]\s/m.test(t)) {
    return true;
  }
  if (/^\s*\d+\.\s/m.test(t)) {
    return true;
  }
  if (/^\s*>/m.test(t)) {
    return true;
  }
  if (/^(\*{3}|-{3}|_{3})\s*$/m.test(t)) {
    return true;
  }
  if (/^```/m.test(t)) {
    return true;
  }
  if (/\[[^\]]+\]\([^)\s]+\)/.test(t)) {
    return true;
  }
  if (/`[^`\n]+`/.test(t)) {
    return true;
  }
  if (/(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/m.test(t)) {
    return true;
  }
  if (/(?<![*])\*(?=\S)([^*\n]+)(?<=\S)\*(?!\*)/m.test(t)) {
    return true;
  }
  if (/(?<![_])_(?=\S)([^_\n]+)(?<=\S)_(?!_)/m.test(t)) {
    return true;
  }
  return false;
}

/**
 * ProseMirror paste hook (see https://github.com/ueberdosis/tiptap/issues/2874).
 * Runs as a high-priority plugin so we always get the real Tiptap Editor from the view.
 */
function createKnowledgeMarkdownPasteExtension(readOnlyRef: MutableRefObject<boolean>) {
  return Extension.create({
    name: "knowledgeMarkdownPaste",
    priority: 10000,
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: knowledgeMarkdownPasteKey,
          props: {
            handlePaste(view, event) {
              if (readOnlyRef.current) {
                return false;
              }
              const ed = tiptapEditorFromView(view);
              if (!ed?.isEditable) {
                return false;
              }
              const plain = clipboardPlainText(event.clipboardData);
              if (!plain.trim() || !looksLikeMarkdown(plain)) {
                return false;
              }
              event.preventDefault();
              const html = markdownIt.render(plain);
              const docJson = generateJSON(html, ed.extensionManager.extensions) as {
                content?: unknown[];
              };
              const blocks = docJson.content;
              if (Array.isArray(blocks) && blocks.length > 0) {
                ed.chain().focus().insertContent(blocks).run();
              } else {
                ed.chain().focus().insertContent(html).run();
              }
              return true;
            }
          }
        })
      ];
    }
  });
}

function KnowledgeTiptapBubbleToolbar({
  editor,
  linkModalOpen,
  onOpenLinkModal
}: {
  editor: Editor;
  linkModalOpen: boolean;
  onOpenLinkModal: () => void;
}) {
  const [, setUpdate] = useState(0);

  useEffect(() => {
    const bump = () => setUpdate((n) => n + 1);
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged || transaction.selectionSet) {
        bump();
      }
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  return (
    <BubbleMenu
      editor={editor}
      className="ui-knowledge-tiptap-bubble-menu"
      options={{
        placement: "top",
        offset: 8,
        flip: true,
        shift: true,
        inline: true
      }}
      shouldShow={({ editor: ed, state, from, to, element, view }) => {
        if (linkModalOpen) {
          return false;
        }
        const { doc, selection } = state;
        const { empty } = selection;
        const isEmptyTextBlock = !doc.textBetween(from, to).length && isTextSelection(selection);
        const isChildOfMenu = element.contains(document.activeElement);
        const hasEditorFocus = view.hasFocus() || isChildOfMenu;
        if (!hasEditorFocus || empty || isEmptyTextBlock || !ed.isEditable) {
          return false;
        }
        return true;
      }}
    >
      <button
        type="button"
        className={
          editor.isActive("bold")
            ? "ui-knowledge-tiptap-bubble-menu-btn ui-knowledge-tiptap-bubble-menu-btn--active"
            : "ui-knowledge-tiptap-bubble-menu-btn"
        }
        onClick={() => editor.chain().focus().toggleBold().run()}
        aria-label="Bold"
        aria-pressed={editor.isActive("bold")}
      >
        <Bold className="ui-icon-sm" aria-hidden />
      </button>
      <button
        type="button"
        className={
          editor.isActive("italic")
            ? "ui-knowledge-tiptap-bubble-menu-btn ui-knowledge-tiptap-bubble-menu-btn--active"
            : "ui-knowledge-tiptap-bubble-menu-btn"
        }
        onClick={() => editor.chain().focus().toggleItalic().run()}
        aria-label="Italic"
        aria-pressed={editor.isActive("italic")}
      >
        <Italic className="ui-icon-sm" aria-hidden />
      </button>
      <button
        type="button"
        className={
          editor.isActive("strike")
            ? "ui-knowledge-tiptap-bubble-menu-btn ui-knowledge-tiptap-bubble-menu-btn--active"
            : "ui-knowledge-tiptap-bubble-menu-btn"
        }
        onClick={() => editor.chain().focus().toggleStrike().run()}
        aria-label="Strikethrough"
        aria-pressed={editor.isActive("strike")}
      >
        <Strikethrough className="ui-icon-sm" aria-hidden />
      </button>
      <button
        type="button"
        className={
          editor.isActive("heading", { level: 1 })
            ? "ui-knowledge-tiptap-bubble-menu-btn ui-knowledge-tiptap-bubble-menu-btn--active"
            : "ui-knowledge-tiptap-bubble-menu-btn"
        }
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        aria-label="Heading 1"
        aria-pressed={editor.isActive("heading", { level: 1 })}
      >
        <Heading1 className="ui-icon-sm" aria-hidden />
      </button>
      <button
        type="button"
        className={
          editor.isActive("heading", { level: 2 })
            ? "ui-knowledge-tiptap-bubble-menu-btn ui-knowledge-tiptap-bubble-menu-btn--active"
            : "ui-knowledge-tiptap-bubble-menu-btn"
        }
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        aria-label="Heading 2"
        aria-pressed={editor.isActive("heading", { level: 2 })}
      >
        <Heading2 className="ui-icon-sm" aria-hidden />
      </button>
      <button
        type="button"
        className={
          editor.isActive("heading", { level: 3 })
            ? "ui-knowledge-tiptap-bubble-menu-btn ui-knowledge-tiptap-bubble-menu-btn--active"
            : "ui-knowledge-tiptap-bubble-menu-btn"
        }
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        aria-label="Heading 3"
        aria-pressed={editor.isActive("heading", { level: 3 })}
      >
        <Heading3 className="ui-icon-sm" aria-hidden />
      </button>
      <button
        type="button"
        className={
          editor.isActive("code")
            ? "ui-knowledge-tiptap-bubble-menu-btn ui-knowledge-tiptap-bubble-menu-btn--active"
            : "ui-knowledge-tiptap-bubble-menu-btn"
        }
        onClick={() => editor.chain().focus().toggleCode().run()}
        aria-label="Inline code"
        aria-pressed={editor.isActive("code")}
      >
        <Code className="ui-icon-sm" aria-hidden />
      </button>
      <button
        type="button"
        className={
          editor.isActive("link")
            ? "ui-knowledge-tiptap-bubble-menu-btn ui-knowledge-tiptap-bubble-menu-btn--active"
            : "ui-knowledge-tiptap-bubble-menu-btn"
        }
        onClick={() => onOpenLinkModal()}
        aria-label={editor.isActive("link") ? "Edit link" : "Add link"}
        aria-pressed={editor.isActive("link")}
      >
        <Link2 className="ui-icon-sm" aria-hidden />
      </button>
    </BubbleMenu>
  );
}

export function KnowledgeTiptapEditor({
  hydrateVersion,
  markdown,
  onMarkdownChange,
  placeholder = "Write markdown…",
  readOnly = false
}: {
  /** Increment when a file load completes so the editor hydrates from disk without clobbering typing. */
  hydrateVersion: number;
  markdown: string;
  onMarkdownChange: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
}) {
  const linkUrlInputId = useId();
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linkUrlDraft, setLinkUrlDraft] = useState("");
  const [linkModalHadLink, setLinkModalHadLink] = useState(false);
  const [linkUrlError, setLinkUrlError] = useState<string | null>(null);

  const editorRef = useRef<Editor | null>(null);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  const openLinkModal = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) {
      return;
    }
    const had = ed.isActive("link");
    const prev = (ed.getAttributes("link").href as string | undefined) ?? "";
    setLinkModalHadLink(had);
    setLinkUrlDraft(prev.trim() ? prev : "https://");
    setLinkUrlError(null);
    setLinkModalOpen(true);
  }, []);

  const openLinkModalRef = useRef(openLinkModal);
  openLinkModalRef.current = openLinkModal;

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

  const markdownPasteExtension = useMemo(
    () => createKnowledgeMarkdownPasteExtension(readOnlyRef),
    []
  );

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] }
      }),
      markdownPasteExtension,
      Link.configure({
        openOnClick: false,
        enableClickSelection: false,
        autolink: true,
        HTMLAttributes: {
          class: "ui-knowledge-tiptap-link",
          rel: "noopener noreferrer",
          target: null
        }
      }),
      Placeholder.configure({ placeholder })
    ],
    content: "<p></p>",
    editorProps: {
      attributes: {
        class: "ui-knowledge-tiptap-prosemirror",
        spellCheck: "true"
      },
      handleClick(_view, _pos, event) {
        if (readOnlyRef.current) {
          return false;
        }
        if (event.button !== 0) {
          return false;
        }
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return false;
        }
        const t = event.target;
        if (!(t instanceof Node) || !_view.dom.contains(t)) {
          return false;
        }
        const el = t instanceof Element ? t : t.parentElement;
        const anchor = el?.closest?.("a[href]");
        if (!anchor || !_view.dom.contains(anchor)) {
          return false;
        }
        const ed = editorRef.current;
        if (!ed?.isEditable) {
          return false;
        }
        ed.chain().focus().extendMarkRange("link").run();
        openLinkModalRef.current();
        return true;
      },
      handleDOMEvents: {
        click(view, event) {
          if (!view.editable || readOnlyRef.current) {
            return false;
          }
          const t = event.target;
          if (!(t instanceof Node) || !view.dom.contains(t)) {
            return false;
          }
          const el = t instanceof Element ? t : t.parentElement;
          const link = el?.closest?.("a[href]");
          if (link && view.dom.contains(link)) {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
              return false;
            }
            event.preventDefault();
          }
          return false;
        }
      }
    },
    onUpdate: ({ editor: ed }) => {
      const raw = turndown.turndown(ed.getHTML()).trim();
      onMarkdownChange(raw);
    }
  });

  useEffect(() => {
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) {
      return;
    }
    const md = markdownRef.current ?? "";
    const html = md.trim() ? markdownIt.render(md) : "<p></p>";
    editor.commands.setContent(html, { emitUpdate: false });
  }, [editor, hydrateVersion]);

  useEffect(() => {
    if (!editor) {
      return;
    }
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  function applyLink() {
    const ed = editorRef.current;
    if (!ed) {
      return;
    }
    const trimmed = linkUrlDraft.trim();
    if (!trimmed) {
      setLinkUrlError("Enter a URL.");
      return;
    }
    ed.chain().focus().extendMarkRange("link").setLink({ href: trimmed }).run();
    setLinkModalOpen(false);
  }

  function removeLink() {
    const ed = editorRef.current;
    if (!ed) {
      return;
    }
    ed.chain().focus().extendMarkRange("link").unsetLink().run();
    setLinkModalOpen(false);
  }

  return (
    <div className="ui-knowledge-tiptap-shell">
      {editor && !readOnly ? (
        <KnowledgeTiptapBubbleToolbar
          editor={editor}
          linkModalOpen={linkModalOpen}
          onOpenLinkModal={openLinkModal}
        />
      ) : null}
      <EditorContent editor={editor} className="ui-knowledge-tiptap-editor-root" />

      {!readOnly ? (
        <Dialog
          open={linkModalOpen}
          onOpenChange={(open) => {
            setLinkModalOpen(open);
            if (!open) {
              setLinkUrlError(null);
            }
          }}
        >
          <DialogContent
            size="sm"
            showCloseButton
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              requestAnimationFrame(() => {
                const el = document.getElementById(linkUrlInputId) as HTMLInputElement | null;
                el?.focus();
                el?.select();
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>{linkModalHadLink ? "Edit link" : "Add link"}</DialogTitle>
              <DialogDescription>Set the URL for the selected text. Markdown will store a standard link.</DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor={linkUrlInputId}>URL</FieldLabel>
              <Input
                id={linkUrlInputId}
                value={linkUrlDraft}
                onChange={(ev) => {
                  setLinkUrlDraft(ev.target.value);
                  if (linkUrlError) {
                    setLinkUrlError(null);
                  }
                }}
                placeholder="https://"
                autoComplete="off"
                spellCheck={false}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") {
                    ev.preventDefault();
                    applyLink();
                  }
                }}
              />
              {linkUrlError ? <FieldError>{linkUrlError}</FieldError> : null}
            </Field>
            <DialogFooter>
              {linkModalHadLink ? (
                <Button type="button" variant="outline" onClick={() => removeLink()}>
                  Remove link
                </Button>
              ) : null}
              <Button type="button" onClick={() => applyLink()}>
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
