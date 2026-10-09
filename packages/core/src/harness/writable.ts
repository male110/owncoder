import { resolve } from "node:path";



export function toAbs(workspaceRoot: string, relOrAbs: string): string {
  return resolve(workspaceRoot, relOrAbs);
}
