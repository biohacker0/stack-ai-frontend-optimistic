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
 * 5. Cache Operations
 */

// State Keys
const SYNC_STATE_KEY = ["sync-state"];
const DELETE_QUEUE_KEY = ["delete-queue"];
const OPTIMISTIC_DELETE_REGISTRY_KEY = ["optimistic-delete-registry"];

// Types
export type SyncState = "idle" | "pending" | "synced";

interface SyncStateData {
  state: SyncState;
  kbId: string | null;
  lastUpdated: number;
}

interface DeleteRequest {
  id: string;
  fileId: string;
  fileName: string;
  resourcePath: string;
  kbId: string;
  timestamp: number;
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

  // ==================== FILE STATUS RESOLUTION ====================
  
  /**
   * File Status Precedence (highest to lowest):
   * 1. Optimistic Delete Registry (locked as "-")
   * 2. KB Resources Cache (from network)
   * 3. Default (undefined)
   */
  const resolveFileStatus = useCallback(
    (fileId: string, kbId: string | null): FileItem["status"] | "-" | null => {
      // 1. Check optimistic delete registry (highest priority)
      if (fileId in registryData.entries) {
        return "-"; // Show as deleted
      }

      // 2. Check KB resources cache (network data)
      if (kbId) {
        const kbResources = queryClient.getQueryData<{ data: FileItem[] }>(["kb-resources", kbId]);
        const resource = kbResources?.data?.find(r => r.id === fileId);
        if (resource) {
          // Apply optimistic UI: show "pending" as "indexed"
          return resource.status === "pending" ? "indexed" : resource.status;
        }
      }

      // 3. Default (file not in KB or no data)
      return null;
    },
    [registryData.entries, queryClient]
  );

  // ==================== CACHE OPERATIONS ====================
  
  const updateKBResourcesCache = useCallback(
    (kbId: string, updater: (prev: { data: FileItem[] } | undefined) => { data: FileItem[] }) => {
      const cacheKey = ["kb-resources", kbId];
      const currentData = queryClient.getQueryData<{ data: FileItem[] }>(cacheKey);
      const newData = updater(currentData);
      queryClient.setQueryData(cacheKey, newData);
      console.log(`📝 [DataManager] Updated KB cache: ${kbId}`);
    },
    [queryClient]
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

  // ==================== COMPUTED VALUES ====================
  
  const computedValues = useMemo(() => {
    const { state: syncState, kbId: syncKbId } = syncStateData;
    const { queue, processing } = queueData;
    const { entries } = registryData;

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
    };
  }, [syncStateData, queueData, registryData]);

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

    // Cache operations
    updateKBResourcesCache,
    removeFromKBResourcesCache,

    // Status resolution
    resolveFileStatus,

    // Utility
    clearAllState: () => {
      updateSyncState("idle", null);
      updateQueueData(() => ({ queue: [], processing: false, lastUpdated: Date.now() }));
      updateRegistryData(() => ({ entries: {}, lastUpdated: Date.now() }));
      console.log("🧹 [DataManager] All state cleared");
    },
  };
} 