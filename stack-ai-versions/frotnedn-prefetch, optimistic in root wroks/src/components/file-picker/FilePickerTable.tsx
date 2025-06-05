"use client";

import { useEffect, useMemo, useState } from "react";
import React from "react";
import {
  ColumnDef,
  ColumnFiltersState,
  SortingState,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { FilePickerControls } from "./FilePickerControls";
import { FileNameCell } from "./FileNameCell";
import { FileSizeCell } from "./FileSizeCell";
import { FileStatusCell } from "./FileStatusCell";
import { useFileSelection } from "@/hooks/useFileSelection";
import { FileItem } from "@/lib/types/file";

interface FilePickerTableProps {
  files: FileItem[];
  isLoading?: boolean;
  toggleFolder?: (folderId: string) => void;
  onCreateKB?: (resourceIds: string[], files: FileItem[]) => void;
  onCreateNewKB?: () => void;
  onDeleteFiles?: (selectedIds: string[]) => void;
  hasKB?: boolean;
  isCreatingKB?: boolean;
  isDeletingKB?: boolean;
  isActuallyDeleting?: boolean;
  statusMap?: Map<string, string>;
  canDeleteFile?: (file: FileItem) => boolean;
  canDeleteFolder?: (folder: FileItem) => boolean;
  isFileDeleting?: (fileId: string) => boolean;
  kbId?: string | null;
  // Prefetch functions
  startPrefetch?: (folderId: string, delay?: number) => void;
  stopPrefetch?: (folderId: string) => void;
  registerFolder?: (element: HTMLElement | null, folderId: string) => (() => void) | undefined;
  isPrefetching?: (folderId: string) => boolean;
}

export function FilePickerTable({
  files,
  isLoading,
  toggleFolder,
  onCreateKB,
  onCreateNewKB,
  onDeleteFiles,
  hasKB,
  isCreatingKB,
  isDeletingKB,
  isActuallyDeleting,
  statusMap,
  canDeleteFile,
  canDeleteFolder,
  isFileDeleting,
  kbId,
  // Prefetch functions
  startPrefetch,
  stopPrefetch,
  registerFolder,
  isPrefetching,
}: FilePickerTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  // Use custom selection hook
  const { rowSelection, selectedFiles, selectedResourceIds, handleRowSelection, handleSelectAll, canSelectFile } = useFileSelection({ 
    files, 
    statusMap, 
    hasKB,
    kbId
  });

  // Define columns with custom selection logic
  const columns = useMemo<ColumnDef<FileItem>[]>(
    () => [
      {
        id: "select",
        header: ({ table }) => {
          const allRowsSelected = table.getIsAllPageRowsSelected();
          const someRowsSelected = table.getIsSomePageRowsSelected();

          return (
            <Checkbox
              checked={allRowsSelected || (someRowsSelected && "indeterminate")}
              onCheckedChange={(value) => {
                handleSelectAll(!!value, table.getRowModel().rows);
              }}
              aria-label="Select all"
              className="h-4 w-4"
            />
          );
        },
        cell: ({ row }) => {
          const file = row.original;
          const fileId = file.id;
          const isSelected = rowSelection[fileId] ?? false;

          // Use the new canSelectFile function for consistent selection logic
          const canSelect = canSelectFile(file);

          return (
            <Checkbox
              checked={isSelected}
              onCheckedChange={(value) => handleRowSelection(fileId, !!value)}
              aria-label="Select row"
              onClick={(e) => e.stopPropagation()}
              disabled={!canSelect}
              className="border-2 border-gray-400 data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600 h-4 w-4"
            />
          );
        },
        enableSorting: false,
        enableHiding: false,
      },
      {
        accessorKey: "name",
        header: ({ column }) => {
          return (
            <Button variant="ghost" onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}>
              Name
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </Button>
          );
        },
        filterFn: (row, columnId, filterValue) => {
          if (!filterValue) return true;

          const file = row.original;
          const searchTerm = filterValue.toLowerCase();

          // Search by file name (show full path when searching)
          const fileName = file.name.toLowerCase();
          const fileNameMatch = fileName.includes(searchTerm);

          // Search by status
          const status = file.status?.toLowerCase() || "";
          const statusMatch = status.includes(searchTerm);

          return fileNameMatch || statusMatch;
        },
        cell: ({ row, table }) => {
          const file = row.original;
          const filterValue = table.getColumn("name")?.getFilterValue() as string;
          const isFiltering = filterValue && filterValue.length > 0;

          return (
            <FileNameCell 
              file={file} 
              isFiltering={isFiltering} 
              toggleFolder={toggleFolder}
              startPrefetch={startPrefetch}
              stopPrefetch={stopPrefetch}
              registerFolder={registerFolder}
              isPrefetching={isPrefetching}
            />
          );
        },
      },
      {
        accessorKey: "size",
        header: () => <div className="text-right pr-8">Size</div>,
        cell: ({ row }) => {
          const size = row.getValue("size") as number;
          return <FileSizeCell size={size} />;
        },
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => {
          const file = row.original;
          return <FileStatusCell file={file} isFileDeleting={isFileDeleting} />;
        },
      },
    ],
    [rowSelection, handleRowSelection, toggleFolder, startPrefetch, stopPrefetch, registerFolder, isPrefetching, canSelectFile, hasKB, canDeleteFile, canDeleteFolder, isFileDeleting]
  );

  const table = useReactTable({
    data: files,
    columns,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    getRowId: (row) => row.id,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
    },
    enableRowSelection: true,
    initialState: {
      pagination: {
        pageSize: 20,
      },
    },
    manualPagination: false,
  });

  return (
    <div className="w-full h-full flex flex-col space-y-4 text-base text-gray-900">
      {/* Top Controls */}
      <FilePickerControls
        searchValue={(table.getColumn("name")?.getFilterValue() as string) ?? ""}
        onSearchChange={(value) => table.getColumn("name")?.setFilterValue(value)}
        filteredCount={table.getFilteredRowModel().rows.length}
        selectedFiles={selectedFiles}
        selectedResourceIds={selectedResourceIds}
                  hasKB={hasKB}
          isCreatingKB={isCreatingKB}
          isDeletingKB={isDeletingKB}
          isActuallyDeleting={isActuallyDeleting}
          onCreateKB={onCreateKB}
          onCreateNewKB={onCreateNewKB}
          onDeleteFiles={onDeleteFiles}
          allFiles={files}
      />

      {/* Table Container with Internal Scroll */}
      <div className="flex-1 min-h-0 rounded-md border-2 border-gray-300 flex flex-col bg-white shadow-sm">
        <div className="flex-1 overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-gray-50 z-10 border-b-2 border-gray-300">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    return (
                      <TableHead key={header.id} className="bg-gray-50 font-semibold text-gray-900 border-r border-gray-200 last:border-r-1">
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={columns.length} className="p-0">
                    <TableSkeleton message={isCreatingKB ? "Creating Knowledge Base..." : isDeletingKB ? "Deleting files..." : "Loading files..."} rows={10} />
                  </TableCell>
                </TableRow>
              ) : table.getRowModel().rows?.length ? (
                table.getRowModel().rows.map((row) => {
                  const file = row.original;
                  const isDirectory = file.type === "directory";
                  const isExpanded = file.isExpanded;
                  const isLoading = file.isLoading;

                  // Handle row hover for prefetching
                  const handleRowMouseEnter = () => {
                    if (isDirectory && !isExpanded && !isLoading && startPrefetch) {
                      startPrefetch(file.id, 300); // 300ms delay
                    }
                  };

                  const handleRowMouseLeave = () => {
                    if (isDirectory && stopPrefetch) {
                      stopPrefetch(file.id);
                    }
                  };

                  return (
                    <TableRow 
                      key={row.id} 
                      data-state={row.getIsSelected() && "selected"} 
                      className="hover:bg-gray-50 /* border-b border-gray-200 */"
                      onMouseEnter={handleRowMouseEnter}
                      onMouseLeave={handleRowMouseLeave}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className="/* border-r border-gray-100 */ last:border-r-0 py-2.5 px-2">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-24 text-center">
                    No files found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {/* Load More Button - Inside Table Container */}
        {table.getCanNextPage() && (
          <div className="border-t-2 border-gray-300 bg-gray-50">
            <Button
              variant="ghost"
              size="lg"
              onClick={() => {
                // Increase page size to show more items instead of going to next page
                const currentPageSize = table.getState().pagination.pageSize;
                table.setPageSize(currentPageSize + 20);
              }}
              className="w-full h-12 text-gray-800 hover:bg-gray-200 rounded-none font-medium"
            >
              Load more
            </Button>
          </div>
        )}
      </div>

      {/* Bottom Info - Outside Table */}
      <div className="flex items-center justify-between text-sm text-gray-700 flex-shrink-0 font-medium">
        <div>
          {selectedFiles.length} of {table.getFilteredRowModel().rows.length} file(s) selected.
        </div>
      </div>
    </div>
  );
}
