import { useState, useCallback, useMemo, useEffect } from "react";
import { FileItem } from "@/lib/types/file";
import { useDataManager } from "./useDataManager";

interface UseFileSelectionProps {
  files: FileItem[];
  statusMap?: Map<string, string>;
  hasKB?: boolean;
  kbId?: string | null;
}

export function useFileSelection({ files, statusMap, hasKB, kbId }: UseFileSelectionProps) {
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});
  const { resolveFileStatus, getFolderPathFromFileName } = useDataManager();

  // Auto-deselect files that are no longer indexed when in KB mode
  useEffect(() => {
    if (!hasKB || !kbId) return;

    setRowSelection(prev => {
      const newSelection = { ...prev };
      let hasChanges = false;

      Object.keys(prev).forEach(fileId => {
        const file = files.find(f => f.id === fileId);
        if (!file) return;

        // Use DataManager's resolveFileStatus for accurate status
        const folderPath = file.level && file.level > 0 ? getFolderPathFromFileName(file.name) : undefined;
        const resolvedStatus = resolveFileStatus(fileId, kbId, folderPath);
        
        // If file is selected but no longer indexed, deselect it
        if (resolvedStatus !== "indexed") {
          delete newSelection[fileId];
          hasChanges = true;
          console.log(`Auto-deselected file ${fileId} (resolved status: ${resolvedStatus || 'undefined'})`);
        }
      });

      return hasChanges ? newSelection : prev;
    });
  }, [files, hasKB, kbId, resolveFileStatus, getFolderPathFromFileName]);

  // Helper to check if a file can be selected
  const canSelectFile = useCallback((file: FileItem): boolean => {
    if (!hasKB) return true; // In create mode, all files can be selected
    
    if (!kbId) return false; // No KB ID available
    
    // Use DataManager's resolveFileStatus for accurate status resolution
    const folderPath = file.level && file.level > 0 ? getFolderPathFromFileName(file.name) : undefined;
    const resolvedStatus = resolveFileStatus(file.id, kbId, folderPath);
    
    // Only indexed files can be selected in KB mode
    const canSelect = resolvedStatus === "indexed";
    
    if (file.level === 0) {
      // Debug root files
      console.log(`Root file ${file.id}: statusMap has ${statusMap?.get(file.id)}, resolved: ${resolvedStatus}, canSelect: ${canSelect}`);
    }
    
    return canSelect;
  }, [hasKB, kbId, resolveFileStatus, getFolderPathFromFileName, statusMap]);

  // Build a map of parent-child relationships for efficient lookups
  const fileRelationships = useMemo(() => {
    const childrenMap = new Map<string, string[]>();
    const parentMap = new Map<string, string>();

    files.forEach((file) => {
      if (file.type === "directory") {
        // Find all children of this directory
        const children = files.filter((f) => f.name.startsWith(file.name + "/")).map((f) => f.id);

        childrenMap.set(file.id, children);

        // Map children to parent
        children.forEach((childId) => {
          parentMap.set(childId, file.id);
        });
      }
    });

    return { childrenMap, parentMap };
  }, [files]);

  // Helper function to get all descendant IDs recursively
  const getAllDescendantIds = useCallback(
    (fileId: string): string[] => {
      const descendants: string[] = [];
      const queue = [fileId];

      while (queue.length > 0) {
        const currentId = queue.shift()!;
        const children = fileRelationships.childrenMap.get(currentId) || [];

        children.forEach((childId) => {
          descendants.push(childId);
          queue.push(childId);
        });
      }

      return descendants;
    },
    [fileRelationships]
  );

  // Custom selection handler that validates against current status
  const handleRowSelection = useCallback(
    (fileId: string, isSelected: boolean) => {
      const file = files.find((f) => f.id === fileId);
      if (!file) return;

      // Check if file can be selected
      if (isSelected && !canSelectFile(file)) {
        console.log(`Cannot select file ${fileId} - not indexed in KB mode`);
        return;
      }

      setRowSelection((prev) => {
        const newSelection = { ...prev };

        // Toggle the clicked item
        if (isSelected) {
          newSelection[fileId] = true;
        } else {
          delete newSelection[fileId];
        }

        // If it's a directory, handle all descendants (but validate each one)
        if (file.type === "directory") {
          const descendantIds = getAllDescendantIds(fileId);

          descendantIds.forEach((id) => {
            const descendantFile = files.find(f => f.id === id);
            if (!descendantFile) return;

            if (isSelected && canSelectFile(descendantFile)) {
              newSelection[id] = true;
            } else {
              delete newSelection[id];
            }
          });
        }

        return newSelection;
      });
    },
    [files, getAllDescendantIds, canSelectFile]
  );

  // Handle select all functionality with status validation
  const handleSelectAll = useCallback((isSelected: boolean, visibleRows: any[]) => {
    const newSelection: Record<string, boolean> = {};

    if (isSelected) {
      visibleRows.forEach((row) => {
        const file = row.original;
        if (canSelectFile(file)) {
          newSelection[file.id] = true;
        }
      });
    }

    setRowSelection(newSelection);
  }, [canSelectFile]);

  // Get selected files (filtered by current status)
  const selectedFiles = useMemo(() => {
    return files.filter((file) => {
      if (!rowSelection[file.id]) return false;
      
      // Double-check that selected files are still valid
      return canSelectFile(file);
    });
  }, [files, rowSelection, canSelectFile]);

  // Get selected resource IDs
  const selectedResourceIds = useMemo(() => {
    return selectedFiles.map((file) => file.id);
  }, [selectedFiles]);

  return {
    rowSelection,
    selectedFiles,
    selectedResourceIds,
    handleRowSelection,
    handleSelectAll,
    setRowSelection,
    canSelectFile, // Expose for checkbox disable logic
  };
} 