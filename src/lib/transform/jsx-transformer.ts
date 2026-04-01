// jsx-transformer.ts is the browser-side compilation pipeline for the preview iframe.
// It uses Babel standalone (runs entirely in the browser) to convert JSX/TSX → plain JS,
// then packages every file as a Blob URL so the iframe can import them via a native
// import map — no bundler or server round-trip required at preview time.

import * as Babel from "@babel/standalone";

export interface TransformResult {
  code: string;
  error?: string;
  missingImports?: Set<string>;
  cssImports?: Set<string>;
}

// Produces a minimal ESM-compatible stub for any import that resolves to a missing
// local file.  The stub renders nothing but satisfies the import so the rest of the
// app can still load — better than a hard crash at preview time.
function createPlaceholderModule(componentName: string): string {
  return `
import React from 'react';
const ${componentName} = function() {
  return React.createElement('div', {}, null);
}
export default ${componentName};
export { ${componentName} };
`;
}


export function transformJSX(
  code: string,
  filename: string,
  existingFiles: Set<string>
): TransformResult {
  try {
    const isTypeScript = filename.endsWith(".ts") || filename.endsWith(".tsx");

    let processedCode = code;

    // This regex captures the module specifier from any standard static import.
    // Named imports ({…}), default imports, and combined forms are all matched;
    // we only care about the specifier in capture group 1.
    const importRegex =
      /import\s+(?:{[^}]+}|[^,\s]+)?\s*(?:,\s*{[^}]+})?\s+from\s+['"]([^'"]+)['"]/g;
    const imports = new Set<string>();
    const cssImports = new Set<string>();

    // CSS imports use a side-effect-only form (`import './foo.css'`) that Babel
    // cannot handle in a browser ESM context.  Collect them before stripping so
    // we can inject the styles as a <style> tag in the iframe instead.
    const cssImportRegex = /import\s+['"]([^'"]+\.css)['"]/g;
    let cssMatch;
    while ((cssMatch = cssImportRegex.exec(code)) !== null) {
      cssImports.add(cssMatch[1]);
    }

    // Strip CSS imports before handing the source to Babel; leaving them in
    // would produce a Babel error because CSS paths aren't valid ES modules.
    processedCode = processedCode.replace(cssImportRegex, '');

    let match;
    while ((match = importRegex.exec(code)) !== null) {
      if (!match[1].endsWith('.css')) {
        imports.add(match[1]);
      }
    }

    const result = Babel.transform(processedCode, {
      filename,
      presets: [
        // `runtime: "automatic"` means Babel inserts `import { jsx } from 'react/jsx-runtime'`
        // instead of requiring React to be in scope — matches React 17+ conventions.
        ["react", { runtime: "automatic" }],
        // TypeScript preset is only added when needed; adding it for plain JS files
        // causes false parse errors on certain valid JS syntax.
        ...(isTypeScript ? ["typescript"] : []),
      ],
      plugins: [],
    });

    return {
      code: result.code || "",
      missingImports: imports,
      cssImports: cssImports,
    };
  } catch (error) {
    return {
      code: "",
      error: error instanceof Error ? error.message : "Unknown transform error",
    };
  }
}

// Wraps compiled JS in a Blob URL so the browser can `import()` it without a server.
// The MIME type must be `application/javascript` — browsers reject module imports from
// blobs with incorrect MIME types even if Content-Type sniffing would otherwise work.
export function createBlobURL(
  code: string,
  mimeType: string = "application/javascript"
): string {
  const blob = new Blob([code], { type: mimeType });
  return URL.createObjectURL(blob);
}

export interface ImportMapResult {
  importMap: string;
  styles: string;
  errors: Array<{ path: string; error: string }>;
}

