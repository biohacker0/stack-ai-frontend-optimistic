import { FileItem } from "@/lib/types/file";

interface FileStatusCellProps {
  file: FileItem;
  isFileDeleting?: (fileId: string) => boolean;
}

export function FileStatusCell({ file, isFileDeleting }: FileStatusCellProps) {
  const status = file.status;

  // Never show status for directories
  if (file.type === "directory") {
    return <span className="text-gray-400">-</span>;
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