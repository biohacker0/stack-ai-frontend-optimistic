import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { FileItem } from "@/lib/types/file";

/**
 * Centralized Data Manager
 * 
 * This hook provides a single source of truth for all application state:
 * 1. Sync State Management
 * 2. Delete Queue Management  
 * 3. Optimistic Delete Registry
 * 4. File Status Resolution (with clear precedence)
 * 5. Cache Operations (Root + Folder)
 * 6. Folder Operations
 */

// State Keys
const SYNC_STATE_KEY = ["sync-state"];
const DELETE_QUEUE_KEY = ["delete-queue"];
const OPTIMISTIC_DELETE_REGISTRY_KEY = ["optimistic-delete-registry"];
const OPTIMISTIC_UPDATE_COUNTER_KEY = ["optimistic-update-counter"];

// Types
export type SyncState = "idle" | "pending" | "synced";

export interface DeleteRequest {
  id: string;
  fileId: string;
  fileName: string;
  resourcePath: string;
  kbId: string;
  timestamp: number;
}

interface SyncStateData {
  state: SyncState;
  kbId: string | null;
  lastUpdated: number;
}

interface DeleteQueueData {
  queue: DeleteRequest[];
  processing: boolean;
  lastUpdated: number;
}

interface OptimisticDeleteEntry {
  fileId: string;
  fileName: string;
  kbId: string;
  timestamp: number;
  locked: boolean;
}

interface OptimisticDeleteRegistryData {
  entries: Record<string, OptimisticDeleteEntry>;
  lastUpdated: number;
}

