import { FileItem } from "@/lib/types/file";
import { useOptimisticDeleteRegistry } from "@/hooks/useOptimisticDeleteRegistry";

interface FileStatusCellProps {
  file: FileItem;
  isFileDeleting?: (fileId: string) => boolean;
}

export function FileStatusCell({ file, isFileDeleting }: FileStatusCellProps) {
  const { getFileStatusOverride } = useOptimisticDeleteRegistry();
  
  // Check for optimistic delete override first
  const statusOverride = getFileStatusOverride(file.id);
  const status = statusOverride || file.status;

  // Never show status for directories
  if (file.type === "directory") {
    return <span className="text-gray-400">-</span>;
  }

  // Handle optimistic delete state (status is "-")
  if (statusOverride === "-" || status === undefined || status === null) {
    return <span className="text-gray-400 font-medium">-</span>;
  }

  if (status === "indexed") {
    return <span className="text-green-600 font-medium">✓ Indexed</span>;
  }
  
  if (status === "pending") {
    return <span className="text-yellow-600 font-medium">⏳ Indexing...</span>;
  }
  
  if (status === "pending_delete" || isFileDeleting?.(file.id)) {
    return <span className="text-red-600 font-medium">🗑️ Deleting...</span>;
  }

  if (status === "error") {
    return <span className="text-red-600 font-medium">❌ Failed</span>;
  }

  return <span className="text-gray-400">-</span>;
} 