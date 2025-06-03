import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileItem } from "@/lib/types/file";

interface FilePickerControlsProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  filteredCount: number;
  selectedFiles: FileItem[];
  selectedResourceIds: string[];
  hasKB: boolean | undefined;
  isCreatingKB: boolean | undefined;
  isDeletingKB: boolean | undefined;
  onCreateKB?: (resourceIds: string[], files: FileItem[]) => void;
  onCreateNewKB?: () => void;
  onDeleteFiles?: (selectedIds: string[]) => void;
  allFiles: FileItem[];
}

export function FilePickerControls({
  searchValue,
  onSearchChange,
  filteredCount,
  selectedFiles,
  selectedResourceIds,
  hasKB,
  isCreatingKB,
  isDeletingKB,
  onCreateKB,
  onCreateNewKB,
  onDeleteFiles,
  allFiles,
}: FilePickerControlsProps) {
  return (
    <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 flex-shrink-0">
      {/* Search Section */}
      <div className="flex items-center space-x-2 flex-1">
        <Input
          placeholder="Filter by name or status (indexed, pending, etc.)"
          value={searchValue}
          onChange={(event) => onSearchChange(event.target.value)}
          className="w-full lg:w-180 border-gray-300 focus:border-blue-500 focus:ring-blue-500"
        />
        {searchValue && <span className="text-sm text-gray-500 whitespace-nowrap">Showing {filteredCount} filtered results</span>}
      </div>

      {/* Action Buttons */}
      <div className="display grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 flex-shrink-0">
        {!hasKB ? (
          <Button disabled={selectedFiles.length === 0 || isCreatingKB} className="bg-blue-600 hover:bg-blue-700" onClick={() => onCreateKB?.(selectedResourceIds, allFiles)}>
            {isCreatingKB ? "Creating KB..." : `Create Knowledge Base (${selectedFiles.length} files)`}
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              disabled={selectedFiles.length === 0 || isDeletingKB}
              onClick={() => onDeleteFiles?.(selectedResourceIds)}
              className="text-red-600 hover:text-red-700 hover:bg-red-50"
            >
              {isDeletingKB ? "Deleting..." : `Delete Selected Files (${selectedFiles.length})`}
            </Button>
            <Button variant="outline" onClick={onCreateNewKB} disabled={isDeletingKB}>
              Create New Knowledge Base
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
