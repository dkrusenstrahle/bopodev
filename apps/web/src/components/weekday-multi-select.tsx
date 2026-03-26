"use client";

import { useMemo } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** Cron DOW: 0=Sun … 6=Sat. Display in Mon→Sun order. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const WEEKDAY_META: Record<number, { short: string; long: string }> = {
  0: { short: "Sun", long: "Sunday" },
  1: { short: "Mon", long: "Monday" },
  2: { short: "Tue", long: "Tuesday" },
  3: { short: "Wed", long: "Wednesday" },
  4: { short: "Thu", long: "Thursday" },
  5: { short: "Fri", long: "Friday" },
  6: { short: "Sat", long: "Saturday" }
};

const orderIndex = (d: number) => {
  const i = (WEEKDAY_ORDER as readonly number[]).indexOf(d);
  return i === -1 ? 99 : i;
};

export function sortWeekdaysForDisplay(days: number[]) {
  return [...new Set(days)].sort((a, b) => orderIndex(a) - orderIndex(b));
}

export function formatWeekdaysSummary(days: number[], emptyLabel = "Select days…") {
  const sorted = sortWeekdaysForDisplay(days);
  if (sorted.length === 0) {
    return emptyLabel;
  }
  return sorted.map((d) => WEEKDAY_META[d]?.short ?? d).join(", ");
}

export function WeekdayMultiSelect({
  value,
  onChange,
  id,
  disabled
}: {
  value: number[];
  onChange: (next: number[]) => void;
  id?: string;
  disabled?: boolean;
}) {
  const summary = useMemo(() => formatWeekdaysSummary(value), [value]);

  function toggle(day: number) {
    if (value.includes(day)) {
      if (value.length <= 1) {
        return;
      }
      onChange(value.filter((d) => d !== day));
    } else {
      onChange([...value, day]);
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          data-size="default"
          disabled={disabled}
          className={cn(
            "ui-select-trigger font-normal",
            !value.length && "text-muted-foreground"
          )}
        >
          <span className="min-w-0 flex-1 truncate text-start">{summary}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="min-w-60 p-2" align="start">
        <div className="flex flex-col gap-1">
          {WEEKDAY_ORDER.map((day) => {
            const checked = value.includes(day);
            const meta = WEEKDAY_META[day] ?? { short: String(day), long: `Day ${day}` };
            return (
              <label
                key={day}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                  checked && "bg-accent/60"
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggle(day)}
                  aria-label={meta.long}
                />
                <span>{meta.long}</span>
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
