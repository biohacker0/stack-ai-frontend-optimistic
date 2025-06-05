import { useState, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listResources } from "@/lib/api/connections";
import { listKBResourcesSafe } from "@/lib/api/knowledgeBase";
import { FileItem } from "@/lib/types/file";
import { toast } from 'react-toastify';
import { usePrefetch } from "./usePrefetch";
import { useDataManager } from "./useDataManager";

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
  const { 
    resolveFileStatus, 
    getFolderPathFromFileName,
    // Unified optimistic update tracking
    optimisticUpdateCount
  } = useDataManager();

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

  // Update cached files with KB status and return polling info
  const updateCachedFilesWithStatus = useCallback(
    (folderId: string, kbStatusMap: Map<string, string>) => {
      const folderData = queryClient.getQueryData<{ data: FileItem[] }>(["drive-files", folderId]);
      
      if (!folderData?.data) return { hasPending: false, hasErrors: false };

      let hasPending = false;
      let hasErrors = false;

      const updatedFiles = folderData.data.map(file => {
        if (file.type === "file") {
          const kbStatus = kbStatusMap.get(file.id);
          if (kbStatus) {
            if (kbStatus === "pending") hasPending = true;
            if (kbStatus === "failed" || kbStatus === "error") hasErrors = true;
            
            return { ...file, status: kbStatus as FileItem["status"] };
          }
        }
        return file;
      });

      // Update the cache with new status
      queryClient.setQueryData(["drive-files", folderId], { data: updatedFiles });

      return { hasPending, hasErrors };
    },
    [queryClient]
  );

  // Poll folder status periodically
  const pollFolderStatus = useCallback(
    async (folderPath: string, folderId: string) => {
      if (!kbId) return;

      try {
        console.log(`🔄 Background polling for folder: ${folderPath}`);
        
        // Get current cached status
        const currentCache = queryClient.getQueryData<{ data: FileItem[] }>(["kb-file-status", kbId, folderPath]);
        
        // Fetch fresh status from API
        const kbStatusMap = await fetchKBStatusForFolder(folderPath);
        
        // Only update cache if there are meaningful changes
        let hasChanges = false;
        let hasPending = false;
        let hasErrors = false;
        
        if (currentCache?.data) {
          // Compare current cache with fresh data
          kbStatusMap.forEach((newStatus, fileId) => {
            const currentFile = currentCache.data.find(f => f.id === fileId);
            const currentStatus = currentFile?.status;
            
            if (currentStatus !== newStatus) {
              hasChanges = true;
              console.log(`📊 Status change detected for ${fileId}: ${currentStatus} → ${newStatus}`);
            }
            
            if (newStatus === "pending") hasPending = true;
            if (newStatus === "failed" || newStatus === "error") hasErrors = true;
          });
          
          // Only update if there are actual changes
          if (hasChanges) {
            console.log(`📝 Updating folder cache due to status changes: ${folderPath}`);
            const { hasPending: updatedHasPending, hasErrors: updatedHasErrors } = updateCachedFilesWithStatus(folderId, kbStatusMap);
            hasPending = updatedHasPending;
            hasErrors = updatedHasErrors;
          } else {
            console.log(`📦 No status changes detected for folder: ${folderPath}, keeping optimistic cache`);
          }
        } else {
          // No cache exists, update with fresh data
          console.log(`📝 No existing cache, updating with fresh data: ${folderPath}`);
          const result = updateCachedFilesWithStatus(folderId, kbStatusMap);
          hasPending = result.hasPending;
          hasErrors = result.hasErrors;
        }

        console.log(`📊 Poll result for ${folderPath}: hasPending=${hasPending}, hasErrors=${hasErrors}, hasChanges=${hasChanges}`);

        // Continue polling if there are still pending files
        if (hasPending) {
          setTimeout(() => pollFolderStatus(folderPath, folderId), POLL_INTERVAL);
        } else {
          console.log(`✅ Polling stopped for ${folderPath}: all files settled`);
        }
      } catch (error) {
        console.error(`❌ Polling failed for ${folderPath}:`, error);
        // Don't retry on error to avoid infinite loops
      }
    },
    [kbId, fetchKBStatusForFolder, updateCachedFilesWithStatus, queryClient]
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
        // 1. Fetch Google Drive contents (always needed for file tree structure)
        const driveFiles = await fetchFolderContents(folderId);

        if (kbId && driveFiles.length > 0) {
          const folderPath = getFolderPath(driveFiles);
          console.log(`Expanding folder: ${folderPath}`);
          
          // 2. Check if we have optimistic folder status cache
          const existingFolderCache = queryClient.getQueryData<{ data: FileItem[] }>(["kb-file-status", kbId, folderPath]);
          
          if (existingFolderCache?.data) {
            // ✅ CACHE HIT: Use optimistic cache, expand immediately
            console.log(`📦 Using cached folder status for: ${folderPath} (${existingFolderCache.data.length} files)`);
            
            // Update the drive files cache with cached status
            const { hasPending, hasErrors } = updateCachedFilesWithStatus(folderId, new Map(
              existingFolderCache.data.map(file => [file.id, file.status || "unknown"])
            ));
            
            // Show error toast if errors found
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
            
            // Start background polling if there are pending files (don't block UI)
            if (hasPending) {
              console.log(`🔄 Background polling started for folder: ${folderPath}`);
              setTimeout(() => pollFolderStatus(folderPath, folderId), POLL_INTERVAL);
            }
            
            // Expand immediately with cached data
            setExpandedFolders((prev) => new Set(prev).add(folderId));
          } else {
            // ❌ CACHE MISS: No optimistic cache, fetch fresh status
            console.log(`🌐 No cached status found for: ${folderPath}, fetching fresh data`);
            
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
            
            setExpandedFolders((prev) => new Set(prev).add(folderId));
          }
        } else {
          // No KB or no files, just expand
          setExpandedFolders((prev) => new Set(prev).add(folderId));
        }
      } catch (error) {
        console.error("Failed to load folder contents:", error);
        setExpandedFolders((prev) => new Set(prev).add(folderId));
      } finally {
        setLoadingFolders((prev) => {
          const newSet = new Set(prev);
          newSet.delete(folderId);
          return newSet;
        });
      }
    },
    [expandedFolders, fetchFolderContents, kbId, getFolderPath, fetchKBStatusForFolder, updateCachedFilesWithStatus, pollFolderStatus, errorToastShown, cancelPrefetch, queryClient]
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

        // Use DataManager's resolveFileStatus for consistent status resolution
        let finalStatus: FileItem["status"];
        
        if (level === 0) {
          // Root level: use DataManager resolver (checks optimistic registry first)
          const resolved = resolveFileStatus(file.id, kbId || null);
          finalStatus = resolved === "-" || resolved === null ? undefined : resolved;
          console.log(`Root file ${file.id}: resolved status: ${finalStatus || 'undefined'}`);
        } else {
          // Nested files: use DataManager resolver with folder path
          const folderPath = getFolderPathFromFileName(file.name);
          const resolved = resolveFileStatus(file.id, kbId || null, folderPath);
          finalStatus = resolved === "-" || resolved === null ? undefined : resolved;
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
    [expandedFolders, loadingFolders, queryClient, refreshTrigger, resolveFileStatus, kbId, getFolderPathFromFileName]
  );

  // Build file tree from root data - now reactive to optimistic cache changes
  const fileTree = useMemo(() => {
    return rootData?.data ? buildFileTree(rootData.data) : [];
  }, [rootData?.data, buildFileTree, refreshTrigger, optimisticUpdateCount]);

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
    // Force refresh for optimistic updates
    forceRefresh: () => setRefreshTrigger(prev => prev + 1),
  };
}
