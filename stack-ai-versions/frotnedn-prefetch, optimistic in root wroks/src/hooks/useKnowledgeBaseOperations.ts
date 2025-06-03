import { useState, useCallback, useMemo, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createKnowledgeBase, syncKnowledgeBase, deleteKBResource } from "@/lib/api/knowledgeBase";
import { saveKBToStorage, getKBFromStorage, clearKBFromStorage } from "@/lib/utils/localStorage";
import { deduplicateResourceIds } from "@/lib/utils/resourceDeduplication";
import { useKnowledgeBaseStatus } from "./useKnowledgeBaseStatus";
import { useKnowledgeBaseDeletion } from "./useKnowledgeBaseDeletion";
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

      return { kb, resourceIds: deduplicatedIds, files };
    },
    onMutate: async ({ resourceIds, files }) => {
      console.log("🚀 OPTIMISTIC KB CREATION START");
      
      // 1. IMMEDIATELY create fake KB for UI state
      const optimisticKB = {
        id: `temp-${Date.now()}`, // Temporary ID
        name: `Knowledge Base ${new Date().toLocaleString()}`,
        created_at: new Date().toISOString(),
        is_empty: false,
      };
      
      // 2. IMMEDIATELY update component state (hasKB becomes true)
      setCurrentKB(optimisticKB);
      
      // 3. IMMEDIATELY update KB resources cache with "indexed" files
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

  // OPTIMISTIC FILE DELETION
  const deleteFilesMutation = useMutation({
    mutationKey: ["deleteFiles"],
    mutationFn: async ({ fileIds, files }: { fileIds: string[]; files: FileItem[] }) => {
      if (!currentKB?.id) throw new Error("No KB ID");
      
      const deletePromises = fileIds.map(async (fileId) => {
        const file = files.find(f => f.id === fileId);  
        if (!file) return;
        
        const resourcePath = `/${file.name}`;
        return deleteKBResource(currentKB.id, resourcePath);
      });

      await Promise.all(deletePromises);
      return { fileIds };
    },
    onMutate: async ({ fileIds }) => {
      console.log("🗑️ OPTIMISTIC FILE DELETION START");
      
      if (!currentKB?.id) return;
      
      // Cancel ongoing queries
      await queryClient.cancelQueries({ queryKey: ["kb-resources", currentKB.id] });
      
      // Get current KB resources
      const currentKBData = queryClient.getQueryData<{ data: FileItem[] }>(["kb-resources", currentKB.id]);
      
      // IMMEDIATELY remove files from KB resources cache
      if (currentKBData?.data) {
        const filteredData = {
          ...currentKBData,
          data: currentKBData.data.filter(resource => !fileIds.includes(resource.id))
        };
        
        queryClient.setQueryData(["kb-resources", currentKB.id], filteredData);
        console.log("✅ Files immediately removed from KB cache, UI should show '-' status");
      }
      
      return { 
        previousKBData: currentKBData,
        fileIds,
        kbId: currentKB.id 
      };
    },
    onSuccess: ({ fileIds }, variables, context) => {
      console.log("🎉 FILE DELETION SUCCESS");
      
      // Ensure the cache update triggers re-render for selection validation
      // The auto-deselect effect in useFileSelection should handle clearing selections
      console.log(`Files deleted successfully: ${fileIds.join(', ')}`);
      
      toast.success(`Successfully deleted ${fileIds.length} file(s)`, {
        autoClose: 3000,
        toastId: 'file-deletion-success'
      });
    },
    onError: (error, variables, context) => {
      console.error("❌ FILE DELETION FAILED:", error);
      
      // Revert KB resources cache
      if (context?.previousKBData && context?.kbId) {
        queryClient.setQueryData(["kb-resources", context.kbId], context.previousKBData);
      }
      
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
      deleteFilesMutation.mutate({ fileIds: selectedIds, files });
    },
    [currentKB?.id, deleteFilesMutation]
  );

  const createNewKB = useCallback(() => {
    console.log("Creating new KB - clearing storage and reloading");
    clearKBFromStorage();
    window.location.reload();
  }, []);

  // Track mutation states
  const isCreating = createKBMutation.isPending;
  const isDeleting = false; // No delete loader - always optimistic

  return {
    currentKB,
    hasKB,
    isCreating,
    createKnowledgeBaseWithFiles,
    createNewKB,
    statusMap,
    statusCounts,
    allFilesSettled,
    isPolling,
    shouldPoll,
    // Deletion functions
    isDeleting,
    deleteSelectedFiles,
    isFileDeleting,
    canDeleteFile,
    canDeleteFolder,
    isError: createKBMutation.isError || deleteFilesMutation.isError,
    error: createKBMutation.error || deleteFilesMutation.error,
  };
}
