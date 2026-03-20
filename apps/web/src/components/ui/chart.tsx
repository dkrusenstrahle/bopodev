"use client"

import * as React from "react"
import * as RechartsPrimitive from "recharts"

import { cn } from "@/lib/utils"

export type ChartConfig = {
  [key: string]: {
    label?: React.ReactNode
    icon?: React.ComponentType
    color?: string
    theme?: {
      light: string
      dark: string
    }
  }
}

type ChartContextProps = {
  config: ChartConfig
}

const ChartContext = React.createContext<ChartContextProps | null>(null)

function useChart() {
  const context = React.useContext(ChartContext)

  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />")
  }

  return context
}

const ChartContainer = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    config: ChartConfig
    children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"]
  }
>(({ id, className, children, config, style, ...props }, ref) => {
  const uniqueId = React.useId().replace(/:/g, "")
  const chartId = `chart-${id || uniqueId}`

  const chartStyle = React.useMemo(() => {
    const styles: Record<string, string> = {}
    for (const [key, value] of Object.entries(config)) {
      const color = value.color ?? value.theme?.light
      if (color) {
        styles[`--color-${key}`] = color
      }
    }
    return styles
  }, [config])

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        ref={ref}
        className={cn("block w-full min-w-0 text-base", className)}
        style={{ ...chartStyle, ...style } as React.CSSProperties}
        {...props}
      >
        <RechartsPrimitive.ResponsiveContainer>
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
})
ChartContainer.displayName = "ChartContainer"

const ChartTooltip = RechartsPrimitive.Tooltip

const ChartTooltipContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    active?: boolean
    payload?: Array<{ name?: string; value?: number | string; color?: string; payload?: Record<string, unknown> }>
    label?: string
    hideLabel?: boolean
    hideIndicator?: boolean
    indicator?: "dot" | "line" | "dashed"
  }
>(
  (
    {
      active,
      payload,
      className,
      indicator = "dot",
      hideLabel = false,
      hideIndicator = false,
      label,
    },
    ref
  ) => {
    const { config } = useChart()

    if (!active || !payload?.length) {
      return null
    }

    return (
      <div
        ref={ref}
        className={cn(
          "grid min-w-32 items-start gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-base",
          className
        )}
      >
        {!hideLabel ? <div className="font-medium">{label}</div> : null}
        <div className="grid gap-1.5">
          {payload.map((item, index) => {
            const key = String(item.name ?? "value")
            const conf = config[key]
            const color = item.color ?? `var(--color-${key})`
            const indicatorClass =
              indicator === "line"
                ? "h-0.5 w-3"
                : indicator === "dashed"
                  ? "h-0.5 w-3 border border-dashed border-current bg-transparent"
                  : "size-2 rounded-[2px]"
            return (
              <div key={`${key}-${index}`} className="flex items-center gap-2">
                {!hideIndicator ? (
                  <span
                    className={cn("shrink-0", indicatorClass)}
                    style={{ backgroundColor: indicator === "dashed" ? "transparent" : color, color }}
                  />
                ) : null}
                <span className="text-muted-foreground">{conf?.label ?? key}</span>
                <span className="ml-auto font-mono font-medium tabular-nums">{item.value ?? 0}</span>
              </div>
            )
          })}
        </div>
      </div>
    )
  }
)
ChartTooltipContent.displayName = "ChartTooltipContent"

const ChartLegend = RechartsPrimitive.Legend

function ChartLegendContent({
  payload,
  className,
}: React.ComponentProps<"div"> & {
  payload?: Array<{ value?: string; color?: string }>
}) {
  const { config } = useChart()

  if (!payload?.length) {
    return null
  }

  return (
    <div className={cn("flex items-center justify-center gap-4", className)}>
      {payload.map((item, index) => {
        const key = String(item.value ?? "value")
        const conf = config[key]
        return (
          <div key={`${key}-${index}`} className="flex items-center gap-1.5">
            <span className="size-2 rounded-[2px]" style={{ backgroundColor: item.color ?? `var(--color-${key})` }} />
            <span className="text-muted-foreground">{conf?.label ?? key}</span>
          </div>
        )
      })}
    </div>
  )
}

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
}
