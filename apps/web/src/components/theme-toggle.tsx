"use client";

import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import styles from "./theme-toggle.module.scss";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const active = mounted && theme === "light" ? "light" : "dark";

  return (
    <div className={styles.themeToggle} role="group" aria-label="Color mode">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className={cn(styles.themeToggleBtn, active === "light" && styles.themeToggleBtnActive)}
        aria-label="Light mode"
        aria-pressed={active === "light"}
        onClick={() => setTheme("light")}
      >
        <SunIcon className={styles.themeToggleIcon} aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className={cn(styles.themeToggleBtn, active === "dark" && styles.themeToggleBtnActive)}
        aria-label="Dark mode"
        aria-pressed={active === "dark"}
        onClick={() => setTheme("dark")}
      >
        <MoonIcon className={styles.themeToggleIcon} aria-hidden />
      </Button>
    </div>
  );
}
