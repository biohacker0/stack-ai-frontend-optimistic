import { useState, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listResources } from "@/lib/api/connections";
import { listKBResourcesSafe } from "@/lib/api/knowledgeBase";
import { FileItem } from "@/lib/types/file";
import { toast } from 'react-toastify';
import { usePrefetch } from "./usePrefetch";

interface UseFileTreeProps {
  kbId?: string | null;
  statusMap?: Map<string, string>;
  isCreatingKB?: boolean;
}

// Constants
const STALE_TIME = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL = 1000; // 1 second for faster updates

export function useFileTree({ kbId, statusMap, isCreatingKB }: UseFileTreeProps = {}) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());
  const [errorToastShown, setErrorToastShown] = useState<Set<string>>(new Set());
  const [refreshTrigger, setRefreshTrigger] = useState(0); // Force refresh trigger
  const queryClient = useQueryClient();

  // Initialize prefetch functionality
  const {
    startPrefetch,
    stopPrefetch,
    registerFolder,
    isPrefetching,
    cancelPrefetch,
  } = usePrefetch({
    kbId,
    isEnabled: true, // Always enabled for now, can be made configurable
    isCreatingKB,
  });

  // Fetch root files
  const {
    data: rootData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["drive-files", "root"],
    queryFn: () => listResources(),
    staleTime: STALE_TIME,
  });

  // Fetch folder contents with caching
  const fetchFolderContents = useCallback(
    async (folderId: string) => {
      const result = await queryClient.fetchQuery({
        queryKey: ["drive-files", folderId],
        queryFn: () => listResources(folderId),
        staleTime: STALE_TIME,
      });
      return result?.data || [];
    },
    [queryClient]
  );

  // Fetch KB status for a folder path
  const fetchKBStatusForFolder = useCallback(
    async (folderPath: string) => {
      if (!kbId) return new Map<string, string>();

      try {
        // Force fresh fetch
        await queryClient.invalidateQueries({
          queryKey: ["kb-file-status", kbId, folderPath],
        });

        const kbData = await listKBResourcesSafe(kbId, folderPath);
        const statusMap = new Map<string, string>();

        if (kbData?.data) {
          kbData.data.forEach((resource: any) => {
            statusMap.set(resource.id, resource.status || "unknown");
          });
        }

        return statusMap;
      } catch (error) {
        console.error("Failed to fetch KB status:", error);
        return new Map<string, string>();
      }
    },
    [kbId, queryClient]
  );

  // Extract folder path from file list
  const getFolderPath = useCallback((files: FileItem[]) => {
    if (!files.length) return "";

    const firstFile = files[0];
    const pathParts = firstFile.name.split("/");
    pathParts.pop(); // Remove filename
    return "/" + pathParts.join("/");
  }, []);

  // Update cached files with KB status
  const updateCachedFilesWithStatus = useCallback(
    (folderId: string, kbStatusMap: Map<string, string>) => {
      const cacheKey = ["drive-files", folderId];
      const cachedData = queryClient.getQueryData<{ data: FileItem[] }>(cacheKey);

      if (!cachedData?.data) return { updatedFiles: [], hasPending: false, hasErrors: false };

      const updatedFiles = cachedData.data.map((file) => ({
        ...file,
        status: (kbStatusMap.get(file.id) as FileItem["status"]) || file.status,
      }));

      // IMPORTANT: Update the cache immediately so UI reflects changes
      queryClient.setQueryData(cacheKey, { data: updatedFiles });
      
      // CRITICAL: Trigger a refresh to force UI update
      setRefreshTrigger(prev => prev + 1);

      const hasPending = updatedFiles.some((file) => file.type === "file" && file.status === "pending");
      const hasErrors = updatedFiles.some((file) => file.type === "file" && file.status === "error");

      console.log(`Updated cache for folder ${folderId}: ${updatedFiles.length} files, hasPending=${hasPending}, hasErrors=${hasErrors}`);

      return { updatedFiles, hasPending, hasErrors };
    },
    [queryClient]
  );

  // Poll folder status for pending files
  const pollFolderStatus = useCallback(
    async (folderPath: string, folderId: string) => {
      try {
        console.log(`Polling folder status for: ${folderPath}`);
        const freshStatus = await fetchKBStatusForFolder(folderPath);
        
        // Check if we have any files with status
        const statusValues = Array.from(freshStatus.values());
        const pendingFiles = statusValues.filter(status => status === "pending");
        const pendingDeleteFiles = statusValues.filter(status => status === "pending_delete");
        
        console.log(`Folder ${folderPath}: ${pendingFiles.length} pending, ${pendingDeleteFiles.length} pending_delete`);

        // ALWAYS update the cache with fresh status, even if still pending
        const { hasErrors } = updateCachedFilesWithStatus(folderId, freshStatus);

        // Continue polling if there are still pending files
        const stillPending = pendingFiles.length > 0 || pendingDeleteFiles.length > 0;

        if (stillPending) {
          // Continue polling
          setTimeout(() => pollFolderStatus(folderPath, folderId), POLL_INTERVAL);
        } else {
          console.log(`Folder ${folderPath} polling complete. Has errors: ${hasErrors}`);
          
          // Show error toast if errors found and not already shown for this folder
          if (hasErrors && !errorToastShown.has(folderId)) {
            setErrorToastShown(prev => new Set(prev).add(folderId));
            toast.error(
              `Some files in this folder failed to index. The knowledge base may be corrupted. Please create a new knowledge base.`,
              {
                autoClose: 8000,
                toastId: `folder-error-${folderId}`
              }
            );
          }
        }
      } catch (error) {
        console.error(`Error polling folder ${folderPath}:`, error);
      }
    },
    [fetchKBStatusForFolder, updateCachedFilesWithStatus, errorToastShown]
  );

  // Toggle folder expansion
  const toggleFolder = useCallback(
    async (folderId: string) => {
      const isExpanded = expandedFolders.has(folderId);

      if (isExpanded) {
        // Collapse folder
        setExpandedFolders((prev) => {
          const newSet = new Set(prev);
          newSet.delete(folderId);
          return newSet;
        });
        return;
      }

      // Cancel any ongoing prefetch for this folder to avoid conflicts
      cancelPrefetch(folderId);

      // Expand folder
      setLoadingFolders((prev) => new Set(prev).add(folderId));

      try {
        // Fetch Google Drive contents
        const driveFiles = await fetchFolderContents(folderId);

        // Fetch and merge KB status if available
        if (kbId && driveFiles.length > 0) {
          const folderPath = getFolderPath(driveFiles);
          console.log(`Expanding folder: ${folderPath}`);
          
          const kbStatusMap = await fetchKBStatusForFolder(folderPath);

          const { hasPending, hasErrors } = updateCachedFilesWithStatus(folderId, kbStatusMap);

          console.log(`Folder ${folderPath}: hasPending=${hasPending}, hasErrors=${hasErrors}`);

          // Show error toast immediately if errors found and not already shown
          if (hasErrors && !errorToastShown.has(folderId)) {
            setErrorToastShown(prev => new Set(prev).add(folderId));
            toast.error(
              `Some files in this folder failed to index. The knowledge base may be corrupted. Please create a new knowledge base.`,
              {
                autoClose: 8000,
                toastId: `folder-error-${folderId}`
              }
            );
          }

          // Start polling if there are pending files
          if (hasPending) {
            console.log(`Starting polling for folder: ${folderPath}`);
            setTimeout(() => pollFolderStatus(folderPath, folderId), POLL_INTERVAL);
          }
        }

        setExpandedFolders((prev) => new Set(prev).add(folderId));
      } catch (error) {
        console.error("Failed to load folder contents:", error);
      } finally {
        setLoadingFolders((prev) => {
          const newSet = new Set(prev);
          newSet.delete(folderId);
          return newSet;
        });
      }
    },
    [expandedFolders, fetchFolderContents, kbId, getFolderPath, fetchKBStatusForFolder, updateCachedFilesWithStatus, pollFolderStatus, errorToastShown, cancelPrefetch]
  );

  // Build hierarchical file tree
  const buildFileTree = useCallback(
    (files: FileItem[], level = 0, parentPath = ""): FileItem[] => {
      return files.map((file) => {
        const isExpanded = expandedFolders.has(file.id);
        const isLoading = loadingFolders.has(file.id);
        let children: FileItem[] = [];

        if (file.type === "directory" && isExpanded && !isLoading) {
          const folderData = queryClient.getQueryData<{ data: FileItem[] }>(["drive-files", file.id]);

          if (folderData?.data) {
            const currentPath = parentPath ? `${parentPath}/${file.name.split("/").pop()}` : file.name.split("/").pop() || "";
            children = buildFileTree(folderData.data, level + 1, currentPath);
          }
        }

        // Apply KB status - root level uses statusMap, children use cached status
        let finalStatus: FileItem["status"];
        
        if (level === 0) {
          // Root level: use statusMap if available, otherwise undefined (which will show as "-")
          const kbStatus = statusMap?.get(file.id) as FileItem["status"];
          finalStatus = kbStatus; // Don't fall back to file.status for root level
          
          console.log(`Root file ${file.id}: statusMap has ${kbStatus ? kbStatus : 'no status'}, final: ${finalStatus || 'undefined'}`);
        } else {
          // Nested files: use cached status from folder expansion
          finalStatus = file.status;
        }

        return {
          ...file,
          isExpanded,
          isLoading,
          children,
          level,
          status: finalStatus,
        };
      });
    },
    [expandedFolders, loadingFolders, queryClient, statusMap, refreshTrigger]
  );

  // Build file tree from root data
  const fileTree = useMemo(() => {
    return rootData?.data ? buildFileTree(rootData.data) : [];
  }, [rootData?.data, buildFileTree, refreshTrigger]);

  // Flatten tree for table display
  const flattenTree = useCallback((tree: FileItem[]): FileItem[] => {
    const result: FileItem[] = [];

    const traverse = (items: FileItem[]) => {
      items.forEach((item) => {
        result.push(item);
        if (item.children?.length) {
          traverse(item.children);
        }
      });
    };

    traverse(tree);
    return result;
  }, []);

  const flatFiles = useMemo(() => flattenTree(fileTree), [fileTree, flattenTree]);

  // Collapse all folders - useful after deletion
  const collapseAllFolders = useCallback(() => {
    setExpandedFolders(new Set());
    setLoadingFolders(new Set());
    setErrorToastShown(new Set()); // Reset error toast tracking
  }, []);

  return {
    files: flatFiles,
    isLoading,
    error,
    expandedFolders,
    toggleFolder,
    collapseAllFolders,
    refetch,
    // Prefetch functions
    startPrefetch,
    stopPrefetch,
    registerFolder,
    isPrefetching,
  };
}
