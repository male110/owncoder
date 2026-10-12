
import React from 'react';
import { createRoot } from 'react-dom/client';
import { EditorPane } from '../src/renderer/src/components/EditorPane';
import * as monaco from 'monaco-editor';
window.owncoder = { readWorkspaceFile: async () => '普通内容' } as any;
const before = Array.from({length:200}, (_,i) => 'const line'+i+' = '+i+';').join('\n');
const after = before.replace('line100 = 100', 'line100 = 999');
const root = createRoot(document.getElementById('root')!);
(window as any).runCase = (mode: boolean, active = true) => root.render(<EditorPane path="test.txt" active={active} diffMode={mode as any} {...(mode ? {content:after, originalContent:before} : {}) as any}/>);
(window as any).inspect = () => ({models:monaco.editor.getModels().length, diffs: monaco.editor.getDiffEditors().map(e=>({changes:e.getLineChanges(), result:e.getDiffComputationResult(), height:e.getModifiedEditor().getContentHeight()}))});
(window as any).closeCase = () => root.render(null);
(window as any).runCase(false);
