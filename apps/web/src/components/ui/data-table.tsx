"use client";

import * as React from "react";
import type {
  ColumnDef,
  ColumnFiltersState,
  OnChangeFn,
  PaginationState,
  RowSelectionState,
  SortingState,
  Table as TanstackTable,
  VisibilityState
} from "@tanstack/react-table";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable
} from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { DataTableViewOptions } from "@/components/ui/data-table-view-options";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger
} from "@/components/ui/drawer";
import { SlidersHorizontal } from "lucide-react";

type DataTableColumnMeta = {
  headerClassName?: string;
  cellClassName?: string;
};

function readDataTableColumnMeta(meta: unknown): DataTableColumnMeta {
  if (!meta || typeof meta !== "object") {
    return {};
  }
  const record = meta as Record<string, unknown>;
  return {
    headerClassName: typeof record.headerClassName === "string" ? record.headerClassName : undefined,
    cellClassName: typeof record.cellClassName === "string" ? record.cellClassName : undefined
  };
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  emptyMessage?: string;
  onRowClick?: (row: TData) => void;
  getRowClassName?: (row: TData) => string | undefined;
  filterColumn?: string;
  filterPlaceholder?: string;
  toolbarActions?: React.ReactNode;
  /** Renders filter controls with access to the table instance (column filters, etc.). Takes precedence over `toolbarActions` when provided. */
  renderToolbarActions?: (table: TanstackTable<TData>) => React.ReactNode;
  toolbarTrailing?: React.ReactNode;
  showViewOptions?: boolean;
  showHorizontalScrollbarOnHover?: boolean;
  defaultPageSize?: number;
  /** When true, pagination footer is shown even for a single page (row count and page size remain visible). */
  alwaysShowPagination?: boolean;
  initialColumnVisibility?: VisibilityState;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  emptyMessage = "No results.",
  onRowClick,
  getRowClassName,
  filterColumn,
  filterPlaceholder = "Filter...",
  toolbarActions,
  renderToolbarActions,
  toolbarTrailing,
  showViewOptions = true,
  showHorizontalScrollbarOnHover = false,
  defaultPageSize = 10,
  alwaysShowPagination = false,
  initialColumnVisibility
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(() => initialColumnVisibility ?? {});
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [pagination, setPagination] = React.useState<PaginationState>({
    pageIndex: 0,
    pageSize: defaultPageSize
  });
  const [mobileFiltersOpen, setMobileFiltersOpen] = React.useState(false);

  const handleColumnFiltersChange = React.useCallback<OnChangeFn<ColumnFiltersState>>((updater) => {
    setColumnFilters(updater);
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  }, []);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    onColumnFiltersChange: handleColumnFiltersChange,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    onPaginationChange: setPagination,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
      pagination
    }
  });

  const toolbarNode = renderToolbarActions ? renderToolbarActions(table) : toolbarActions;
  const shouldHidePagination = !alwaysShowPagination && table.getPageCount() <= 1;

  return (
    <div className="ui-data-table">
      {filterColumn || toolbarNode || toolbarTrailing || showViewOptions ? (
        <div className="ui-data-table-toolbar">
          {filterColumn ? (
            <Input
              placeholder={filterPlaceholder}
              value={(table.getColumn(filterColumn)?.getFilterValue() as string) ?? ""}
              onChange={(event) => table.getColumn(filterColumn)?.setFilterValue(event.target.value)}
              className="ui-data-table-filter-input"
            />
          ) : null}
          {toolbarNode ? (
            <>
              <div className="ui-data-table-toolbar-actions ui-data-table-toolbar-actions-inline">{toolbarNode}</div>
              <div className="ui-data-table-toolbar-actions ui-data-table-toolbar-actions-mobile">
                <Drawer open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
                  <DrawerTrigger asChild>
                    <Button variant="outline" size="sm" className="ui-data-table-mobile-actions-trigger">
                      <SlidersHorizontal />
                      Filters
                    </Button>
                  </DrawerTrigger>
                  <DrawerContent className="ui-mobile-safe-bottom">
                    <DrawerHeader>
                      <DrawerTitle>Filters</DrawerTitle>
                      <DrawerDescription>Refine rows with quick mobile controls.</DrawerDescription>
                    </DrawerHeader>
                    <div className="space-y-3 pb-2">{toolbarNode}</div>
                  </DrawerContent>
                </Drawer>
              </div>
            </>
          ) : null}
          {toolbarTrailing || showViewOptions ? (
            <div className="ui-data-table-toolbar-right">
              {showViewOptions ? <DataTableViewOptions table={table} /> : null}
              {toolbarTrailing}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={cn("ui-data-table-surface", showHorizontalScrollbarOnHover ? "ui-data-table-surface-hover-scrollbar" : undefined)}>
        <Table className="ui-data-table-table">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="ui-data-table-header-row">
                {headerGroup.headers.map((header) => {
                  const colMeta = readDataTableColumnMeta(header.column.columnDef.meta);
                  return (
                    <TableHead
                      key={header.id}
                      className={cn("ui-data-table-header-cell", colMeta.headerClassName)}
                    >
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  className={cn("ui-data-table-row", onRowClick ? "ui-data-table-row-clickable" : undefined, getRowClassName?.(row.original))}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                >
                  {row.getVisibleCells().map((cell) => {
                    const colMeta = readDataTableColumnMeta(cell.column.columnDef.meta);
                    return (
                      <TableCell key={cell.id} className={cn("ui-data-table-cell", colMeta.cellClassName)}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={Math.max(table.getVisibleLeafColumns().length, 1)} className="ui-data-table-empty-cell">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {shouldHidePagination ? null : <DataTablePagination table={table} />}
    </div>
  );
}