export function useDataManager() {
  const queryClient = useQueryClient();

  // ==================== SYNC STATE ====================
  
  const { data: syncStateData } = useQuery({
    queryKey: SYNC_STATE_KEY,
    queryFn: () => ({ state: "idle" as SyncState, kbId: null, lastUpdated: Date.now() }),
    initialData: { state: "idle" as SyncState, kbId: null, lastUpdated: Date.now() },
    staleTime: Infinity,
  });

  const updateSyncState = useCallback(
    (newState: SyncState, kbId: string | null = null) => {
      const currentData = queryClient.getQueryData<SyncStateData>(SYNC_STATE_KEY) || syncStateData;
      const newData: SyncStateData = {
        state: newState,
        kbId: kbId || currentData.kbId,
        lastUpdated: Date.now(),
      };
      
      queryClient.setQueryData(SYNC_STATE_KEY, newData);
      console.log(`🔄 [DataManager] Sync state: ${newState} (KB: ${newData.kbId})`);
    },
    [queryClient, syncStateData]
  );

  // ==================== DELETE QUEUE ====================
  
  const { data: queueData } = useQuery({
    queryKey: DELETE_QUEUE_KEY,
    queryFn: () => ({ queue: [], processing: false, lastUpdated: Date.now() }),
    initialData: { queue: [], processing: false, lastUpdated: Date.now() },
    staleTime: Infinity,
  });

  const updateQueueData = useCallback(
    (updater: (prev: DeleteQueueData) => DeleteQueueData) => {
      const currentData = queryClient.getQueryData<DeleteQueueData>(DELETE_QUEUE_KEY) || queueData;
      const newData = updater(currentData);
      queryClient.setQueryData(DELETE_QUEUE_KEY, newData);
      return newData;
    },
    [queryClient, queueData]
  );

  // ==================== OPTIMISTIC DELETE REGISTRY ====================
  
  const { data: registryData } = useQuery({
    queryKey: OPTIMISTIC_DELETE_REGISTRY_KEY,
    queryFn: () => ({ entries: {}, lastUpdated: Date.now() }),
    initialData: { entries: {}, lastUpdated: Date.now() },
    staleTime: Infinity,
  });

  const updateRegistryData = useCallback(
    (updater: (prev: OptimisticDeleteRegistryData) => OptimisticDeleteRegistryData) => {
      const currentData = queryClient.getQueryData<OptimisticDeleteRegistryData>(OPTIMISTIC_DELETE_REGISTRY_KEY) || registryData;
      const newData = updater(currentData);
      queryClient.setQueryData(OPTIMISTIC_DELETE_REGISTRY_KEY, newData);
      return newData;
    },
    [queryClient, registryData]
  );

  // ==================== OPTIMISTIC UPDATE COUNTER ====================
  
  const { data: optimisticUpdateCounter } = useQuery({
    queryKey: OPTIMISTIC_UPDATE_COUNTER_KEY,
    queryFn: () => ({ count: 0, lastUpdated: Date.now() }),
    initialData: { count: 0, lastUpdated: Date.now() },
    staleTime: Infinity,
  });

  const incrementOptimisticUpdateCounter = useCallback(() => {
    const currentData = queryClient.getQueryData<{ count: number; lastUpdated: number }>(OPTIMISTIC_UPDATE_COUNTER_KEY) || optimisticUpdateCounter;
    const newData = {
      count: currentData.count + 1,
      lastUpdated: Date.now()
    };
    queryClient.setQueryData(OPTIMISTIC_UPDATE_COUNTER_KEY, newData);
    console.log(`🔄 [DataManager] Optimistic update counter incremented: ${newData.count}`);
  }, [queryClient, optimisticUpdateCounter]);

  // ==================== FILE STATUS RESOLUTION ====================
  
  /**
   * File Status Precedence (highest to lowest):
   * 1. Optimistic Delete Registry (locked as "-")
   * 2. KB Resources Cache (root files - from network)
   * 3. Folder Status Cache (folder files - from network) 
   * 4. Default (undefined)
   */
  const resolveFileStatus = useCallback(
    (fileId: string, kbId: string | null, folderPath?: string): FileItem["status"] | "-" | null => {
      // 1. Check optimistic delete registry (highest priority)
      if (fileId in registryData.entries) {
        return "-"; // Show as deleted
      }

      // 2. Check KB resources cache (root files)
      if (kbId) {
        const kbResources = queryClient.getQueryData<{ data: FileItem[] }>(["kb-resources", kbId]);
        const resource = kbResources?.data?.find(r => r.id === fileId);
        if (resource) {
          // Apply optimistic UI: show "pending" as "indexed"
          return resource.status === "pending" ? "indexed" : resource.status;
        }
      }

      // 3. Check folder status cache (folder files)
      if (kbId && folderPath) {
        const folderStatus = queryClient.getQueryData<{ data: FileItem[] }>(["kb-file-status", kbId, folderPath]);
        const folderFile = folderStatus?.data?.find(r => r.id === fileId);
        if (folderFile) {
          // Apply optimistic UI: show "pending" as "indexed"
          return folderFile.status === "pending" ? "indexed" : folderFile.status;
        }
      }

      // 4. Default (file not in KB or no data)
      return null;
    },
    [registryData.entries, queryClient]
  );

  // ==================== CACHE OPERATIONS ====================
  
  // Root KB Resources Cache (for root files)
  const updateKBResourcesCache = useCallback(
    (kbId: string, updater: (prev: { data: FileItem[] } | undefined) => { data: FileItem[] }) => {
      const cacheKey = ["kb-resources", kbId];
      const currentData = queryClient.getQueryData<{ data: FileItem[] }>(cacheKey);
      const newData = updater(currentData);
      queryClient.setQueryData(cacheKey, newData);
      console.log(`📝 [DataManager] Updated KB root cache: ${kbId}`);
      
      // Trigger re-render for optimistic updates
      incrementOptimisticUpdateCounter();
    },
    [queryClient, incrementOptimisticUpdateCounter]
  );

  const removeFromKBResourcesCache = useCallback(
    (kbId: string, fileIds: string[]) => {
      updateKBResourcesCache(kbId, (prev) => {
        if (!prev?.data) return { data: [] };
        return {
          data: prev.data.filter(resource => !fileIds.includes(resource.id))
        };
      });
    },
    [updateKBResourcesCache]
  );

  // Folder File Cache Operations (for Google Drive files)
  const updateFolderFileCache = useCallback(
    (folderId: string, updater: (prev: { data: FileItem[] } | undefined) => { data: FileItem[] }) => {
      const cacheKey = ["drive-files", folderId];
      const currentData = queryClient.getQueryData<{ data: FileItem[] }>(cacheKey);
      const newData = updater(currentData);
      queryClient.setQueryData(cacheKey, newData);
      console.log(`📝 [DataManager] Updated folder file cache: ${folderId}`);
    },
    [queryClient]
  );

  // Folder Status Cache Operations (for KB folder status)
  const updateFolderStatusCache = useCallback(
    (kbId: string, folderPath: string, updater: (prev: { data: FileItem[] } | undefined) => { data: FileItem[] }) => {
      const cacheKey = ["kb-file-status", kbId, folderPath];
      const currentData = queryClient.getQueryData<{ data: FileItem[] }>(cacheKey);
      const newData = updater(currentData);
      queryClient.setQueryData(cacheKey, newData);
      console.log(`📝 [DataManager] Updated folder status cache: ${kbId}${folderPath}`);
    },
    [queryClient]
  );

  const removeFromFolderStatusCache = useCallback(
    (kbId: string, folderPath: string, fileIds: string[]) => {
      updateFolderStatusCache(kbId, folderPath, (prev) => {
        if (!prev?.data) return { data: [] };
        return {
          data: prev.data.filter(resource => !fileIds.includes(resource.id))
        };
      });
    },
    [updateFolderStatusCache]
  );

  // Set optimistic "indexed" status for folder contents
  const setFolderContentsAsIndexed = useCallback(
    (kbId: string, folderPath: string, fileIds: string[], files: FileItem[]) => {
      const optimisticFiles = fileIds.map(fileId => {
        const file = files.find(f => f.id === fileId);
        return {
          id: fileId,
          name: file?.name || "",
          type: file?.type || "file" as const,
          size: file?.size || 0,
          status: "indexed" as const,
          indexed_at: new Date().toISOString()
        };
      }).filter(f => f.type === "file"); // Only files have status

      updateFolderStatusCache(kbId, folderPath, () => ({ data: optimisticFiles }));
      console.log(`✅ [DataManager] Set ${optimisticFiles.length} files as indexed in folder ${folderPath}`);
      
      // Trigger re-render for expanded folders
      incrementOptimisticUpdateCounter();
    },
    [updateFolderStatusCache, incrementOptimisticUpdateCounter]
  );

  // ==================== FOLDER HELPER FUNCTIONS ====================
  
  // Extract folder path from file name (same logic as useFileTree)
  const getFolderPathFromFileName = useCallback((fileName: string): string => {
    const pathParts = fileName.split("/");
    pathParts.pop(); // Remove filename
    return "/" + pathParts.join("/");
  }, []);

  // Get all files in a folder from the file cache
  const getFolderContents = useCallback((folderId: string): FileItem[] => {
    const folderData = queryClient.getQueryData<{ data: FileItem[] }>(["drive-files", folderId]);
    return folderData?.data || [];
  }, [queryClient]);

  // Find all descendant file IDs recursively
  const getAllDescendantFileIds = useCallback(
    (parentFiles: FileItem[], allFiles: FileItem[]): string[] => {
      const descendants: string[] = [];
      
      const processFiles = (files: FileItem[]) => {
        files.forEach(file => {
          if (file.type === "file") {
            descendants.push(file.id);
          } else if (file.type === "directory") {
            // Find files in this directory
            const childFiles = allFiles.filter(f => 
              f.name.startsWith(file.name + "/") && 
              f.name.split("/").length === file.name.split("/").length + 1
            );
            processFiles(childFiles);
          }
        });
      };
      
      processFiles(parentFiles);
      return descendants;
    },
    []
  );

  // ==================== COMPUTED VALUES ====================
  
  const computedValues = useMemo(() => {
    const { state: syncState, kbId: syncKbId } = syncStateData;
    const { queue, processing } = queueData;
    const { entries } = registryData;
    const { count: optimisticUpdateCount } = optimisticUpdateCounter;

    return {
      // Sync state
      syncState,
      syncKbId,
      isSyncPending: syncState === "pending",
      isSyncCompleted: syncState === "synced",
      isSyncIdle: syncState === "idle",

      // Queue state
      queue,
      queueProcessing: processing,
      queueCount: queue.length,
      queueHasItems: queue.length > 0,

      // Registry state
      optimisticDeleteEntries: entries,
      optimisticDeleteCount: Object.keys(entries).length,
      
      // Optimistic update tracking
      optimisticUpdateCount,
    };
  }, [syncStateData, queueData, registryData, optimisticUpdateCounter]);

  // ==================== PUBLIC API ====================
  
  return {
    // State access
    ...computedValues,

    // Sync operations
    setSyncPending: (kbId: string) => updateSyncState("pending", kbId),
    setSyncCompleted: (kbId: string) => updateSyncState("synced", kbId),
    resetSyncState: () => updateSyncState("idle", null),

    // Queue operations
    queueDeleteRequest: (fileId: string, fileName: string, kbId: string) => {
      const deleteRequest: DeleteRequest = {
        id: `delete-${fileId}-${Date.now()}`,
        fileId,
        fileName,
        resourcePath: `/${fileName}`,
        kbId,
        timestamp: Date.now(),
      };

      updateQueueData((prev) => ({
        ...prev,
        queue: [...prev.queue, deleteRequest],
        lastUpdated: Date.now(),
      }));

      console.log(`📝 [DataManager] Queued: ${fileName}`);
      return deleteRequest.id;
    },

    removeFromQueue: (requestId: string) => {
      updateQueueData((prev) => ({
        ...prev,
        queue: prev.queue.filter(req => req.id !== requestId),
        lastUpdated: Date.now(),
      }));
    },

    updateQueueKBId: (oldKbId: string, newKbId: string) => {
      updateQueueData((prev) => ({
        ...prev,
        queue: prev.queue.map(request => 
          request.kbId === oldKbId 
            ? { ...request, kbId: newKbId }
            : request
        ),
        lastUpdated: Date.now(),
      }));
      console.log(`🔄 [DataManager] Updated queue KB ID: ${oldKbId} → ${newKbId}`);
    },

    setQueueProcessing: (processing: boolean) => {
      updateQueueData((prev) => ({
        ...prev,
        processing,
        lastUpdated: Date.now(),
      }));
    },

    clearQueue: () => {
      updateQueueData(() => ({
        queue: [],
        processing: false,
        lastUpdated: Date.now(),
      }));
      console.log("🧹 [DataManager] Queue cleared");
    },

    // Registry operations
    markFileAsDeleted: (fileId: string, fileName: string, kbId: string) => {
      const entry: OptimisticDeleteEntry = {
        fileId,
        fileName,
        kbId,
        timestamp: Date.now(),
        locked: true,
      };

      updateRegistryData((prev) => ({
        ...prev,
        entries: { ...prev.entries, [fileId]: entry },
        lastUpdated: Date.now(),
      }));

      console.log(`🔒 [DataManager] Marked as deleted: ${fileName}`);
      
      // Trigger re-render for optimistic deletes
      incrementOptimisticUpdateCounter();
    },

    removeFromRegistry: (fileId: string) => {
      updateRegistryData((prev) => {
        const newEntries = { ...prev.entries };
        delete newEntries[fileId];
        return {
          ...prev,
          entries: newEntries,
          lastUpdated: Date.now(),
        };
      });
    },

    clearRegistry: () => {
      updateRegistryData(() => ({
        entries: {},
        lastUpdated: Date.now(),
      }));
      console.log("🧹 [DataManager] Registry cleared");
    },

    // Root cache operations (existing)
    updateKBResourcesCache,
    removeFromKBResourcesCache,

    // Folder cache operations (new)
    updateFolderFileCache,
    updateFolderStatusCache,
    removeFromFolderStatusCache,
    setFolderContentsAsIndexed,

    // Status resolution
    resolveFileStatus,

    // Folder helpers
    getFolderPathFromFileName,
    getFolderContents,
    getAllDescendantFileIds,

    // Utility
    clearAllState: () => {
      updateSyncState("idle", null);
      updateQueueData(() => ({ queue: [], processing: false, lastUpdated: Date.now() }));
      updateRegistryData(() => ({ entries: {}, lastUpdated: Date.now() }));
      console.log("🧹 [DataManager] All state cleared");
    },
  };
} 