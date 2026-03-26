"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Default collapsed height for body-style markdown (issue description, agent prompt, etc.). */
export const COLLAPSIBLE_MARKDOWN_BODY_MAX_HEIGHT_PX = 280;

export function MarkdownBody({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn(className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

export function CollapsibleMarkdown({
  content,
  className,
  maxHeightPx
}: {
  content: string;
  className: string;
  maxHeightPx: number;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
    setIsExpanded(false);
  }, [content, maxHeightPx]);

  useEffect(() => {
    const node = contentRef.current;
    if (!node) {
      return;
    }

    const measureHeight = () => {
      setIsOverflowing(node.scrollHeight > maxHeightPx + 1);
    };

    measureHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measureHeight);
      return () => window.removeEventListener("resize", measureHeight);
    }

    const observer = new ResizeObserver(() => {
      measureHeight();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [content, maxHeightPx]);

  const isCollapsed = isOverflowing && !isExpanded;
  const markdownClassName = isCollapsed ? `${className} ui-markdown-collapsible-content` : className;

  return (
    <div>
      <div className="ui-markdown-collapsible-frame">
        <div ref={contentRef} className={markdownClassName} style={isCollapsed ? { maxHeight: `${maxHeightPx}px` } : undefined}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
        {isCollapsed ? <div className="ui-markdown-collapsible-curtain" aria-hidden /> : null}
      </div>
      {isOverflowing ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ui-markdown-collapsible-toggle"
          onClick={() => setIsExpanded((current) => !current)}
        >
          {isExpanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}
