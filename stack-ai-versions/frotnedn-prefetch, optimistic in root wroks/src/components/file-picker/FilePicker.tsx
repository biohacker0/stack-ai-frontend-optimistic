"use client";

import { useFileTree } from "@/hooks/useFileTree";
import { useKnowledgeBaseOperations } from "@/hooks/useKnowledgeBaseOperations";
import { FilePickerTable } from "./FilePickerTable";

// FilePicker with optimistic UI updates
// - KB creation: Shows files as "indexed" immediately, no loaders
// - File deletion: Shows files as "-" immediately, no loaders  
// - Background API calls happen seamlessly
export function FilePicker() {
  const {
    currentKB,
    hasKB,
    isCreating,
    createKnowledgeBaseWithFiles,
    createNewKB,
    statusMap,
    statusCounts,
    allFilesSettled,
    isPolling,
    // Deletion functions
    isDeleting,
    deleteSelectedFiles,
    isFileDeleting,
    canDeleteFile,
    canDeleteFolder,
    // New sync and queue state
    syncState,
    isSyncPending,
    isSyncCompleted,
    queueStats,
  } = useKnowledgeBaseOperations();

  const { files, isLoading, error, toggleFolder, collapseAllFolders, startPrefetch, stopPrefetch, registerFolder, isPrefetching } = useFileTree({
    kbId: currentKB?.id || null,
    statusMap,
    isCreatingKB: isCreating,
  });

  // Show error if any
  if (error) {
    return (
      <div className="p-6">
        <h2 className="text-xl text-red-600">Error loading files</h2>
        <pre className="mt-2">{JSON.stringify(error, null, 2)}</pre>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col">
      <div className="flex-shrink-0 p-4 pb-2">
        <h1 className="text-2xl font-bold mb-2">Google Drive File Picker</h1>
        
        {/* Sync State Indicator */}
        {hasKB && (
          <div className="mb-2 flex items-center space-x-4 text-sm">
            <div className="flex items-center space-x-2">
              <span className="font-medium">Sync Status:</span>
              {isSyncPending && (
                <span className="text-yellow-600 flex items-center">
                  <span className="animate-spin mr-1">⟳</span>
                  Syncing...
                </span>
              )}
              {isSyncCompleted && (
                <span className="text-green-600 flex items-center">
                  ✓ Synced
                </span>
              )}
              {syncState === "idle" && (
                <span className="text-gray-500">Idle</span>
              )}
            </div>
            
            {/* Queue Status */}
            {queueStats.hasItems && (
              <div className="flex items-center space-x-2">
                <span className="font-medium">Delete Queue:</span>
                <span className="text-blue-600">
                  {queueStats.count} file(s) queued
                  {queueStats.processing && " (processing...)"}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 p-4">
        <FilePickerTable
          files={files}
          isLoading={isLoading}
          toggleFolder={toggleFolder}
          onCreateKB={(resourceIds, files) => {
            createKnowledgeBaseWithFiles(resourceIds, files);
            setTimeout(() => collapseAllFolders(), 100);
          }}
          onCreateNewKB={createNewKB}
          onDeleteFiles={(selectedIds) => {
            deleteSelectedFiles(selectedIds, files);
            setTimeout(() => collapseAllFolders(), 100);
          }}
          hasKB={hasKB}
          isCreatingKB={isCreating}
          isDeletingKB={isDeleting}
          statusMap={statusMap}
          canDeleteFile={canDeleteFile}
          canDeleteFolder={(folder) => canDeleteFolder(folder, files)}
          isFileDeleting={isFileDeleting}
          // Prefetch functions
          startPrefetch={startPrefetch}
          stopPrefetch={stopPrefetch}
          registerFolder={registerFolder}
          isPrefetching={isPrefetching}
        />
      </div>
    </div>
  );
}
