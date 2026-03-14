"use client";

import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import styles from "./theme-toggle.module.scss";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const selectedTheme = mounted && theme === "light" ? "light" : "dark";
  const SelectedIcon = selectedTheme === "light" ? SunIcon : MoonIcon;

  return (
    <Select value={selectedTheme} onValueChange={(value) => setTheme(value)}>
      <SelectTrigger className={styles.themeToggleTrigger} size="sm" aria-label="Select theme mode">
        <span className={styles.themeToggleLabel1}>
          <SelectedIcon className={styles.themeToggleIcon} />
          <SelectValue placeholder="Theme" />
        </span>
        <span className={styles.themeToggleLabel2}>Mode</span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="dark">Dark mode</SelectItem>
        <SelectItem value="light">Light mode</SelectItem>
      </SelectContent>
    </Select>
  );
}
