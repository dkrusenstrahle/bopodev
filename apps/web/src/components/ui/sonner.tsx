"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { cn } from "@/lib/utils";

export function Toaster(props: ToasterProps) {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={resolvedTheme === "light" ? "light" : "dark"}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast: cn("group toast group-[.toaster]:border-border group-[.toaster]:bg-background group-[.toaster]:text-foreground"),
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground"
        }
      }}
      {...props}
    />
  );
}
