// str-replace.ts wires the Anthropic text-editor tool schema to the VirtualFileSystem.
// The tool is built as a closure over a specific VirtualFileSystem instance so the
// API route can pass its own per-request FS without any global state.
//
// The parameter schema deliberately mirrors the Anthropic-defined text_editor_20250124
// tool interface so the model's existing knowledge of that tool transfers directly.

import { z } from "zod";
import { VirtualFileSystem } from "@/lib/file-system";

const TextEditorParameters = z.object({
  command: z.enum(["view", "create", "str_replace", "insert", "undo_edit"]),
  path: z.string(),
  file_text: z.string().optional(),
  insert_line: z.number().optional(),
  new_str: z.string().optional(),
  old_str: z.string().optional(),
  view_range: z.array(z.number()).optional(),
});

export const buildStrReplaceTool = (fileSystem: VirtualFileSystem) => {
  return {
    id: "str_replace_editor" as const,
    args: {},
    parameters: TextEditorParameters,
    execute: async ({
      command,
      path,
      file_text,
      insert_line,
      new_str,
      old_str,
      view_range,
    }: z.infer<typeof TextEditorParameters>) => {
      switch (command) {
        case "view":
          // Returns line-numbered content so the AI can reference specific lines
          // in subsequent str_replace or insert calls.
          return fileSystem.viewFile(
            path,
            view_range as [number, number] | undefined
          );

        case "create":
          // createFileWithParents automatically creates any missing ancestor
          // directories, matching the AI's expectation that it never needs to
          // create directories explicitly.
          return fileSystem.createFileWithParents(path, file_text || "");

        case "str_replace":
          return fileSystem.replaceInFile(path, old_str || "", new_str || "");

        case "insert":
          return fileSystem.insertInFile(path, insert_line || 0, new_str || "");

        case "undo_edit":
          // The VirtualFileSystem has no undo stack, so this intentionally
          // returns a helpful error directing the AI to use str_replace instead.
          return `Error: undo_edit command is not supported in this version. Use str_replace to revert changes.`;
      }
    },
  };
};
