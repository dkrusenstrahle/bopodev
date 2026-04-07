"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { Loader2, Send } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { MarkdownBody } from "@/components/markdown-view";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiDelete, apiGet, apiPost } from "@/lib/api";
import { agentAvatarSeed, buildAgentAvatarUrl } from "@/lib/agent-avatar";
import { getViewerChatProfile } from "@/lib/actor-token-client";
import { cn } from "@/lib/utils";
import type { CompanyRow } from "@/components/workspace/types";
import { SectionHeading } from "@/components/workspace/shared";

const CHAT_BRAIN_STORAGE_KEY = "bopo-chat-brain";
const LEGACY_ASK_BRAIN_STORAGE_KEY = "bopo-ask-brain";
const CHAT_THREAD_STORAGE_PREFIX = "bopo-chat-thread:";
const DEFAULT_BRAIN = "codex";

function chatThreadStorageKey(companyId: string) {
  return `${CHAT_THREAD_STORAGE_PREFIX}${companyId}`;
}

function readStoredChatThreadId(companyId: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage.getItem(chatThreadStorageKey(companyId))?.trim() || null;
}

/** Prose utilities are not valid inside `shadcn.scss` `@apply` in this Tailwind setup. */
const assistantMarkdownClass =
  "prose prose-sm dark:prose-invert max-w-none prose-headings:mt-3 prose-headings:mb-1.5 prose-h2:text-base prose-h2:font-semibold prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-p:my-1.5";

type BrainOption = {
  providerType: string;
  label: string;
  requiresRuntimeCwd: boolean;
};

type AssistantMessage = {
  id: string;
  role: string;
  body: string;
  createdAt: string;
  metadata: unknown | null;
};

type CeoPersona = {
  agentId: string | null;
  name: string;
  title: string | null;
  avatarSeed: string;
};

const DEFAULT_CEO_PERSONA: CeoPersona = {
  agentId: null,
  name: "CEO",
  title: null,
  avatarSeed: ""
};

const PENDING_USER_MESSAGE_PREFIX = "pending-user:";

/** Virtual row id — not persisted; shown until the thread has a real assistant reply. */
const CEO_WELCOME_MESSAGE_ID = "__bopo-ceo-welcome__";

function buildCeoWelcomeMarkdown(companyName: string | null, persona: CeoPersona): string {
  const label = formatCeoLabel(persona);
  const org = companyName?.trim() || "your company";
  return [
    `Hi, I'm **${label}**.`,
    "",
    `Ask me anything about **${org}**: priorities, projects, issues, spend, agents, or what's blocking us.`,
    "What would you like to know?"
  ].join("\n");
}

function makePendingUserMessage(body: string): AssistantMessage {
  return {
    id: `${PENDING_USER_MESSAGE_PREFIX}${Date.now()}`,
    role: "user",
    body,
    createdAt: new Date().toISOString(),
    metadata: null
  };
}

function formatThreadUpdatedLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

type AssistantThreadListItem = {
  id: string;
  updatedAt: string;
  preview: string | null;
};

