// The TypeScript worker imports the editor worker and uses the same resource root.
globalThis._VSCODE_FILE_ROOT = new URL("./", import.meta.url).toString();

// Load Monaco only after the root is available to its worker modules.
// @ts-expect-error Monaco 0.52 ships this ESM worker without declarations.
void import("monaco-editor/esm/vs/language/typescript/ts.worker");
