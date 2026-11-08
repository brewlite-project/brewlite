import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(TESTS_DIR, "..");

function tryResolveFile(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return pathToFileURL(candidate).href;
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("next/")) {
    const resolved = tryResolveFile(
      path.join(FRONTEND_ROOT, "node_modules", specifier)
    );
    if (resolved) {
      return { url: resolved, shortCircuit: true };
    }
    if (!specifier.endsWith(".js")) {
      return nextResolve(`${specifier}.js`, context);
    }
  }

  if (specifier.startsWith("@/")) {
    const subPath = specifier.slice(2);
    const target = path.join(FRONTEND_ROOT, subPath);
    const resolved = tryResolveFile(target);
    if (resolved) {
      return { url: resolved, shortCircuit: true };
    }
  }

  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL &&
    context.parentURL.startsWith("file:")
  ) {
    const parentPath = fileURLToPath(context.parentURL);
    if (parentPath.startsWith(FRONTEND_ROOT)) {
      const parentDir = path.dirname(parentPath);
      const target = path.resolve(parentDir, specifier);
      const resolved = tryResolveFile(target);
      if (resolved) {
        return { url: resolved, shortCircuit: true };
      }
    }
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && (url.endsWith(".ts") || url.endsWith(".tsx"))) {
    const filePath = fileURLToPath(url);
    const source = fs.readFileSync(filePath, "utf8");
    const transpiled = ts.transpileModule(source, {
      fileName: filePath,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    });

    return {
      format: "module",
      source: transpiled.outputText,
      shortCircuit: true,
    };
  }

  return nextLoad(url, context);
}
