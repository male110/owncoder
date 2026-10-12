
const {app,BrowserWindow} = require('electron');
const fs = require('node:fs');
const report = {errors:[], gone:[], cases:[]};
app.whenReady().then(async()=>{
 const win = new BrowserWindow({show:false,width:1100,height:800,webPreferences:{contextIsolation:false,nodeIntegration:false}});
 win.webContents.on('console-message', (e,level,message)=>{if(level>=2)report.errors.push(message)});
 win.webContents.on('render-process-gone',(e,d)=>report.gone.push(d));
 const delay = ms => new Promise(r=>setTimeout(r,ms));
 try {
 await win.loadFile("E:\\owncoder\\apps\\desktop\\.editor-runtime-8GETdp\\out\\index.html");
 await delay(1000);
 for (const mode of [true,false,true,false,true]) {
 await win.webContents.executeJavaScript('window.runCase('+mode+')');
 await delay(2000);
 report.cases.push(await win.webContents.executeJavaScript('window.inspect()'));
 }
 await win.webContents.executeJavaScript('window.closeCase()'); await delay(500);
 report.closed = await win.webContents.executeJavaScript('window.inspect()');
 } catch(e) {report.errors.push(String(e))}
 fs.writeFileSync("E:\\owncoder\\apps\\desktop\\.editor-runtime-8GETdp\\report.json",JSON.stringify(report,null,2));
 app.quit();
});
setTimeout(()=>{fs.writeFileSync("E:\\owncoder\\apps\\desktop\\.editor-runtime-8GETdp\\report.json",JSON.stringify(report));app.exit(2)},25000);
