import { build } from 'vite';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(root, '.editor-runtime-'));
writeFileSync(join(dir, 'index.html'), '<div id="root" style="height:700px"></div><script type="module" src="/entry.tsx"></script>');
writeFileSync(join(dir, 'entry.tsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { EditorPane } from '../src/renderer/src/components/EditorPane';
import * as monaco from 'monaco-editor';
import '../src/renderer/src/styles.css';
window.owncoder = { readWorkspaceFile: async () => '普通内容' } as any;
const before = Array.from({length:200}, (_,i) => 'const line'+i+' = '+i+';').join('\\n');
const after = before.replace('line100 = 100', 'line100 = 999');
const root = createRoot(document.getElementById('root')!);
(window as any).runCase = (mode: boolean, active = true) => root.render(<EditorPane path="test.txt" active={active} diffMode={mode as any} {...(mode ? {content:after, originalContent:before} : {}) as any}/>);
(window as any).inspect = () => ({models:monaco.editor.getModels().length, diffs: monaco.editor.getDiffEditors().map(e=>({changes:e.getLineChanges(), height:e.getModifiedEditor().getContentHeight()}))});
(window as any).closeCase = () => root.render(null);
(window as any).runCase(false);
`);
await build({ configFile:false, logLevel:'error', root:dir, base:'./', worker:{format:'es'}, build:{outDir:join(dir,'out'), minify:false}, esbuild:{jsx:'automatic'} });
writeFileSync(join(dir, 'runner.cjs'), `
const {app,BrowserWindow} = require('electron');
const fs = require('node:fs');
const report = {errors:[], gone:[], cases:[]};
app.whenReady().then(async()=>{
 const win = new BrowserWindow({show:false,width:1100,height:800,webPreferences:{contextIsolation:false,nodeIntegration:false}});
 win.webContents.on('console-message', (e,level,message)=>{if(level>=2 && !message.includes('Electron Security Warning'))report.errors.push(message)});
 win.webContents.on('render-process-gone',(e,d)=>report.gone.push(d));
 const delay = ms => new Promise(r=>setTimeout(r,ms));
 try {
 await win.loadFile(${JSON.stringify(join(dir,'out/index.html'))});
 await delay(1000);
 for (const mode of [true,false,true,false,true]) {
 await win.webContents.executeJavaScript('window.runCase('+mode+')');
 await delay(2000);
 report.cases.push(await win.webContents.executeJavaScript('window.inspect()'));
 }
 await win.webContents.executeJavaScript('window.closeCase()'); await delay(500);
 report.closed = await win.webContents.executeJavaScript('window.inspect()');
 } catch(e) {report.errors.push(String(e))}
 fs.writeFileSync(${JSON.stringify(join(dir,'report.json'))},JSON.stringify(report,null,2));
 app.quit();
});
setTimeout(()=>{fs.writeFileSync(${JSON.stringify(join(dir,'report.json'))},JSON.stringify(report));app.exit(2)},25000);
`);
const env = {...process.env};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [join(dir,'runner.cjs')], {env,stdio:'inherit'});
await new Promise(r=>child.on('exit',r));
const report = JSON.parse(readFileSync(join(dir,'report.json'),'utf8'));
writeFileSync(join(root, 'editor-runtime-verification.log'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report,null,2));
if(report.gone.length || report.errors.length || !report.cases[0]?.diffs[0]?.changes?.length || report.closed?.models !== 0) process.exitCode = 1;
