const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// 复刻 Composer.tsx 中 composer-bar 的真实结构（含分阶段模式下嵌套的 composer-settings-row），
// 加载真实 styles.css，验证模型选择区在窄宽度（打开文件后对话框停靠右侧）下自动换行、
// 两个模型选择器完整可见、容器不横向溢出，且正常宽度下不换行（无回归）。
function barHtml(staged) {
  const decomposerModel = `
    <div class="model-picker model-picker-decomposer">
      <button type="button" class="model-chip model-chip-decomposer">
        ${staged ? '<span class="model-stage-indicator">📋</span>' : ''}
        <span class="model-chip-label">claude-sonnet-4-5-20250929</span>
        <span class="mode-chevron" aria-hidden="true">▾</span>
      </button>
    </div>`;
  const decomposerThinking = `
    <div class="thinking-picker">
      <button type="button" class="thinking-chip">
        <span class="thinking-icon">${staged ? '📋' : '💭'}</span>
        <span class="mode-chevron" aria-hidden="true">▾</span>
      </button>
    </div>`;
  const reactGroup = staged
    ? `<div class="model-group model-group-react">
        <div class="model-picker model-picker-react">
          <button type="button" class="model-chip model-chip-react">
            <span class="model-stage-indicator">🔄</span>
            <span class="model-chip-label">gpt-5.1-codex-2025-11</span>
            <span class="mode-chevron" aria-hidden="true">▾</span>
          </button>
        </div>
        <div class="thinking-picker thinking-picker-react">
          <button type="button" class="thinking-chip thinking-chip-react">
            <span class="thinking-icon">💭</span>
            <span class="mode-chevron" aria-hidden="true">▾</span>
          </button>
        </div>
      </div>`
    : '';
  return `
    <div class="composer-bar">
      <input class="composer-file-input" type="file" />
      <button type="button" class="upload-trigger">＋</button>
      <div class="mode-picker"><button type="button" class="mode-trigger">⚡ <span class="mode-chevron">▾</span></button></div>
      <div class="composer-settings-row">
        <div class="model-group model-group-decomposer">
          ${decomposerModel}
          ${decomposerThinking}
        </div>
        ${reactGroup}
      </div>
      <div class="composer-actions"><button type="button" class="send">➤</button></div>
    </div>`;
}

app.whenReady().then(async () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/src/styles.css'), 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    let cases = 0;
    // 1280/720 为正常宽度；480/360/300 模拟打开文件后对话框停靠右侧的窄列。
    for (const width of [1280, 720, 480, 360, 300, 180]) {
      win.setContentSize(width, 420);
      for (const theme of ['dark', 'light']) {
        for (const staged of [false, true]) {
          const html = `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><style>${css}</style></head>
            <body style="margin:0">
              <div id="host" class="composer" style="width:${width}px;box-sizing:border-box">
                ${barHtml(staged)}
              </div>
            </body></html>`;
          await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
          const result = await win.webContents.executeJavaScript(`
            new Promise(resolve => setTimeout(() => {
              const bar = document.querySelector('.composer-bar');
              const chips = [...bar.querySelectorAll('.model-chip, .thinking-chip')];
              const send = bar.querySelector('.send');
              const barRect = bar.getBoundingClientRect();
              const chipData = chips.map(chip => {
                const r = chip.getBoundingClientRect();
                const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
                const hit = document.elementFromPoint(cx, cy);
                return {
                  visible: r.width > 0 && r.height > 0,
                  left: r.left, right: r.right, top: r.top, bottom: r.bottom,
                  insideBar: r.left >= barRect.left - 1 && r.right <= barRect.right + 1 &&
                             r.top >= barRect.top - 1 && r.bottom <= barRect.bottom + 1,
                  centerHit: chip.contains(hit)
                };
              });
              const overlap = (a, b) => a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
              const chipRects = chips.map(c => c.getBoundingClientRect());
              const sendRect = send.getBoundingClientRect();
              // 以垂直区间重叠聚类行数（chip 高度可能不同，不能用 top 严格相等）。
              let rows = 0;
              chipRects.forEach((r, i) => {
                if (!chipRects.some((o, j) => j < i && overlap(o, r))) rows++;
              });
              const allOneRow = chipRects.every(r => overlap(r, sendRect));
              const settingsRow = bar.querySelector('.composer-settings-row');
              const wrapEnabled = getComputedStyle(bar).flexWrap !== 'nowrap' &&
                getComputedStyle(settingsRow).flexWrap !== 'nowrap';
              resolve({
                overflowX: bar.scrollWidth - bar.clientWidth,
                hostOverflowX: document.getElementById('host').scrollWidth - document.getElementById('host').clientWidth,
                chipCount: chips.length,
                chipData, rows, allOneRow, wrapEnabled
              });
            }, 100));
          `);
          const label = `width=${width}, ${theme}, staged=${staged}`;
          // 容器不允许横向溢出（无裁剪/无越界）。
          assert.ok(result.overflowX <= 1, `${label}: composer-bar 横向溢出 ${result.overflowX}px`);
          assert.ok(result.hostOverflowX <= 1, `${label}: composer 宿主横向溢出 ${result.hostOverflowX}px`);
          // 每个选择器 chip 完整可见、落在容器内、中心点可命中（未被遮挡或裁剪）。
          assert.equal(result.chipCount, staged ? 4 : 2, `${label}: chip 数量不符`);
          result.chipData.forEach((c, i) => {
            assert.ok(c.visible, `${label}: chip#${i} 不可见`);
            assert.ok(c.insideBar, `${label}: chip#${i} 越出 composer-bar 边界`);
            assert.ok(c.centerHit, `${label}: chip#${i} 中心点被遮挡/裁剪`);
          });
          // 换行能力必须始终开启（放不下时自动换行，而非裁剪/溢出）。
          assert.ok(result.wrapEnabled, `${label}: composer-bar/settings-row 未启用 flex-wrap`);
          if (width <= 480 && staged) {
            // 分阶段模式含 4 个控件，窄宽度（右侧停靠列）必须换行/堆叠。
            assert.ok(result.rows >= 2, `${label}: 窄宽度未换行（rows=${result.rows}）`);
          }
          if (width <= 180 && !staged) {
            // 非分阶段模式在极窄停靠列也应换行，避免模型名被压成省略号。
            assert.ok(result.rows >= 2, `${label}: 极窄宽度未换行（rows=${result.rows}）`);
          }
          if (width >= 1280) {
            // 正常宽度下所有控件保持单行，确认无回归。
            assert.ok(result.allOneRow, `${label}: 正常宽度下意外换行`);
          }
          cases++;
        }
      }
    }
    console.log(`通过：${cases} 个 composer-bar 换行/可见性场景（含明暗主题与分阶段模式）`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
});
