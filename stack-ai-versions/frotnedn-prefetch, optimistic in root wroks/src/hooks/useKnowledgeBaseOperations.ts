import { useState, useCallback, useMemo, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createKnowledgeBase, syncKnowledgeBase, deleteKBResource } from "@/lib/api/knowledgeBase";
import { saveKBToStorage, getKBFromStorage, clearKBFromStorage } from "@/lib/utils/localStorage";
import { deduplicateResourceIds } from "@/lib/utils/resourceDeduplication";
import { useKnowledgeBaseStatus } from "./useKnowledgeBaseStatus";
import { useKnowledgeBaseDeletion } from "./useKnowledgeBaseDeletion";
import { useSyncState } from "./useSyncState";
import { useDeleteQueue } from "./useDeleteQueue";
import { useOptimisticDeleteRegistry } from "./useOptimisticDeleteRegistry";
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

  const hasKB = currentKB !== null;

  // Sync state management
  const {
    syncState,
    isPending: isSyncPending,
    isSynced: isSyncCompleted,
    resetSyncState,
    setSyncPending,
    setSyncCompleted,
    setSyncState,
  } = useSyncState();

  // Delete queue management
  const {
    queueStats,
    queueDeleteRequest,
    processQueue,
    clearQueue,
    updateQueueKBId,
  } = useDeleteQueue();

  // Optimistic delete registry
  const {
    markFileAsDeleted,
    clearRegistry,
    getFileStatusOverride,
  } = useOptimisticDeleteRegistry();

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
  const { isFileDeleting, canDeleteFile, canDeleteFolder } = useKnowledgeBaseDeletion(currentKB?.id || null, statusMap);

  // Process delete queue when sync completes
  useEffect(() => {
    console.log(`🔍 Queue effect triggered: isSyncCompleted=${isSyncCompleted}, hasItems=${queueStats.hasItems}, processing=${queueStats.processing}, kbId=${currentKB?.id}`);
    
    if (isSyncCompleted && queueStats.hasItems && !queueStats.processing) {
      console.log("🔄 Sync completed, processing delete queue");
      processQueue(currentKB?.id || null);
    }
  }, [isSyncCompleted, queueStats.hasItems, queueStats.processing, processQueue, currentKB?.id]);

  // OPTIMISTIC KB CREATION
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
      
      // 4. IMMEDIATELY update KB resources cache with "indexed" files
      const optimisticKBResources = resourceIds.map(id => {
        const file = files.find(f => f.id === id);
        return {
          id,
          name: file?.name || "",
          type: "file" as const,
          status: "indexed" as const, // Show as indexed immediately
          indexed_at: new Date().toISOString()
        };
      });
      
      queryClient.setQueryData(["kb-resources", optimisticKB.id], { 
        data: optimisticKBResources 
      });
      
      console.log("✅ Optimistic KB created, UI should show 'Delete' mode immediately");
      
      return { 
        optimisticKB,
        resourceIds,
        previousKB: currentKB 
      };
    },
    onSuccess: ({ kb, resourceIds }, variables, context) => {
      console.log("🎉 REAL KB CREATION SUCCESS");
      
      // Update sync state to synced with the real KB ID
      setSyncState("synced", kb.id);
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
      
      // Transfer optimistic cache from temp ID to real KB ID to maintain status continuity
      if (context?.optimisticKB) {
        const optimisticData = queryClient.getQueryData(["kb-resources", context.optimisticKB.id]);
        if (optimisticData) {
          queryClient.setQueryData(["kb-resources", kb.id], optimisticData);
          console.log("✅ Transferred optimistic cache to real KB ID");
        }
        
        // Now remove the temporary cache
        queryClient.removeQueries({ queryKey: ["kb-resources", context.optimisticKB.id] });
      }
      
      console.log("✅ Real KB set, optimistic status maintained until polling overrides");
      
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
      
      // Remove optimistic cache
      if (context?.optimisticKB) {
        queryClient.removeQueries({ queryKey: ["kb-resources", context.optimisticKB.id] });
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
    console.log("Creating new KB - clearing all state and reloading");
    
    // Reset all state systems
    resetSyncState();
    clearQueue();
    clearRegistry();
    
    // Clear KB storage
    clearKBFromStorage();
    setCurrentKB(null);
    
    // Force page reload to ensure clean state
    window.location.reload();
  }, [resetSyncState, clearQueue, clearRegistry]);

  // Enhanced status map that respects optimistic deletes
  const enhancedStatusMap = useMemo(() => {
    const enhanced = new Map(statusMap);
    
    // Override status for optimistically deleted files
    statusMap?.forEach((status, fileId) => {
      const override = getFileStatusOverride(fileId);
      if (override) {
        enhanced.set(fileId, override);
      }
    });
    
    return enhanced;
  }, [statusMap, getFileStatusOverride]);

  return {
    currentKB,
    hasKB,
    isCreating: createKBMutation.isPending,
    createKnowledgeBaseWithFiles,
    createNewKB,
    statusMap: enhancedStatusMap, // Use enhanced status map
    statusCounts,
    allFilesSettled,
    isPolling,
    // Deletion functions
    isDeleting: deleteFilesMutation.isPending,
    deleteSelectedFiles,
    isFileDeleting,
    canDeleteFile,
    canDeleteFolder,
    // New sync and queue state
    syncState,
    isSyncPending,
    isSyncCompleted,
    queueStats,
  };
}
