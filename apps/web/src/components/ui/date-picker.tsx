"use client";

import * as React from "react";
import { format } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";

export function DatePicker({
  id,
  date,
  onDateChange,
  disabled,
  className,
  placeholder = "Pick a date"
}: {
  id?: string;
  date?: Date;
  onDateChange: (next?: Date) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <Button
          id={id}
          variant="outline"
          disabled={disabled}
          data-empty={!date}
          className={cn(
            "w-full justify-start! text-left font-normal data-[empty=true]:text-muted-foreground",
            className
          )}
        >
          <CalendarIcon />
          <span className="text-left">{date ? format(date, "PPP") : placeholder}</span>
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={8}
          className={cn(
            "z-50 w-auto rounded-md border bg-popover p-0 text-popover-foreground outline-none",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
          )}
        >
          <Calendar
            mode="single"
            className="[--cell-size:1.9rem]"
            selected={date}
            onSelect={(nextDate) => {
              onDateChange(nextDate);
              setOpen(false);
            }}
            defaultMonth={date ?? new Date()}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
