// Monaco 0.52 ESM workers resolve foreign modules relative to this root.
globalThis._VSCODE_FILE_ROOT = new URL("./", import.meta.url).toString();

// Load Monaco only after the root is available to its worker modules.
// @ts-expect-error Monaco 0.52 ships this ESM worker without declarations.
void import("monaco-editor/esm/vs/editor/editor.worker").then(({ initialize }) => {
  initialize(null);
});