// createImportMap is the orchestration layer for the preview pipeline.
// It takes the raw virtual file map, compiles every JS/TS/JSX/TSX file with Babel,
// turns each result into a Blob URL, and produces a JSON import map that the iframe
// can consume via <script type="importmap">.  This allows the iframe to use native
// ES module semantics without a bundler.
export function createImportMap(files: Map<string, string>): ImportMapResult {
  // Seed the map with the CDN URLs for the React packages that every component
  // will need.  All local files will be added on top of these.
  const imports: Record<string, string> = {
    react: "https://esm.sh/react@19",
    "react-dom": "https://esm.sh/react-dom@19",
    "react-dom/client": "https://esm.sh/react-dom@19/client",
    "react/jsx-runtime": "https://esm.sh/react@19/jsx-runtime",
    "react/jsx-dev-runtime": "https://esm.sh/react@19/jsx-dev-runtime",
  };

  const transformedFiles = new Map<string, string>();
  const existingFiles = new Set(files.keys());
  // allImports accumulates relative/alias specifiers from every file so we can
  // detect which ones have no matching file and need a placeholder stub.
  const allImports = new Set<string>();
  // allCssImports defers CSS path resolution until we know all files exist.
  const allCssImports = new Set<{ from: string; cssPath: string }>();
  let collectedStyles = "";
  const errors: Array<{ path: string; error: string }> = [];

  // --- First pass: compile every JS/TS file and register its Blob URL ---
  for (const [path, content] of files) {
    if (
      path.endsWith(".js") ||
      path.endsWith(".jsx") ||
      path.endsWith(".ts") ||
      path.endsWith(".tsx")
    ) {
      const { code, error, missingImports, cssImports } = transformJSX(
        content,
        path,
        existingFiles
      );

      if (error) {
        // Collect syntax errors so createPreviewHTML can render them inline
        // instead of silently swallowing them.  The file is skipped entirely —
        // a broken module would cause a cascade of import errors at runtime.
        errors.push({ path, error });
        continue;
      }

      const blobUrl = createBlobURL(code);
      transformedFiles.set(path, blobUrl);

      if (missingImports) {
        missingImports.forEach((imp) => {
          // Bare specifiers (no leading `.`, `/`, or `@/`) are npm packages —
          // route them straight to esm.sh CDN rather than treating them as
          // missing local files.
          const isPackage = !imp.startsWith(".") &&
                            !imp.startsWith("/") &&
                            !imp.startsWith("@/");

          if (isPackage) {
            imports[imp] = `https://esm.sh/${imp}`;
          } else {
            allImports.add(imp);
          }
        });
      }

      if (cssImports) {
        cssImports.forEach((cssImport) => {
          allCssImports.add({ from: path, cssPath: cssImport });
        });
      }

      // Register the blob URL under every path variation the AI might use as
      // an import specifier.  The browser import map resolves specifiers
      // literally, so `/Button.jsx`, `Button.jsx`, `@/Button`, `@/Button.jsx`,
      // and the extension-free form all need explicit entries.
      imports[path] = blobUrl;

      if (path.startsWith("/")) {
        // Allow imports without the leading slash (e.g. `import X from 'components/X'`)
        imports[path.substring(1)] = blobUrl;
      }

      // Map the `@/` alias (Next.js / Vite convention) to the root-relative path
      if (path.startsWith("/")) {
        imports["@" + path] = blobUrl;
        imports["@/" + path.substring(1)] = blobUrl;
      }

      // Extension-free entries let consumers write `import X from '@/components/X'`
      // instead of `import X from '@/components/X.tsx'`
      const pathWithoutExt = path.replace(/\.(jsx?|tsx?)$/, "");
      imports[pathWithoutExt] = blobUrl;

      if (path.startsWith("/")) {
        imports[pathWithoutExt.substring(1)] = blobUrl;
        imports["@" + pathWithoutExt] = blobUrl;
        imports["@/" + pathWithoutExt.substring(1)] = blobUrl;
      }
    } else if (path.endsWith(".css")) {
      // CSS files can't be imported as ES modules; concatenate them into a
      // single <style> block that createPreviewHTML will inject into the iframe head.
      collectedStyles += `/* ${path} */\n${content}\n\n`;
    }
  }

  // --- Resolve CSS imports declared inside JS files ---
  for (const { from, cssPath } of allCssImports) {
    let resolvedPath = cssPath;

    if (cssPath.startsWith("@/")) {
      resolvedPath = cssPath.replace("@/", "/");
    } else if (cssPath.startsWith("./") || cssPath.startsWith("../")) {
      // Resolve the relative path against the directory of the importing file
      const fromDir = from.substring(0, from.lastIndexOf("/"));
      resolvedPath = resolveRelativePath(fromDir, cssPath);
    }

    if (files.has(resolvedPath)) {
      // The CSS file was already concatenated into collectedStyles in the loop above
    } else {
      collectedStyles += `/* ${cssPath} not found */\n`;
    }
  }

  // --- Second pass: fill gaps with placeholder stubs or CDN URLs ---
  // At this point `imports` already covers every successfully compiled local file.
  // Anything still in `allImports` but absent from `imports` is a missing dependency.
  for (const importPath of allImports) {
    if (imports[importPath] || importPath.startsWith("react")) {
      continue;
    }

    const isPackage = !importPath.startsWith(".") &&
                      !importPath.startsWith("/") &&
                      !importPath.startsWith("@/");

    if (isPackage) {
      imports[importPath] = `https://esm.sh/${importPath}`;
      continue;
    }

    // Try all the extension / alias variants before giving up — the file might
    // already have an entry under a different key registered in the first pass.
    let found = false;
    const variations = [
      importPath,
      importPath + ".jsx",
      importPath + ".tsx",
      importPath + ".js",
      importPath + ".ts",
      importPath.replace("@/", "/"),
      importPath.replace("@/", "/") + ".jsx",
      importPath.replace("@/", "/") + ".tsx",
    ];

    for (const variant of variations) {
      if (imports[variant] || files.has(variant)) {
        found = true;
        break;
      }
    }

    if (!found) {
      // The AI referenced a file that doesn't exist yet.  Inject a no-op stub
      // so the rest of the app can still render rather than failing entirely.
      const match = importPath.match(/\/([^\/]+)$/);
      const componentName = match
        ? match[1]
        : importPath.replace(/[^a-zA-Z0-9]/g, "");

      const placeholderCode = createPlaceholderModule(componentName);
      const placeholderUrl = createBlobURL(placeholderCode);

      imports[importPath] = placeholderUrl;
      if (importPath.startsWith("@/")) {
        imports[importPath.replace("@/", "/")] = placeholderUrl;
        imports[importPath.replace("@/", "")] = placeholderUrl;
      }
    }
  }

  return {
    importMap: JSON.stringify({ imports }, null, 2),
    styles: collectedStyles,
    errors
  };
}

