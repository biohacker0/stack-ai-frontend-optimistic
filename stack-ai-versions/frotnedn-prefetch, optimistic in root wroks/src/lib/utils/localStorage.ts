const KB_STORAGE_KEY = "stackai_knowledge_base";

export interface KBStorageData {
  id: string;
  name: string;
  created_at: string;
}

export function saveKBToStorage(kb: KBStorageData): void {
  try {
    localStorage.setItem(KB_STORAGE_KEY, JSON.stringify(kb));
  } catch (error) {
    console.error("Failed to save KB to localStorage:", error);
  }
}

export function getKBFromStorage(): KBStorageData | null {
  try {
    const stored = localStorage.getItem(KB_STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch (error) {
    console.error("Failed to get KB from localStorage:", error);
    return null;
  }
}

export function clearKBFromStorage(): void {
  try {
    localStorage.removeItem(KB_STORAGE_KEY);
  } catch (error) {
    console.error("Failed to clear KB from localStorage:", error);
  }
}

export function hasStoredKB(): boolean {
  return getKBFromStorage() !== null;
} 