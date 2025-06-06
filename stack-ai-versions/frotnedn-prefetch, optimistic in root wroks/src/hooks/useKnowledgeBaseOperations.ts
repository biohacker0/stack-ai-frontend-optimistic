import { useState, useCallback, useMemo, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createKnowledgeBase, syncKnowledgeBase, deleteKBResource } from "@/lib/api/knowledgeBase";
import { saveKBToStorage, getKBFromStorage, clearKBFromStorage, clearCacheFromStorage } from "@/lib/utils/localStorage";
import { deduplicateResourceIds } from "@/lib/utils/resourceDeduplication";
import { useKnowledgeBaseStatus } from "./useKnowledgeBaseStatus";
import { useKnowledgeBaseDeletion } from "./useKnowledgeBaseDeletion";
import { useDataManager, type DeleteRequest } from "./useDataManager";
import type { KnowledgeBase } from "@/lib/types/knowledgeBase";
import type { FileItem } from "@/lib/types/file";
import { toast } from 'react-toastify';

export function useKnowledgeBaseOperations() {
  const queryClient = useQueryClient();
  
  const [currentKB, setCurrentKB] = useState<KnowledgeBase | null>(() => {
    // Initialize from localStorage on mount
    const stored = getKBFromStorage();
    return stored ? { ...stored, is_empty: false } : null;
  });

  // Load cache when KB is restored from localStorage
  useEffect(() => {
    if (currentKB?.id) {
      // Cache will be loaded by DataManager's useEffect
      console.log(`📖 [KBOperations] KB restored from localStorage: ${currentKB.id}`);
    }
  }, [currentKB?.id]);

  const hasKB = currentKB !== null;

  // Use DataManager for centralized state management
  const {
    // Sync state
    syncState,
    isSyncPending,
    isSyncCompleted,
    setSyncPending,
    setSyncCompleted,
    resetSyncState,
    
    // Queue operations  
    queue,
    queueProcessing,
    queueCount,
    queueHasItems,
    queueDeleteRequest,
    removeFromQueue,
    updateQueueKBId,
    setQueueProcessing,
    clearQueue,
    
    // Registry operations
    markFileAsDeleted,
    clearRegistry,
    resolveFileStatus,
    
    // Cache operations
    updateKBResourcesCache,
    removeFromKBResourcesCache,
    setFolderContentsAsIndexed,
    
    // Folder helpers
    getFolderPathFromFileName,
    getFolderContents,
    getAllDescendantFileIds,
    
    // Cache persistence
    persistCacheToStorage,
    
    // Complete cleanup
    clearAllState,
  } = useDataManager();

  // Poll KB status after creation - enable polling when we have a KB
  const {
    statusMap,
    statusCounts,
    allFilesSettled,
    isLoading: isPolling,
    shouldPoll,
  } = useKnowledgeBaseStatus({
    kbId: currentKB?.id || null,
    enabled: hasKB,
  });

  // Handle file deletion capabilities
  const { isDeleting: isActuallyDeleting, isFileDeleting, canDeleteFile, canDeleteFolder } = useKnowledgeBaseDeletion(currentKB?.id || null, statusMap);

  // Process delete queue when sync completes
  useEffect(() => {
    console.log(`🔍 Queue effect triggered: isSyncCompleted=${isSyncCompleted}, hasItems=${queueHasItems}, processing=${queueProcessing}, kbId=${currentKB?.id}`);
    
    if (isSyncCompleted && queueHasItems && !queueProcessing) {
      console.log("🔄 Sync completed, processing delete queue");
      processQueue();
    }
  }, [isSyncCompleted, queueHasItems, queueProcessing, currentKB?.id]);

  // Process delete queue function
  const processQueue = useCallback(async () => {
    if (!currentKB?.id || queueProcessing || !queueHasItems) return;

    console.log(`🔄 Processing delete queue: ${queueCount} items`);
    setQueueProcessing(true);

    try {
      // Process queue items one by one with delay
      for (const request of queue as DeleteRequest[]) {
        try {
          console.log(`🗑️ Processing queued delete: ${request.fileName}`);
          await deleteKBResource(request.kbId, request.resourcePath);
          
          // Remove from queue on success
          removeFromQueue(request.id);
          
          console.log(`✅ Successfully deleted: ${request.fileName}`);
          
          // Add delay between deletions
          if (queue.length > 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } catch (error) {
          console.error(`❌ Failed to delete ${request.fileName}:`, error);
          // Remove failed request from queue to prevent infinite retry
          removeFromQueue(request.id);
        }
      }
      
      toast.success(`Successfully processed delete queue`, {
        autoClose: 3000,
        toastId: 'queue-processing-success'
      });
    } finally {
      setQueueProcessing(false);
    }
  }, [currentKB?.id, queue, queueProcessing, queueHasItems, queueCount, setQueueProcessing, removeFromQueue]);

  // Helper to find all files within selected folders
  const findAllFilesInSelectedFolders = useCallback(
    async (selectedIds: string[], allFiles: FileItem[]): Promise<{ folderFiles: Array<{ folderId: string; folderPath: string; fileIds: string[] }>, allFileIds: string[] }> => {
      const folderFiles: Array<{ folderId: string; folderPath: string; fileIds: string[] }> = [];
      const allFileIds: string[] = [];

      // Process each selected item
      for (const selectedId of selectedIds) {
        const selectedItem = allFiles.find(f => f.id === selectedId);
        
        if (selectedItem?.type === "directory") {
          // Check if folder contents are cached
          let folderContents = getFolderContents(selectedId);
          
          if (folderContents.length === 0) {
            // 🚀 EAGER FETCHING: Folder not cached, fetch contents now
            console.log(`🌐 Folder ${selectedItem.name} not cached, fetching contents for optimistic updates...`);
            
            try {
              // Fetch folder contents from API
              const response = await queryClient.fetchQuery({
                queryKey: ["drive-files", selectedId],
                queryFn: async () => {
                  const { listResources } = await import("@/lib/api/connections");
                  return listResources(selectedId);
                },
                staleTime: 5 * 60 * 1000, // 5 minutes
              });
              
              folderContents = response?.data || [];
              console.log(`✅ Fetched ${folderContents.length} files for folder: ${selectedItem.name}`);
            } catch (error) {
              console.error(`❌ Failed to fetch folder contents for ${selectedItem.name}:`, error);
              folderContents = []; // Continue with empty contents
            }
          }
          
          console.log(`📁 Processing folder ${selectedItem.name}: found ${folderContents.length} cached items`);
          
          if (folderContents.length > 0) {
            // Extract folder path from first file in folder
            const folderPath = getFolderPathFromFileName(folderContents[0].name);
            
            // Find all file IDs recursively within this folder
            const fileIds = getAllDescendantFileIds(folderContents, allFiles);
            
            if (fileIds.length > 0) {
              folderFiles.push({
                folderId: selectedId,
                folderPath,
                fileIds
              });
              allFileIds.push(...fileIds);
              console.log(`📁 Folder ${selectedItem.name}: found ${fileIds.length} files to mark as indexed`);
            }
          } else {
            console.log(`📁 Folder ${selectedItem.name}: no contents found (empty folder)`);
          }
        } else if (selectedItem?.type === "file") {
          // Include individual files
          allFileIds.push(selectedId);
        }
      }

      return { folderFiles, allFileIds };
    },
    [getFolderContents, getFolderPathFromFileName, getAllDescendantFileIds, queryClient]
  );

  // OPTIMISTIC KB CREATION WITH FOLDER SUPPORT
  const createKBMutation = useMutation({
    mutationKey: ["createKB"],
    mutationFn: async ({ resourceIds, files }: { resourceIds: string[]; files: FileItem[] }) => {
      const deduplicatedIds = deduplicateResourceIds(resourceIds, files);

      const kbData = {
        name: `Knowledge Base ${new Date().toLocaleString()}`,
        description: "Created from Google Drive files",
        resource_ids: deduplicatedIds,
      };

      console.log("Creating KB with data:", kbData);
      const kb = await createKnowledgeBase(kbData);

      console.log("KB created, triggering sync:", kb.id);
      await syncKnowledgeBase(kb.id);
      console.log("✅ Sync API call completed successfully");

      return { kb, resourceIds: deduplicatedIds, files };
    },
    onMutate: async ({ resourceIds, files }) => {
      console.log("🚀 OPTIMISTIC KB CREATION START");
      
      // 1. Set sync state to pending
      const tempKbId = `temp-${Date.now()}`;
      setSyncPending(tempKbId);
      
      // 2. IMMEDIATELY create fake KB for UI state
      const optimisticKB = {
        id: tempKbId,
        name: `Knowledge Base ${new Date().toLocaleString()}`,
        created_at: new Date().toISOString(),
        is_empty: false,
      };
      
      // 3. IMMEDIATELY update component state (hasKB becomes true)
      setCurrentKB(optimisticKB);
      
      // 4. Find all files within selected folders (for recursive indexing)
      const { folderFiles, allFileIds } = await findAllFilesInSelectedFolders(resourceIds, files);
      console.log(`📊 KB Creation Summary: ${resourceIds.length} selected, ${allFileIds.length} total files (including folder contents)`);
      
      // 5. IMMEDIATELY update KB resources cache with "indexed" root files
      const rootFiles = resourceIds.filter(id => {
        const item = files.find(f => f.id === id);
        return item?.type === "file" || (item?.type === "directory" && (item.level || 0) === 0);
      });
      
      const optimisticKBResources = rootFiles.map(id => {
        const file = files.find(f => f.id === id);
        return {
          id,
          name: file?.name || "",
          type: file?.type || "file" as const,
          size: file?.size || 0,
          status: "indexed" as const, // Show as indexed immediately
          indexed_at: new Date().toISOString()
        };
      });
      
      updateKBResourcesCache(optimisticKB.id, () => ({ 
        data: optimisticKBResources 
      }));
      
      // 6. IMMEDIATELY set optimistic status for all files within selected folders
      folderFiles.forEach(({ folderId, folderPath, fileIds }) => {
        setFolderContentsAsIndexed(optimisticKB.id, folderPath, fileIds, files);
        console.log(`✅ Set ${fileIds.length} files as indexed in folder: ${folderPath}`);
      });
      
      console.log("✅ Optimistic KB created with folder support, UI should show 'Delete' mode immediately");
      
      return { 
        optimisticKB,
        resourceIds,
        previousKB: currentKB,
        folderFiles,
        allFileIds
      };
    },
    onSuccess: ({ kb, resourceIds }, variables, context) => {
      console.log("🎉 REAL KB CREATION SUCCESS");
      
      // Update sync state to synced with the real KB ID
      setSyncCompleted(kb.id);
      console.log("🔄 Sync state updated to 'synced' after API completion");
      
      // Update any queued delete requests from temp KB ID to real KB ID
      if (context?.optimisticKB) {
        updateQueueKBId(context.optimisticKB.id, kb.id);
      }
      
      // Replace optimistic KB with real KB
      setCurrentKB(kb);
      
      // Save real KB to localStorage
      saveKBToStorage({
        id: kb.id,
        name: kb.name,
        created_at: kb.created_at,
      });
      
      // Transfer optimistic caches from temp ID to real KB ID
      if (context?.optimisticKB) {
        // Transfer root KB cache
        const optimisticRootData = queryClient.getQueryData(["kb-resources", context.optimisticKB.id]);
        if (optimisticRootData) {
          queryClient.setQueryData(["kb-resources", kb.id], optimisticRootData);
          console.log("✅ Transferred optimistic root cache to real KB ID");
        }
        
        // Transfer folder status caches
        if (context.folderFiles) {
          context.folderFiles.forEach(({ folderPath }) => {
            const optimisticFolderData = queryClient.getQueryData(["kb-file-status", context.optimisticKB.id, folderPath]);
            if (optimisticFolderData) {
              queryClient.setQueryData(["kb-file-status", kb.id, folderPath], optimisticFolderData);
              console.log(`✅ Transferred optimistic folder cache for: ${folderPath}`);
            }
          });
        }
        
        // Clean up temporary caches
        queryClient.removeQueries({ queryKey: ["kb-resources", context.optimisticKB.id] });
        queryClient.removeQueries({ 
          predicate: (query) => {
            const [type, kbId] = query.queryKey;
            return type === "kb-file-status" && kbId === context.optimisticKB.id;
          }
        });
      }
      
      console.log("✅ Real KB set, optimistic status maintained until polling overrides");
      
      // Persist cache to localStorage after KB creation
      persistCacheToStorage(kb.id);
      
      toast.success("Knowledge base created successfully!", {
        autoClose: 3000,
        toastId: 'kb-creation-success'
      });
    },
    onError: (error, variables, context) => {
      console.error("❌ KB CREATION FAILED:", error);
      
      // Reset sync state
      resetSyncState();
      
      // Revert everything
      if (context?.previousKB) {
        setCurrentKB(context.previousKB);
      } else {
        setCurrentKB(null);
      }
      
      // Remove optimistic caches
      if (context?.optimisticKB) {
        queryClient.removeQueries({ queryKey: ["kb-resources", context.optimisticKB.id] });
        queryClient.removeQueries({ 
          predicate: (query) => {
            const [type, kbId] = query.queryKey;
            return type === "kb-file-status" && kbId === context.optimisticKB.id;
          }
        });
      }
      
      toast.error("Failed to create knowledge base. Please try again.", {
        autoClose: 5000,
        toastId: 'kb-creation-error'
      });
    },
  });

  // OPTIMISTIC FILE DELETION WITH QUEUE
  const deleteFilesMutation = useMutation({
    mutationKey: ["deleteFiles"],
    mutationFn: async ({ fileIds, files }: { fileIds: string[]; files: FileItem[] }) => {
      if (!currentKB?.id) throw new Error("No KB ID");
      
      // If sync is pending, this will be handled by the queue
      if (isSyncPending) {
        throw new Error("Sync is pending - delete should be queued");
      }
      
      // Direct deletion for when sync is complete
      const deletePromises = fileIds.map(async (fileId) => {
        const file = files.find(f => f.id === fileId);  
        if (!file) return;
        
        const resourcePath = `/${file.name}`;
        return deleteKBResource(currentKB.id, resourcePath);
      });

      await Promise.all(deletePromises);
      return { fileIds };
    },
    onSuccess: ({ fileIds }, variables, context) => {
      console.log("🎉 DIRECT FILE DELETION SUCCESS");
      
      // Remove files from optimistic delete registry since they're actually deleted
      fileIds.forEach(fileId => {
        // Note: Don't remove from registry here as the files are already 
        // removed from cache optimistically. The registry entry will be 
        // cleaned up when the cache update happens.
      });
      
      // Persist cache after successful deletion
      if (currentKB?.id) {
        persistCacheToStorage(currentKB.id);
      }
      
      toast.success(`Successfully deleted ${fileIds.length} file(s)`, {
        autoClose: 3000,
        toastId: 'file-deletion-success'
      });
    },
    onError: (error, variables, context) => {
      console.error("❌ DIRECT FILE DELETION FAILED:", error);
      
      toast.error("Failed to delete files. Please try again.", {
        autoClose: 5000,
        toastId: 'file-deletion-error'
      });
    },
  });

  // Public functions
  const createKnowledgeBaseWithFiles = useCallback(
    (resourceIds: string[], files: FileItem[]) => {
      if (resourceIds.length === 0) {
        console.warn("No files selected for KB creation");
        return;
      }

      console.log(`🚀 Starting optimistic KB creation with ${resourceIds.length} files`);
      createKBMutation.mutate({ resourceIds, files });
    },
    [createKBMutation]
  );

  const deleteSelectedFiles = useCallback(
    (selectedIds: string[], files: FileItem[]) => {
      if (!currentKB?.id) {
        console.warn("No KB ID available for deletion");
        return;
      }

      console.log(`🗑️ Starting optimistic file deletion: ${selectedIds.length} files`);

      // 1. IMMEDIATELY mark files as deleted in registry (locks their status)
      selectedIds.forEach(fileId => {
        const file = files.find(f => f.id === fileId);
        if (file) {
          markFileAsDeleted(fileId, file.name, currentKB.id);
        }
      });

      // 2. IMMEDIATELY remove from KB resources cache (shows as "-" in UI)
      const kbQueryKey = ["kb-resources", currentKB.id];
      const currentKBData = queryClient.getQueryData<{ data: FileItem[] }>(kbQueryKey);
      
      if (currentKBData?.data) {
        const filteredData = {
          ...currentKBData,
          data: currentKBData.data.filter(resource => !selectedIds.includes(resource.id))
        };
        
        queryClient.setQueryData(kbQueryKey, filteredData);
        console.log("✅ Files immediately removed from KB cache, UI should show '-' status");
      }

      // 3. Handle deletion based on sync state
      if (isSyncPending) {
        // Queue the deletions for later processing
        console.log("🕒 Sync is pending, queueing delete requests");
        selectedIds.forEach(fileId => {
          const file = files.find(f => f.id === fileId);
          if (file) {
            queueDeleteRequest(fileId, file.name, currentKB.id);
          }
        });
        
        toast.info(
          `Queued ${selectedIds.length} file(s) for deletion. They will be processed when sync completes.`,
          {
            autoClose: 4000,
            toastId: 'files-queued-for-deletion'
          }
        );
      } else {
        // Execute deletion immediately
        console.log("✅ Sync is complete, executing delete immediately");
        deleteFilesMutation.mutate({ fileIds: selectedIds, files });
      }
    },
    [
      currentKB?.id, 
      isSyncPending, 
      markFileAsDeleted, 
      queueDeleteRequest, 
      deleteFilesMutation, 
      queryClient
    ]
  );

  const createNewKB = useCallback(() => {
    console.log("🔄 Creating new KB - clearing ALL state and cache");
    
    // 1. Use comprehensive cleanup from DataManager (this handles everything)
    clearAllState();
    
    // 2. Clear KB from localStorage  
    clearKBFromStorage();
    
    // 3. Clear ALL React Query caches to ensure clean state
    queryClient.clear();
    console.log("🗑️ Cleared all React Query caches");
    
    // 4. Reset component state
    setCurrentKB(null);
    
    // 5. Force page reload to ensure completely clean state
    console.log("🔄 Reloading page for clean state");
    window.location.reload();
  }, [clearAllState, queryClient]);

  return {
    currentKB,
    hasKB,
    isCreating: createKBMutation.isPending,
    createKnowledgeBaseWithFiles,
    createNewKB,
    statusMap, // Use original status map since resolveFileStatus handles optimistic overrides
    statusCounts,
    allFilesSettled,
    isPolling,
    // Deletion functions
    isDeleting: deleteFilesMutation.isPending,
    isActuallyDeleting, // From useKnowledgeBaseDeletion - tracks actual API calls
    deleteSelectedFiles,
    isFileDeleting,
    canDeleteFile,
    canDeleteFolder,
    // New sync and queue state
    syncState,
    isSyncPending,
    isSyncCompleted,
    queue,
    queueProcessing,
    queueCount,
    queueHasItems,
  };
}
