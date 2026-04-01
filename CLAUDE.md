# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run setup        # First-time setup: install deps + prisma generate + migrate
npm run dev          # Start dev server (Turbopack)
npm run build        # Production build
npm run lint         # ESLint
npm run test         # Run Vitest tests
npm run db:reset     # Reset SQLite database (destructive)
```

To run a single test file: `npx vitest run src/path/to/file.test.ts`

## Architecture

UIGen is an AI-powered React component generator with live preview. Users describe components in natural language; Claude generates them via tool calls into an in-memory virtual file system, which is instantly rendered in a sandboxed iframe.

### Data Flow

```
User prompt → /api/chat → Claude (stream) → tool calls (str_replace_editor / file_manager)
    → VirtualFileSystem (in-memory) → FileSystemContext → PreviewFrame (Babel + esm.sh iframe)
```

### Key Layers

**AI Integration (`src/lib/`)**
- `provider.ts` — Selects real (`@ai-sdk/anthropic`, Claude Haiku 4.5) or mock provider based on `ANTHROPIC_API_KEY`
- `prompts/generation.tsx` — System prompt enforcing `/App.jsx` as entrypoint, Tailwind styling, virtual FS usage
- `tools/` — Two AI tools: `str_replace_editor` (view/create/edit files) and `file_manager` (rename/delete)
- `file-system.ts` — In-memory VirtualFileSystem; never writes to disk; serialized as JSON for DB persistence

**API Route (`src/app/api/chat/route.ts`)**
- Streams `streamText()` responses with tools; max 40 steps (4 for mock)
- On finish, saves messages + serialized FS to Prisma project record

**Frontend State (`src/lib/contexts/`)**
- `ChatProvider` — wraps Vercel AI SDK `useChat`; handles tool call results; tracks anonymous work
- `FileSystemProvider` — holds VirtualFileSystem instance; triggers preview refreshes on FS changes

**Preview (`src/lib/transform/jsx-transformer.ts`)**
- Transpiles JSX client-side with Babel Standalone
- Builds an import map pointing to esm.sh CDN for React, ReactDOM, and other packages
- Renders inside a sandboxed iframe

**Auth & Persistence**
- JWT sessions in httpOnly cookies (`src/lib/auth.ts`); default secret `development-secret-key` (override with `JWT_SECRET`)
- SQLite + Prisma (`prisma/schema.prisma`): `User` and `Project` models; messages/FS stored as JSON strings
- Anonymous work optionally backed up to localStorage (`src/lib/anon-work-tracker.ts`)

**UI Layout (`src/app/main-content.tsx`)**
- 3-panel resizable layout: Chat (left) | Preview or Code Editor (right)
- Code view: FileTree + Monaco Editor
- `src/app/[projectId]/page.tsx` is the authenticated project route; `src/app/page.tsx` redirects based on auth state

### Path Alias
`@/*` maps to `./src/*` (tsconfig + components.json).

### Node Compatibility
Dev server uses `NODE_OPTIONS='--require ./node-compat.cjs'` to fix Web Storage SSR issues on Node 25+.
