const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/src/styles.css'), 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    let cases = 0;
    for (const [width, height] of [[1280, 800], [640, 480], [360, 320]]) {
      win.setContentSize(width, height);
      for (const providerCount of [1, 12]) {
        for (const modelCount of [1, 2, 30]) {
          const providers = Array.from({ length: providerCount }, (_, i) =>
            `<button class="model-menu-provider-item"><span class="model-menu-provider-label">Platform ${i}</span></button>`).join('');
          const models = Array.from({ length: modelCount }, (_, i) =>
            `<li><button><span class="model-menu-name">Model ${i}</span></button></li>`).join('');
          const html = `<style>${css}</style>
            <div class="model-picker" style="position:absolute;left:24px;bottom:24px">
              <button class="model-chip">Model</button>
              <div class="model-menu">
                <div class="model-menu-body">
                  <nav class="model-menu-providers">${providers}</nav>
                  <ul class="model-menu-models">${models}</ul>
                </div>
                <div class="ws-menu-sep"></div>
                <button class="model-menu-settings">Model settings</button>
              </div>
            </div>`;
          await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
          const result = await win.webContents.executeJavaScript(`
            new Promise(resolve => setTimeout(() => {
              const menu = document.querySelector('.model-menu');
              const list = document.querySelector('.model-menu-models');
              const providers = document.querySelector('.model-menu-providers');
              const settings = document.querySelector('.model-menu-settings');
              const m = menu.getBoundingClientRect();
              const l = list.getBoundingClientRect();
              const p = providers.getBoundingClientRect();
              const s = settings.getBoundingClientRect();
              const hit = document.elementFromPoint(s.left + s.width * 0.75, s.top + s.height / 2);
              list.scrollTop = list.scrollHeight;
              resolve({
                separated: s.top >= Math.max(l.bottom, p.bottom),
                contained: s.bottom <= m.bottom && m.top >= 0 && m.right <= innerWidth,
                visible: s.height > 0 && settings.contains(hit),
                scrollable: list.scrollHeight <= list.clientHeight || list.scrollTop > 0
              });
            }, 200));
          `);
          const label = `${width}x${height}, ${providerCount} platforms, ${modelCount} models`;
          for (const [check, passed] of Object.entries(result)) assert.ok(passed, `${label}: ${check}`);
          cases++;
        }
      }
    }
    console.log(`PASS: ${cases} model-menu layout cases`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
});