// Resolves a relative path (e.g. `../utils/helpers`) against an absolute directory
// using the same segment-by-segment algorithm as a real filesystem: `..` pops the
// last segment, `.` is ignored, everything else is pushed.
function resolveRelativePath(fromDir: string, relativePath: string): string {
  const parts = fromDir.split("/").filter(Boolean);
  const relParts = relativePath.split("/");

  for (const part of relParts) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }

  return "/" + parts.join("/");
}

// createPreviewHTML produces the full HTML document that runs inside the preview iframe.
// It wires together:
//   1. Tailwind CSS (CDN) for zero-config utility classes
//   2. The collected <style> content from any .css files in the virtual FS
//   3. The JSON import map so native `import` statements resolve Blob URLs
//   4. A React ErrorBoundary that catches render errors without crashing the iframe
//   5. Either the compiled app or a styled syntax-error panel
//
// The entry point is loaded with a dynamic `import()` rather than a static module
// script so we can catch load errors and display them gracefully.
export function createPreviewHTML(
  entryPoint: string,
  importMap: string,
  styles: string = "",
  errors: Array<{ path: string; error: string }> = []
): string {
  // The entry point in the import map is stored under the path key (e.g. `/App.jsx`),
  // but the actual Blob URL is needed for the dynamic import() call.
  let entryPointUrl = entryPoint;
  try {
    const importMapObj = JSON.parse(importMap);
    if (importMapObj.imports && importMapObj.imports[entryPoint]) {
      entryPointUrl = importMapObj.imports[entryPoint];
    }
  } catch (e) {
    console.error("Failed to parse import map:", e);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Preview</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    #root {
      width: 100vw;
      height: 100vh;
    }
    .error-boundary {
      color: red;
      padding: 1rem;
      border: 2px solid red;
      margin: 1rem;
      border-radius: 4px;
      background: #fee;
    }
    .syntax-errors {
      background: #fef5f5;
      border: 2px solid #ff6b6b;
      border-radius: 12px;
      padding: 32px;
      margin: 24px;
      font-family: 'SF Mono', Monaco, Consolas, 'Courier New', monospace;
      font-size: 14px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    .syntax-errors h3 {
      color: #dc2626;
      margin: 0 0 20px 0;
      font-size: 18px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .syntax-errors .error-item {
      margin: 16px 0;
      padding: 16px;
      background: #fff;
      border-radius: 8px;
      border-left: 4px solid #ff6b6b;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
    }
    .syntax-errors .error-path {
      font-weight: 600;
      color: #991b1b;
      font-size: 15px;
      margin-bottom: 8px;
    }
    .syntax-errors .error-message {
      color: #7c2d12;
      margin-top: 8px;
      white-space: pre-wrap;
      line-height: 1.5;
      font-size: 13px;
    }
    .syntax-errors .error-location {
      display: inline-block;
      background: #fee0e0;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 12px;
      margin-left: 8px;
      color: #991b1b;
    }
  </style>
  ${styles ? `<style>\n${styles}</style>` : ''}
  <script type="importmap">
    ${importMap}
  </script>
</head>
<body>
  ${errors.length > 0 ? `
    <div class="syntax-errors">
      <h3>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="flex-shrink: 0;">
          <path d="M10 0C4.48 0 0 4.48 0 10s4.48 10 10 10 10-4.48 10-10S15.52 0 10 0zm1 15h-2v-2h2v2zm0-4h-2V5h2v6z" fill="#dc2626"/>
        </svg>
        Syntax Error${errors.length > 1 ? 's' : ''} (${errors.length})
      </h3>
      ${errors.map(e => {
        const locationMatch = e.error.match(/\((\d+:\d+)\)/);
        const location = locationMatch ? locationMatch[1] : '';
        const cleanError = e.error.replace(/\(\d+:\d+\)/, '').trim();
        
        return `
        <div class="error-item">
          <div class="error-path">
            ${e.path}
            ${location ? `<span class="error-location">${location}</span>` : ''}
          </div>
          <div class="error-message">${cleanError.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
        </div>
      `;
      }).join('')}
    </div>
  ` : ''}
  <div id="root"></div>
  ${errors.length === 0 ? `<script type="module">
    import React from 'react';
    import ReactDOM from 'react-dom/client';
    
    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
      }

      static getDerivedStateFromError(error) {
        return { hasError: true, error };
      }

      componentDidCatch(error, errorInfo) {
        console.error('Error caught by boundary:', error, errorInfo);
      }

      render() {
        if (this.state.hasError) {
          return React.createElement('div', { className: 'error-boundary' },
            React.createElement('h2', null, 'Something went wrong'),
            React.createElement('pre', null, this.state.error?.toString())
          );
        }

        return this.props.children;
      }
    }

    async function loadApp() {
      try {
        const module = await import('${entryPointUrl}');
        const App = module.default || module.App;
        
        if (!App) {
          throw new Error('No default export or App export found in ${entryPoint}');
        }

        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(
          React.createElement(ErrorBoundary, null,
            React.createElement(App)
          )
        );
      } catch (error) {
        console.error('Failed to load app:', error);
        console.error('Import map:', ${JSON.stringify(importMap)});
        document.getElementById('root').innerHTML = '<div class="error-boundary"><h2>Failed to load app</h2><pre>' + error.toString() + '</pre></div>';
      }
    }

    loadApp();
  </script>` : ''}
</body>
</html>`;
}
