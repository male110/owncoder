const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/src/styles.css'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/src/components/Composer.tsx'), 'utf8');
  const positionStart = source.indexOf('      const updatePosition = () => {');
  const positionEnd = source.indexOf('      models.scrollTop = 0;', positionStart);
  assert.ok(positionStart >= 0 && positionEnd > positionStart, '找不到模型菜单定位逻辑');
  const positionCode = source.slice(positionStart, positionEnd).replace(/<HTMLElement>/g, '');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    let cases = 0;
    for (const [width, height] of [[1280, 800], [640, 480], [360, 320]]) {
      win.setContentSize(width, height);
      for (const anchor of ['top', 'bottom']) {
      for (const providerCount of [1, 3, 12]) {
        for (const modelCount of [1, 2, 30]) {
          const providers = Array.from({ length: providerCount }, (_, i) =>
            `<button class="model-menu-provider-item" aria-selected="${i === providerCount - 1}"><span class="model-menu-provider-label">Platform ${i}</span></button>`).join('');
          const models = Array.from({ length: modelCount }, (_, i) =>
            `<li><button><span class="model-menu-name">Model ${i}</span></button></li>`).join('');
          const html = `<style>${css}</style>
            <div class="model-picker" style="position:absolute;left:24px;${anchor}:24px">
              <button class="model-chip">Model</button>
              <div class="model-menu">
                <div class="model-menu-body">
                  <nav class="model-menu-providers">
                    <div class="model-menu-providers-list">${providers}</div>
                    <button class="model-menu-settings">模型设置</button>
                  </nav>
                  <ul class="model-menu-models">${models}</ul>
                </div>
              </div>
            </div>`;
          await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
          const result = await win.webContents.executeJavaScript(`
            new Promise(resolve => setTimeout(() => {
              const menu = document.querySelector('.model-menu');
              const picker = document.querySelector('.model-picker');
              const ref = { current: picker };
              const body = document.querySelector('.model-menu-body');
              const list = document.querySelector('.model-menu-providers-list');
              const models = document.querySelector('.model-menu-models');
              const settings = document.querySelector('.model-menu-settings');
              list.scrollTop = list.scrollHeight;
              ${positionCode}
              updatePosition();
              const m = menu.getBoundingClientRect();
              const l = models.getBoundingClientRect();
              const p = picker.getBoundingClientRect();
              const s = settings.getBoundingClientRect();
              const hit = document.elementFromPoint(s.left + s.width * 0.75, s.top + s.height / 2);
              models.scrollTop = models.scrollHeight;
              const last = models.lastElementChild.querySelector('button');
              const lastRect = last.getBoundingClientRect();
              const lastHit = document.elementFromPoint(lastRect.left + lastRect.width / 2, lastRect.top + lastRect.height / 2);
              let selected = false;
              last.addEventListener('click', () => { selected = true; });
              if (lastHit) lastHit.click();
              resolve({
                contained: l.top >= 7.5 && l.bottom <= innerHeight - 7.5 && m.top >= 7.5 && m.bottom <= innerHeight - 7.5 && m.right <= innerWidth,
                clearOfInput: '${anchor}' === 'bottom' ? l.bottom <= p.top - 5.5 : l.top >= p.bottom + 5.5,
                settingsVisible: s.height > 0 && settings.contains(hit),
                scrollable: models.scrollHeight <= models.clientHeight || models.scrollTop > 0,
                lastModelVisible: lastRect.top >= l.top && lastRect.bottom <= l.bottom,
                lastModelClickable: selected
              });
            }, 200));
          `);
          const label = `${width}x${height}, ${anchor}, ${providerCount} platforms, ${modelCount} models`;
          for (const [check, passed] of Object.entries(result)) assert.ok(passed, `${label}: ${check}`);
          cases++;
        }
      }
    }
    }
    console.log(`通过：${cases} 个模型菜单布局场景`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
});
