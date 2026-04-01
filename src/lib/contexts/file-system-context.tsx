"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from "react";
import { VirtualFileSystem, FileNode } from "@/lib/file-system";

interface ToolCall {
  toolName: string;
  args: any;
}

interface FileSystemContextType {
  fileSystem: VirtualFileSystem;
  selectedFile: string | null;
  setSelectedFile: (path: string | null) => void;
  createFile: (path: string, content?: string) => void;
  updateFile: (path: string, content: string) => void;
  deleteFile: (path: string) => void;
  renameFile: (oldPath: string, newPath: string) => boolean;
  getFileContent: (path: string) => string | null;
  getAllFiles: () => Map<string, string>;
  refreshTrigger: number;
  handleToolCall: (toolCall: ToolCall) => void;
  reset: () => void;
}

const FileSystemContext = createContext<FileSystemContextType | undefined>(
  undefined
);

export function FileSystemProvider({
  children,
  fileSystem: providedFileSystem,
  initialData,
}: {
  children: React.ReactNode;
  fileSystem?: VirtualFileSystem;
  initialData?: Record<string, any>;
}) {
  // The VirtualFileSystem instance is intentionally NOT stored as a React state
  // value — it's a mutable object and React can't diff it.  Instead, a separate
  // `refreshTrigger` counter is incremented after every mutation so components
  // that need to re-read the FS (e.g. the file tree) know when to do so.
  const [fileSystem] = useState(() => {
    const fs = providedFileSystem || new VirtualFileSystem();
    if (initialData) {
      fs.deserializeFromNodes(initialData);
    }
    return fs;
  });
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const triggerRefresh = useCallback(() => {
    setRefreshTrigger((prev) => prev + 1);
  }, []);

  // Auto-select the first meaningful file when none is selected.  This runs
  // after every refresh so newly created files can become the active selection
  // when the editor is empty.  /App.jsx is preferred because it's the entry
  // point shown in the preview; otherwise fall back to any root-level file.
  useEffect(() => {
    if (!selectedFile) {
      const files = fileSystem.getAllFiles();

      if (files.has("/App.jsx")) {
        setSelectedFile("/App.jsx");
      } else {
        const rootFiles = Array.from(files.keys())
          .filter((path) => {
            const parts = path.split("/").filter(Boolean);
            return parts.length === 1; // Root level file
          })
          .sort();

        if (rootFiles.length > 0) {
          setSelectedFile(rootFiles[0]);
        }
      }
    }
  }, [selectedFile, fileSystem, refreshTrigger]);

  const createFile = useCallback(
    (path: string, content: string = "") => {
      fileSystem.createFile(path, content);
      triggerRefresh();
    },
    [fileSystem, triggerRefresh]
  );

  const updateFile = useCallback(
    (path: string, content: string) => {
      fileSystem.updateFile(path, content);
      triggerRefresh();
    },
    [fileSystem, triggerRefresh]
  );

  const deleteFile = useCallback(
    (path: string) => {
      fileSystem.deleteFile(path);
      if (selectedFile === path) {
        setSelectedFile(null);
      }
      triggerRefresh();
    },
    [fileSystem, selectedFile, triggerRefresh]
  );

  const renameFile = useCallback(
    (oldPath: string, newPath: string): boolean => {
      const success = fileSystem.rename(oldPath, newPath);
      if (success) {
        if (selectedFile === oldPath) {
          // The currently-open file was renamed; keep it open under the new path.
          setSelectedFile(newPath);
        } else if (selectedFile && selectedFile.startsWith(oldPath + "/")) {
          // The currently-open file lives inside a renamed directory.
          // Reconstruct its path by replacing the old directory prefix.
          const relativePath = selectedFile.substring(oldPath.length);
          setSelectedFile(newPath + relativePath);
        }
        triggerRefresh();
      }
      return success;
    },
    [fileSystem, selectedFile, triggerRefresh]
  );

  const getFileContent = useCallback(
    (path: string) => {
      return fileSystem.readFile(path);
    },
    [fileSystem]
  );

  const getAllFiles = useCallback(() => {
    return fileSystem.getAllFiles();
  }, [fileSystem]);

  const reset = useCallback(() => {
    fileSystem.reset();
    setSelectedFile(null);
    triggerRefresh();
  }, [fileSystem, triggerRefresh]);

  // handleToolCall is called by ChatProvider's onToolCall hook as tool results
  // stream in from the AI.  Its job is to apply the same mutations to the client-
  // side VirtualFileSystem that the server-side FS already applied, so the file
  // tree and editor reflect the AI's changes in real time without waiting for
  // the full response to complete.
  //
  // The pattern for str_replace and insert is:
  //   1. Call the FS method directly (it mutates the underlying data).
  //   2. If successful, call the context wrapper (updateFile) which also calls
  //      triggerRefresh() so React re-renders the file tree and editor.
  //
  // Calling the FS method *and* the context wrapper might look redundant, but
  // the FS method returns a result string we need to check for errors before
  // deciding whether to trigger a refresh.
  const handleToolCall = useCallback(
    (toolCall: ToolCall) => {
      const { toolName, args } = toolCall;

      if (toolName === "str_replace_editor" && args) {
        const { command, path, file_text, old_str, new_str, insert_line } = args;

        switch (command) {
          case "create":
            if (path && file_text !== undefined) {
              const result = fileSystem.createFileWithParents(path, file_text);
              if (!result.startsWith("Error:")) {
                createFile(path, file_text);
              }
            }
            break;

          case "str_replace":
            if (path && old_str !== undefined && new_str !== undefined) {
              const result = fileSystem.replaceInFile(path, old_str, new_str);
              if (!result.startsWith("Error:")) {
                // Read back the post-mutation content so the editor shows the
                // real result rather than trying to reconstruct it locally.
                const content = fileSystem.readFile(path);
                if (content !== null) {
                  updateFile(path, content);
                }
              }
            }
            break;

          case "insert":
            if (path && new_str !== undefined && insert_line !== undefined) {
              const result = fileSystem.insertInFile(path, insert_line, new_str);
              if (!result.startsWith("Error:")) {
                const content = fileSystem.readFile(path);
                if (content !== null) {
                  updateFile(path, content);
                }
              }
            }
            break;
        }
      }

      if (toolName === "file_manager" && args) {
        const { command, path, new_path } = args;

        switch (command) {
          case "rename":
            if (path && new_path) {
              // renameFile handles both the FS mutation and the selectedFile
              // pointer update in one call.
              renameFile(path, new_path);
            }
            break;

          case "delete":
            if (path) {
              // deleteFile on the FS recurses into directories; the context
              // wrapper additionally clears selectedFile if it was the deleted path.
              const success = fileSystem.deleteFile(path);
              if (success) {
                deleteFile(path);
              }
            }
            break;
        }
      }
    },
    [fileSystem, createFile, updateFile, deleteFile, renameFile]
  );

  return (
    <FileSystemContext.Provider
      value={{
        fileSystem,
        selectedFile,
        setSelectedFile,
        createFile,
        updateFile,
        deleteFile,
        renameFile,
        getFileContent,
        getAllFiles,
        refreshTrigger,
        handleToolCall,
        reset,
      }}
    >
      {children}
    </FileSystemContext.Provider>
  );
}

export function useFileSystem() {
  const context = useContext(FileSystemContext);
  if (!context) {
    throw new Error("useFileSystem must be used within a FileSystemProvider");
  }
  return context;
}
