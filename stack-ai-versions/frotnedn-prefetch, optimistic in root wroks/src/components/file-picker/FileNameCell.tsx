import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronDown, ChevronRight, Folder, File, FolderOpen } from "lucide-react";
import { FileItem } from "@/lib/types/file";
import { useRef, useEffect } from "react";

interface FileNameCellProps {
  file: FileItem;
  isFiltering: boolean | string;
  toggleFolder?: (folderId: string) => void;
  // Prefetch functions
  startPrefetch?: (folderId: string, delay?: number) => void;
  stopPrefetch?: (folderId: string) => void;
  registerFolder?: (element: HTMLElement | null, folderId: string) => (() => void) | undefined;
  isPrefetching?: (folderId: string) => boolean;
}

export function FileNameCell({ 
  file, 
  isFiltering, 
  toggleFolder,
  startPrefetch,
  stopPrefetch,
  registerFolder,
  isPrefetching,
}: FileNameCellProps) {
  const level = file.level || 0;
  const isDirectory = file.type === "directory";
  const isExpanded = file.isExpanded;
  const isLoading = file.isLoading;
  const folderRef = useRef<HTMLDivElement>(null);

  // Register folder for viewport tracking
  useEffect(() => {
    if (isDirectory && registerFolder && folderRef.current) {
      const cleanup = registerFolder(folderRef.current, file.id);
      return cleanup;
    }
  }, [isDirectory, registerFolder, file.id]);

  // Function to truncate path intelligently
  const truncatePath = (path: string, maxLength: number = 40) => {
    if (path.length <= maxLength) return path;

    const parts = path.split("/");
    if (parts.length <= 2) return path;

    const fileName = parts[parts.length - 1];
    const firstFolder = parts[0];

    if (firstFolder.length + fileName.length + 5 <= maxLength) {
      return `${firstFolder}/.../${fileName}`;
    }

    return `.../${fileName}`;
  };

  const isPrefetchingFolder = isPrefetching?.(file.id) || false;

  return (
    <div 
      ref={folderRef}
      className="flex items-center space-x-1" 
      style={{ paddingLeft: isFiltering ? "0px" : `${level * 20}px` }}
    >
      {/* Expand/Collapse Button - Fixed size container */}
      {!isFiltering && isDirectory && (
        <div className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
          <Button
            variant="ghost"
            size="sm"
            className="h-4 w-4 p-0 hover:bg-gray-100 flex items-center justify-center"
            onClick={(e) => {
              e.stopPropagation();
              toggleFolder?.(file.id);
            }}
            disabled={isLoading}
          >
            {isLoading ? (
              <div className="h-4 w-4 animate-spin rounded-full border border-gray-300 border-t-blue-600" />
            ) : isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
        </div>
      )}

      {/* Spacer for files when not filtering - Fixed size */}
      {!isFiltering && !isDirectory && <div className="flex-shrink-0 w-4 h-4" />}

      {/* File/Folder Icon with prefetch indicator - Fixed size container */}
      <div className="relative flex-shrink-0 w-4 h-4 flex items-center justify-center">
        {isDirectory ? (
          isExpanded ? (
            <FolderOpen className="h-4 w-4 text-blue-500" />
          ) : (
            <Folder className={`h-4 w-4 ${isPrefetchingFolder ? 'text-blue-400' : 'text-blue-500'}`} />
          )
        ) : (
          <File className="h-4 w-4 text-gray-500" />
        )}
        {/* Small prefetch indicator - positioned to not affect layout */}
        {isPrefetchingFolder && (
          <div 
            className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 bg-blue-400 rounded-full opacity-75" 
            title="Pre-loading folder contents..."
          />
        )}
      </div>

      {/* File Name */}
      {isLoading ? (
        <Skeleton className="h-4 w-32" />
      ) : (
        <span className="truncate cursor-default min-w-0" title={isFiltering ? file.name : file.name.split("/").pop()}>
          {isFiltering ? truncatePath(file.name) : file.name.split("/").pop()}
        </span>
      )}
    </div>
  );
}
