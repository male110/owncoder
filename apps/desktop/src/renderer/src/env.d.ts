/// <reference types="vite/client" />
import type { DesktopApi } from "../../preload/index";

declare module "monaco-editor/esm/vs/editor/editor.worker" {
  export function initialize(foreignModule: unknown): void;
}

declare module "monaco-editor/esm/vs/language/typescript/ts.worker" {
  const worker: unknown;
  export default worker;
}

declare module "monaco-editor/esm/vs/language/json/json.worker" {
  const worker: unknown;
  export default worker;
}

declare module "monaco-editor/esm/vs/language/css/css.worker" {
  const worker: unknown;
  export default worker;
}

declare module "monaco-editor/esm/vs/language/html/html.worker" {
  const worker: unknown;
  export default worker;
}

declare global {
  interface Window {
    owncoder: DesktopApi;
  }

  // Monaco 0.52 ESM workers use this root when resolving foreign modules.
  var _VSCODE_FILE_ROOT: string | undefined;
}

export {};
