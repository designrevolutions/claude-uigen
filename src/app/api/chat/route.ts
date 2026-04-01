import type { FileNode } from "@/lib/file-system";
import { VirtualFileSystem } from "@/lib/file-system";
import { streamText, appendResponseMessages } from "ai";
import { buildStrReplaceTool } from "@/lib/tools/str-replace";
import { buildFileManagerTool } from "@/lib/tools/file-manager";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { getLanguageModel } from "@/lib/provider";
import { generationPrompt } from "@/lib/prompts/generation";

export async function POST(req: Request) {
  const {
    messages,
    files,
    projectId,
  }: { messages: any[]; files: Record<string, FileNode>; projectId?: string } =
    await req.json();

  // Prepend the system prompt as the first message rather than using a separate
  // `system` parameter.  The `cacheControl: ephemeral` hint tells Anthropic to
  // cache the (large) system prompt across turns, reducing latency and cost.
  messages.unshift({
    role: "system",
    content: generationPrompt,
    providerOptions: {
      anthropic: { cacheControl: { type: "ephemeral" } },
    },
  });

  // The client sends the virtual FS as a serialized node map with every request
  // because the API route is stateless — there is no shared server-side memory
  // between requests.  We reconstruct the FS so the tools can read/write files
  // and the final state can be persisted back to the database.
  const fileSystem = new VirtualFileSystem();
  fileSystem.deserializeFromNodes(files);

  const model = getLanguageModel();
  // maxSteps controls how many tool-call → tool-result round-trips the SDK will
  // execute before forcing a final text response.  The mock provider is capped
  // lower to avoid the fixed mock script looping indefinitely on step boundaries.
  const isMockProvider = !process.env.ANTHROPIC_API_KEY;
  const result = streamText({
    model,
    messages,
    maxTokens: 10_000,
    maxSteps: isMockProvider ? 4 : 40,
    onError: (err: any) => {
      console.error(err);
    },
    tools: {
      // str_replace_editor handles view/create/str_replace/insert — the main
      // tool the AI uses to write and edit files in the virtual FS.
      str_replace_editor: buildStrReplaceTool(fileSystem),
      // file_manager handles rename and delete operations.
      file_manager: buildFileManagerTool(fileSystem),
    },
    onFinish: async ({ response }) => {
      // Persist the updated messages and file state to the database only when
      // a projectId was supplied (i.e. the user is working on a saved project).
      if (projectId) {
        try {
          const session = await getSession();
          if (!session) {
            console.error("User not authenticated, cannot save project");
            return;
          }

          const responseMessages = response.messages || [];
          // appendResponseMessages merges the AI's assistant/tool turns back into
          // the conversation array so the full history is persisted as a single
          // JSON blob.  The system message is excluded — it is always re-injected
          // at request time and doesn't need to be stored.
          const allMessages = appendResponseMessages({
            messages: [...messages.filter((m) => m.role !== "system")],
            responseMessages,
          });

          await prisma.project.update({
            where: {
              id: projectId,
              userId: session.userId,
            },
            data: {
              messages: JSON.stringify(allMessages),
              // Persist the post-turn FS state so the client can reload it on
              // the next visit without re-running the conversation.
              data: JSON.stringify(fileSystem.serialize()),
            },
          });
        } catch (error) {
          console.error("Failed to save project data:", error);
        }
      }
    },
  });

  // toDataStreamResponse() converts the Vercel AI SDK stream into the Vercel
  // data-stream wire format, which the `useChat` hook on the client can parse
  // incrementally to update the UI as tokens arrive.
  return result.toDataStreamResponse();
}

// Vercel's default function timeout is 10 s; raise it to 120 s because multi-step
// AI generations with several tool calls can take much longer.
export const maxDuration = 120;
