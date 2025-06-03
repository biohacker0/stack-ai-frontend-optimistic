import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useMemo } from "react";
import { listKBResources } from "@/lib/api/knowledgeBase";
import { FileItem } from "@/lib/types/file";
import { toast } from 'react-toastify';

interface UseKnowledgeBaseStatusProps {
  kbId: string | null;
  enabled?: boolean;
}

// Constants
const POLL_INTERVAL = 1000; // 1 second for faster updates
const MAX_POLL_DURATION = 2 * 60 * 1000; // 2 minutes

export function useKnowledgeBaseStatus({ kbId, enabled = true }: UseKnowledgeBaseStatusProps) {
  const [shouldPoll, setShouldPoll] = useState(true);
  const [pollingStartTime] = useState(Date.now());
  const [hasShownErrorToast, setHasShownErrorToast] = useState(false);

  // Don't poll for temporary/optimistic KB IDs
  const isTemporaryKB = kbId?.startsWith('temp-') || false;
  const shouldEnablePolling = enabled && !!kbId && !isTemporaryKB && shouldPoll;

  // Poll KB resources
  const {
    data: kbResources,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["kb-resources", kbId],
    queryFn: () => listKBResources(kbId!),
    enabled: shouldEnablePolling,
    refetchInterval: shouldEnablePolling ? POLL_INTERVAL : false,
    refetchIntervalInBackground: true,
    staleTime: 0, // Always consider data stale for polling
  });

  // Determine if polling should continue
  useEffect(() => {
    if (!enabled || !kbId) return;

    // If we have no data yet, keep polling
    if (!kbResources?.data) return;

    const resources = kbResources.data;

    // Check polling timeout first
    const pollingDuration = Date.now() - pollingStartTime;
    if (pollingDuration > MAX_POLL_DURATION) {
      console.log("Polling timeout reached, stopping polling");
      setShouldPoll(false);
      return;
    }

    // If empty KB (data is empty array), this means all files are deleted or not indexed
    // We should stop polling in this case
    if (resources.length === 0) {
      console.log("Empty KB resources, stopping polling");
      setShouldPoll(false);
      return;
    }

    // Filter only files (directories are always "unknown")
    const files = resources.filter((item) => item.type === "file");

    // If no files in KB, stop polling
    if (files.length === 0) {
      console.log("No files in KB, stopping polling");
      setShouldPoll(false);
      return;
    }

    // Check for unsettled files (pending or pending_delete)
    const pendingFiles = files.filter((file) => file.status === "pending");
    const pendingDeleteFiles = files.filter((file) => file.status === "pending_delete");
    const errorFiles = files.filter((file) => file.status === "error");
    const indexedFiles = files.filter((file) => file.status === "indexed");

    console.log(`Polling status: ${pendingFiles.length} pending, ${pendingDeleteFiles.length} pending_delete, ${errorFiles.length} error, ${indexedFiles.length} indexed`);

    // Show error toast if not already shown
    if (errorFiles.length > 0 && !hasShownErrorToast) {
      setHasShownErrorToast(true);
      toast.error(
        `Failed to index ${errorFiles.length} file(s). The knowledge base may be corrupted. Please create a new knowledge base.`,
        {
          autoClose: 8000,
          toastId: 'kb-error-toast' // Prevent duplicate toasts
        }
      );
    }

    // Continue polling if there are any unsettled files
    const hasUnsettledFiles = pendingFiles.length > 0 || pendingDeleteFiles.length > 0;
    
    if (!hasUnsettledFiles) {
      console.log("All files settled, stopping polling");
      setShouldPoll(false);
      return;
    }

    // Continue polling
    console.log("Files still pending, continuing polling...");
  }, [kbResources, pollingStartTime, hasShownErrorToast, enabled, kbId]);

  // Reset polling when KB changes
  useEffect(() => {
    if (kbId) {
      setShouldPoll(true);
      setHasShownErrorToast(false);
    }
  }, [kbId]);

  // Build status map for quick lookups
  // IMPORTANT: Only include files that are actually in the KB
  // Files not in this map will fall back to their default status (which should be "-" for deleted files)
  // OPTIMISTIC UI: Treat "pending" as "indexed" so users see instant feedback
  const statusMap = useMemo(() => {
    const map = new Map<string, string>();
    
    if (kbResources?.data) {
      console.log(`Building status map from ${kbResources.data.length} KB resources`);
      console.log('KB Resources:', kbResources.data.map(r => ({ id: r.id, name: r.name, status: r.status })));
      
      kbResources.data.forEach((resource) => {
        let displayStatus = resource.status || "unknown";
        
        // OPTIMISTIC UI: Show "pending" as "indexed" to match optimistic updates
        // Only revert to error if it actually fails
        if (displayStatus === "pending") {
          displayStatus = "indexed";
          console.log(`Status map (optimistic): ${resource.id} (${resource.name}) -> pending -> indexed`);
        } else {
          console.log(`Status map: ${resource.id} (${resource.name}) -> ${displayStatus}`);
        }
        
        map.set(resource.id, displayStatus);
      });
    } else {
      console.log('No KB resources data available for status map');
    }
    
    console.log(`Final status map has ${map.size} entries`);
    return map;
  }, [kbResources?.data]);

  // Calculate if all files are settled (including error status)
  const allFilesSettled = useMemo(() => {
    if (!kbResources?.data) return false;

    const files = kbResources.data.filter((item) => item.type === "file");
    if (files.length === 0) return true; // No files means settled

    return files.every((file) => 
      file.status === "indexed" || 
      file.status === "error"
      // Note: we don't include pending_delete here because that means deletion is in progress
    );
  }, [kbResources?.data]);

  // Count files by status (including error)
  const statusCounts = useMemo(() => {
    const counts = {
      indexed: 0,
      pending: 0,
      pending_delete: 0,
      error: 0,
      unknown: 0,
    };

    kbResources?.data?.forEach((resource) => {
      const status = resource.status || "unknown";
      if (status in counts) {
        counts[status as keyof typeof counts]++;
      }
    });

    return counts;
  }, [kbResources?.data]);

  return {
    kbResources: kbResources?.data || [],
    statusMap,
    statusCounts,
    allFilesSettled,
    isLoading,
    error,
    refetch,
    shouldPoll, // Expose for debugging
  };
}