function formatCeoLabel(persona: CeoPersona): string {
  const title = persona.title?.trim();
  if (title) {
    return `${persona.name.trim() || "CEO"} (${title})`;
  }
  return persona.name.trim() || "CEO";
}

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function useRevealText(
  full: string,
  run: boolean,
  onDoneRef: MutableRefObject<(() => void) | null>,
  onTickRef?: MutableRefObject<(() => void) | null>
) {
  const [n, setN] = useState(() => (run ? 0 : full.length));

  useEffect(() => {
    if (!run) {
      setN(full.length);
      return;
    }
    setN(0);
    const start = performance.now();
    const duration = Math.min(5_000, 150 + full.length * 3);
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const next = Math.floor(full.length * p);
      setN(next);
      onTickRef?.current?.();
      if (p < 1) {
        raf = requestAnimationFrame(step);
      } else {
        onDoneRef.current?.();
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [full, run, onDoneRef, onTickRef]);

  return full.slice(0, n);
}

function AskAvatar({ seed, name }: { seed: string; name: string }) {
  return (
    <Avatar className="ui-ask-avatar">
      <AvatarImage src={buildAgentAvatarUrl({ seed, size: 72 })} alt="" />
      <AvatarFallback className="ui-ask-avatar-fallback">{initialsFromName(name)}</AvatarFallback>
    </Avatar>
  );
}

function TypingIndicator({ ceoPersona }: { ceoPersona: CeoPersona }) {
  const label = formatCeoLabel(ceoPersona);
  const seed = agentAvatarSeed(
    ceoPersona.agentId ?? "ceo",
    ceoPersona.name,
    ceoPersona.avatarSeed?.trim() ? ceoPersona.avatarSeed : null
  );
  return (
    <div className="ui-ask-row ui-ask-row--assistant" aria-live="polite" aria-label={`${label} is typing`}>
      <AskAvatar seed={seed} name={label} />
      <div className="ui-ask-message-col">
        <Card className={cn("ui-card", "ui-ask-bubble-card", "ui-ask-bubble-card--typing")}>
          <CardContent className={cn("ui-card-content", "ui-ask-bubble-content", "ui-ask-bubble-content--typing")}>
            <span className="ui-ask-typing-dots" aria-hidden>
              <span className="ui-ask-typing-dot" />
              <span className="ui-ask-typing-dot" />
              <span className="ui-ask-typing-dot" />
            </span>
          </CardContent>
        </Card>
        <p className="ui-ask-sender">{label}</p>
      </div>
    </div>
  );
}

export function AssistantPageClient({
  companyId,
  companies
}: {
  companyId: string | null;
  companies: CompanyRow[];
}) {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [brains, setBrains] = useState<BrainOption[]>([]);
  const [brainSelection, setBrainSelection] = useState(DEFAULT_BRAIN);
  const [isStartingNewThread, setIsStartingNewThread] = useState(false);
  const [isDeletingThread, setIsDeletingThread] = useState(false);
  const [revealMessageId, setRevealMessageId] = useState<string | null>(null);
  const [viewer, setViewer] = useState(() => getViewerChatProfile());
  const [ceoPersona, setCeoPersona] = useState<CeoPersona>(DEFAULT_CEO_PERSONA);
  const [threads, setThreads] = useState<AssistantThreadListItem[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const revealDoneRef = useRef<(() => void) | null>(null);
  const revealScrollTickRef = useRef<(() => void) | null>(null);

  const activeCompanyName = companyId ? (companies.find((c) => c.id === companyId)?.name ?? null) : null;

  const refreshThreads = useCallback(async () => {
    if (!companyId) {
      setThreads([]);
      return;
    }
    setThreadsLoading(true);
    try {
      const res = await apiGet<{ threads: AssistantThreadListItem[] }>("/assistant/threads?limit=80", companyId);
      setThreads(Array.isArray(res.data.threads) ? res.data.threads : []);
    } catch {
      setThreads([]);
    } finally {
      setThreadsLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    setActiveThreadId(null);
  }, [companyId]);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollContainerRef.current;
    if (!el) {
      return;
    }
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior });
    });
  }, []);

  useEffect(() => {
    setViewer(getViewerChatProfile());
  }, []);

  useEffect(() => {
    revealScrollTickRef.current = () => scrollToBottom("auto");
  }, [scrollToBottom]);

  const persistBrain = useCallback(
    (next: string) => {
      setBrainSelection(next);
      if (typeof window !== "undefined" && companyId) {
        window.localStorage.setItem(`${CHAT_BRAIN_STORAGE_KEY}:${companyId}`, next);
      }
    },
    [companyId]
  );

  useEffect(() => {
    revealDoneRef.current = () => {
      setRevealMessageId(null);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !companyId) {
      return;
    }
    const raw =
      window.localStorage.getItem(`${CHAT_BRAIN_STORAGE_KEY}:${companyId}`) ??
      window.localStorage.getItem(`${LEGACY_ASK_BRAIN_STORAGE_KEY}:${companyId}`);
    if (raw && raw.trim()) {
      setBrainSelection(raw.trim());
    } else {
      setBrainSelection(DEFAULT_BRAIN);
    }
  }, [companyId]);

  useEffect(() => {
    if (!companyId) {
      setBrains([]);
      return;
    }
    void apiGet<{ brains: BrainOption[] }>("/assistant/brains", companyId)
      .then((res) => {
        const list = res.data.brains ?? [];
        setBrains(list);
        const valid = new Set(list.map((b) => b.providerType));
        setBrainSelection((current) => (valid.has(current) ? current : list[0]?.providerType ?? DEFAULT_BRAIN));
      })
      .catch(() => {
        setBrains([]);
      });
  }, [companyId]);

  const refreshMessages = useCallback(async () => {
    if (!companyId) {
      setMessages([]);
      setCeoPersona(DEFAULT_CEO_PERSONA);
      return;
    }
    setIsLoading(true);
    setLoadError(null);

    const applyPayload = (data: {
      threadId: string;
      ceoPersona?: CeoPersona;
      messages: AssistantMessage[];
    }) => {
      const p = data.ceoPersona;
      if (p && typeof p === "object" && typeof p.name === "string") {
        setCeoPersona({
          agentId: typeof p.agentId === "string" ? p.agentId : null,
          name: p.name,
          title: typeof p.title === "string" ? p.title : null,
          avatarSeed: typeof p.avatarSeed === "string" ? p.avatarSeed : ""
        });
      } else {
        setCeoPersona(DEFAULT_CEO_PERSONA);
      }
      setMessages(data.messages ?? []);
      if (data.threadId) {
        setActiveThreadId(data.threadId);
      }
      if (typeof window !== "undefined" && data.threadId) {
        window.localStorage.setItem(chatThreadStorageKey(companyId), data.threadId);
      }
    };

    const fetchForThread = (forThreadId: string | null) => {
      const q = new URLSearchParams({ limit: "120" });
      if (forThreadId) {
        q.set("threadId", forThreadId);
      }
      return apiGet<{
        threadId: string;
        ceoPersona?: CeoPersona;
        messages: AssistantMessage[];
      }>(`/assistant/messages?${q.toString()}`, companyId);
    };

    const storedTid = readStoredChatThreadId(companyId);

    try {
      const res = await fetchForThread(storedTid);
      applyPayload(res.data);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && storedTid) {
        window.localStorage.removeItem(chatThreadStorageKey(companyId));
        try {
          const res = await fetchForThread(null);
          applyPayload(res.data);
        } catch (e2) {
          setLoadError(e2 instanceof ApiError ? e2.message : "Failed to load chat.");
        }
      } else {
        setLoadError(e instanceof ApiError ? e.message : "Failed to load chat.");
      }
    } finally {
      setIsLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void refreshMessages();
  }, [refreshMessages]);

  useEffect(() => {
    scrollToBottom("smooth");
  }, [messages, isSending, scrollToBottom]);

  /** While sending, the composer is disabled and loses focus; restore after the turn completes. */
  useEffect(() => {
    if (!isSending) {
      return;
    }
    return () => {
      requestAnimationFrame(() => {
        composerRef.current?.focus();
      });
    };
  }, [isSending]);

  async function onSubmit() {
    const text = draft.trim();
    if (!text || !companyId || isSending) {
      return;
    }
    setSendError(null);
    setIsSending(true);
    setDraft("");
    const pending = makePendingUserMessage(text);
    setMessages((prev) => [...prev, pending]);
    try {
      const tid = readStoredChatThreadId(companyId);
      const res = await apiPost<{
        userMessageId: string;
        assistantMessageId: string;
        assistantBody: string;
        toolRoundCount: number;
        brain: string;
        threadId: string;
        mode?: "api" | "cli";
      }>("/assistant/messages", companyId, {
        message: text,
        brain: brainSelection,
        ...(tid ? { threadId: tid } : {})
      });
      if (typeof window !== "undefined" && res.data.threadId) {
        window.localStorage.setItem(chatThreadStorageKey(companyId), res.data.threadId);
      }
      setRevealMessageId(res.data.assistantMessageId);
      await refreshMessages();
      void refreshThreads();
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== pending.id));
      setDraft(text);
      setSendError(e instanceof ApiError ? e.message : "Failed to send message.");
    } finally {
      setIsSending(false);
    }
  }

  async function startNewConversation() {
    if (!companyId || isStartingNewThread) {
      return;
    }
    setIsStartingNewThread(true);
    setSendError(null);
    setLoadError(null);
    setRevealMessageId(null);
    try {
      const res = await apiPost<{ threadId: string }>("/assistant/threads", companyId, {});
      if (typeof window !== "undefined" && res.data.threadId) {
        window.localStorage.setItem(chatThreadStorageKey(companyId), res.data.threadId);
      }
      setMessages([]);
      void refreshThreads();
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : "Could not start a new conversation.");
    } finally {
      setIsStartingNewThread(false);
    }
  }

  async function deleteCurrentConversation() {
    if (!companyId || isDeletingThread || isStartingNewThread) {
      return;
    }
    const threadId = readStoredChatThreadId(companyId);
    if (!threadId) {
      return;
    }
    if (
      !window.confirm(
        "Delete this conversation? All messages in it will be removed. This cannot be undone."
      )
    ) {
      return;
    }
    setIsDeletingThread(true);
    setSendError(null);
    setLoadError(null);
    setRevealMessageId(null);
    try {
      await apiDelete<{ deleted: boolean }>(
        `/assistant/threads/${encodeURIComponent(threadId)}`,
        companyId
      );
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(chatThreadStorageKey(companyId));
      }
      await refreshMessages();
      void refreshThreads();
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : "Could not delete this conversation.");
    } finally {
      setIsDeletingThread(false);
    }
  }

  const selectThread = useCallback(
    async (threadId: string) => {
      if (!companyId) {
        return;
      }
      if (typeof window !== "undefined") {
        window.localStorage.setItem(chatThreadStorageKey(companyId), threadId);
      }
      setActiveThreadId(threadId);
      await refreshMessages();
    },
    [companyId, refreshMessages]
  );

  const secondaryPane = companyId ? (
    <div className="run-sidebar-pane">
      <div className="run-sidebar-list">
        <div className="ui-agent-docs-sidebar-section-label">Conversations</div>
        {threadsLoading && threads.length === 0 ? (
          <p className="ui-agent-docs-sidebar-empty">Loading…</p>
        ) : threads.length === 0 ? (
          <p className="ui-agent-docs-sidebar-empty">No saved chats yet. Send a message or use New.</p>
        ) : (
          <nav className="contents" aria-label="Saved conversations">
            {threads.map((t) => {
              const title = t.preview ?? "new chat";
              return (
                <button
                  key={t.id}
                  type="button"
                  className={cn(
                    "run-sidebar-item",
                    "ui-agent-docs-sidebar-item",
                    t.id === activeThreadId && "run-sidebar-item--active"
                  )}
                  onClick={() => void selectThread(t.id)}
                >
                  <div className="run-sidebar-item-header">
                    <span className="run-sidebar-item-id" title={title}>
                      {title}
                    </span>
                  </div>
                  <p className="run-sidebar-item-time">{formatThreadUpdatedLabel(t.updatedAt)}</p>
                </button>
              );
            })}
          </nav>
        )}
      </div>
    </div>
  ) : undefined;

  const leftPane = (
    <div className="ui-page-stack ui-page-stack-fullheight">
      <div className="ui-page-section-gap-sm-shrink">
        <SectionHeading
          title="Ask the CEO"
          description="Message your CEO with full company context. Choose which runtime answers (same adapters as when you hire an agent). Older threads stay saved on the server."
          actions={
            companyId ? (
              <div className="ui-assistant-toolbar-row">
                {brains.length > 0 ? (
                  <Select value={brainSelection} onValueChange={(v) => persistBrain(v)}>
                    <SelectTrigger className="ui-assistant-brain-select-trigger" aria-label="Brain">
                      <SelectValue placeholder="Brain" />
                    </SelectTrigger>
                    <SelectContent>
                      {brains.map((b) => (
                        <SelectItem key={b.providerType} value={b.providerType}>
                          {b.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                <div className="ui-assistant-toolbar-actions">
                  <Button
                    type="button"
                    variant="outline"
                    className="ui-assistant-toolbar-btn"
                    disabled={isStartingNewThread || isDeletingThread}
                    onClick={() => void startNewConversation()}
                  >
                    New
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="ui-assistant-toolbar-btn-danger"
                    disabled={isDeletingThread || isStartingNewThread || !readStoredChatThreadId(companyId)}
                    onClick={() => void deleteCurrentConversation()}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ) : null
          }
        />
      </div>
      {!companyId ? (
        <p className="ui-ask-empty-hint">Select a company to start.</p>
      ) : (
        <>
          <Card className={cn("ui-card", "ui-ask-thread-card")}>
            <CardContent ref={scrollContainerRef} className={cn("ui-card-content", "ui-ask-thread-messages")}>
              {loadError ? (
                <Alert variant="destructive">
                  <AlertTitle>Could not load chat</AlertTitle>
                  <AlertDescription>{loadError}</AlertDescription>
                </Alert>
              ) : null}
              {isLoading && messages.length === 0 ? <p className="ui-ask-empty-hint">Loading…</p> : null}
              {!isLoading &&
              !loadError &&
              !messages.some((m) => m.role === "assistant") ? (
                <AssistantChatRow
                  key={CEO_WELCOME_MESSAGE_ID}
                  message={{
                    id: CEO_WELCOME_MESSAGE_ID,
                    role: "assistant",
                    body: buildCeoWelcomeMarkdown(activeCompanyName, ceoPersona),
                    createdAt: new Date().toISOString(),
                    metadata: { kind: "welcome" }
                  }}
                  viewer={viewer}
                  ceoPersona={ceoPersona}
                  animate={false}
                  onRevealDoneRef={revealDoneRef}
                  onRevealTickRef={revealScrollTickRef}
                />
              ) : null}
              {messages.map((m) => (
                <AssistantChatRow
                  key={m.id}
                  message={m}
                  viewer={viewer}
                  ceoPersona={ceoPersona}
                  animate={m.role === "assistant" && m.id === revealMessageId}
                  onRevealDoneRef={revealDoneRef}
                  onRevealTickRef={revealScrollTickRef}
                />
              ))}
              {isSending ? <TypingIndicator ceoPersona={ceoPersona} /> : null}
            </CardContent>

            <CardFooter className={cn("ui-card-footer", "ui-ask-thread-footer")}>
              {sendError ? (
                <Alert variant="destructive" className="ui-alert-w-full">
                  <AlertTitle>Message not sent</AlertTitle>
                  <AlertDescription>{sendError}</AlertDescription>
                </Alert>
              ) : null}
              <div className="ui-ask-pill-composer">
                <Textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Ask me anything..."
                  rows={1}
                  disabled={isSending}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void onSubmit();
                    }
                  }}
                  className="ui-ask-composer-textarea"
                />
                <Button
                  type="button"
                  variant="default"
                  size="icon"
                  className={cn("ui-ask-composer-btn-send")}
                  onClick={() => void onSubmit()}
                  disabled={isSending || !draft.trim()}
                  aria-label="Send message"
                  title="Send message"
                >
                  {isSending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Send className="size-4" aria-hidden />
                  )}
                </Button>
              </div>
            </CardFooter>
          </Card>

        </>
      )}
    </div>
  );

  return (
    <AppShell
      leftPane={leftPane}
      activeNav="Chat"
      companies={companies}
      activeCompanyId={companyId}
      rightPane={null}
      secondaryPane={secondaryPane}
    />
  );
}

function AssistantChatRow({
  message,
  viewer,
  ceoPersona,
  animate,
  onRevealDoneRef,
  onRevealTickRef
}: {
  message: AssistantMessage;
  viewer: { displayName: string; avatarSeed: string };
  ceoPersona: CeoPersona;
  animate: boolean;
  onRevealDoneRef: MutableRefObject<(() => void) | null>;
  onRevealTickRef?: MutableRefObject<(() => void) | null>;
}) {
  const isUser = message.role === "user";
  const display = useRevealText(
    message.body,
    Boolean(!isUser && animate),
    onRevealDoneRef,
    onRevealTickRef
  );

  const assistantLabel = formatCeoLabel(ceoPersona);
  const assistantSeed = agentAvatarSeed(
    ceoPersona.agentId ?? "ceo",
    ceoPersona.name,
    ceoPersona.avatarSeed?.trim() ? ceoPersona.avatarSeed : null
  );

  if (isUser) {
    return (
      <div className="ui-ask-row ui-ask-row--user">
        <div className={cn("ui-ask-message-col", "ui-ask-message-col--user")}>
          <Card className={cn("ui-card", "ui-ask-bubble-card", "ui-ask-bubble-card--user")}>
            <CardContent className={cn("ui-card-content", "ui-ask-bubble-content")}>
              <MarkdownBody
                content={message.body}
                className={cn(
                  assistantMarkdownClass,
                  "prose-invert text-primary-foreground",
                  "[&_*]:text-inherit prose-headings:text-primary-foreground prose-strong:text-primary-foreground",
                  "prose-a:text-primary-foreground prose-a:underline prose-code:bg-primary-foreground/15"
                )}
              />
            </CardContent>
          </Card>
          <p className={cn("ui-ask-sender", "ui-ask-sender--user")}>{viewer.displayName}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ui-ask-row ui-ask-row--assistant">
      <AskAvatar seed={assistantSeed} name={assistantLabel} />
      <div className="ui-ask-message-col">
        <Card className={cn("ui-card", "ui-ask-bubble-card", "ui-ask-bubble-card--assistant")}>
          <CardContent className={cn("ui-card-content", "ui-ask-bubble-content")}>
            <MarkdownBody content={display} className={assistantMarkdownClass} />
          </CardContent>
        </Card>
        <p className="ui-ask-sender">{assistantLabel}</p>
      </div>
    </div>
  );
}
