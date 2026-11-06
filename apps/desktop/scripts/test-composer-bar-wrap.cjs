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
        <span class="model-chip-label">claude-sonnet-4-5-20250929</span>
        <span class="mode-chevron" aria-hidden="true">▾</span>
      </button>
    </div>`;
  const decomposerThinking = `
    <div class="thinking-picker">
      <button type="button" class="thinking-chip">
        <span class="mode-chevron" aria-hidden="true">▾</span>
      </button>
    </div>`;
  const reactGroup = staged
    ? `<div class="model-group model-group-react">
        <div class="model-picker model-picker-react">
          <button type="button" class="model-chip model-chip-react">
            <span class="model-chip-label">gpt-5.1-codex-2025-11</span>
            <span class="mode-chevron" aria-hidden="true">▾</span>
          </button>
        </div>
        <div class="thinking-picker thinking-picker-react">
          <button type="button" class="thinking-chip thinking-chip-react">
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
      <div class="model-group model-group-decomposer">
        ${decomposerModel}
        ${decomposerThinking}
      </div>
      ${reactGroup}
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
              // 以所有可见 flex 子项（排除隐藏的文件 input）聚类视觉行数，
              // 堆叠场景下每个模型组整体只占一行，避免组内 chip 同行导致少计。
              const flexItems = [...bar.children].filter(el => getComputedStyle(el).display !== 'none');
              const itemRects = flexItems.map(el => el.getBoundingClientRect());
              let itemRows = 0;
              itemRects.forEach((r, i) => {
                if (!itemRects.some((o, j) => j < i && overlap(o, r))) itemRows++;
              });
              const wrapEnabled = getComputedStyle(bar).flexWrap !== 'nowrap';
              // 换行顺序：分解组与发送按钮同行、执行组独占第二行；发送按钮锚定第一行右侧。
              const decomposerGroup = bar.querySelector('.model-group-decomposer');
              const reactGroupEl = bar.querySelector('.model-group-react');
              const uploadEl = bar.querySelector('.upload-trigger');
              const decRect = decomposerGroup.getBoundingClientRect();
              const reactRect = reactGroupEl ? reactGroupEl.getBoundingClientRect() : null;
              const uploadRect = uploadEl.getBoundingClientRect();
              resolve({
                barWidth: bar.clientWidth,
                overflowX: bar.scrollWidth - bar.clientWidth,
                hostOverflowX: document.getElementById('host').scrollWidth - document.getElementById('host').clientWidth,
                chipCount: chips.length,
                chipData, rows: itemRows, allOneRow, wrapEnabled,
                decWithSend: overlap(decRect, sendRect),
                reactWithSend: reactRect ? overlap(reactRect, sendRect) : null,
                reactAfterDec: reactRect ? reactRect.top >= decRect.bottom - 0.5 : null,
                uploadWithSend: overlap(uploadRect, sendRect),
                uploadAfterReact: reactRect ? uploadRect.top >= reactRect.bottom - 0.5 : null,
                sendRightGap: barRect.right - sendRect.right
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
          assert.ok(result.wrapEnabled, `${label}: composer-bar 未启用 flex-wrap`);
          // 发送/暂停按钮始终锚定本行最右侧。
          assert.ok(result.sendRightGap === null || result.sendRightGap <= 2,
            `${label}: 发送按钮未锚定右侧（距右边 ${result.sendRightGap}px）`);
          // 以容器（composer-bar）实际宽度判定布局，与 CSS 断点保持一致。
          const bw = result.barWidth;
          if (bw <= 640 && staged) {
            // 分阶段窄宽度（打开文件停靠右侧）：核心两行顺序必须始终成立——
            // 第一行 = 模式 + 任务分解模型组 + 发送/暂停按钮，第二行 = 执行模型组。
            assert.ok(result.decWithSend, `${label}: 任务分解组未与发送按钮同行`);
            assert.equal(result.reactWithSend, false, `${label}: 执行组不应与发送按钮同行`);
            assert.equal(result.reactAfterDec, true, `${label}: 执行组未落到分解组之后的第二行`);
            if (bw <= 300) {
              // ≤300px：次要的上传按钮移到执行组之后（第三行），为模型名让出宽度。
              assert.equal(result.uploadWithSend, false, `${label}: 窄宽度上传按钮未离开第一行`);
              assert.equal(result.uploadAfterReact, true, `${label}: 上传按钮未落到执行组之后`);
            } else {
              // 中等窄宽度：上传按钮仍留在第一行。
              assert.ok(result.uploadWithSend, `${label}: 上传按钮应与发送按钮同行`);
            }
          } else if (bw <= 640) {
            // 非分阶段窄宽度：无执行组。≤300px 时上传按钮整宽换到下一行，
            // 保证「模式 + 分解组 + 发送按钮」第一行完整、发送锚右；
            // 更宽时上传按钮保留在第一行。
            if (bw <= 300) {
              assert.equal(result.uploadWithSend, false, `${label}: 非分阶段窄宽度上传按钮未离开第一行`);
            } else {
              assert.ok(result.uploadWithSend, `${label}: 上传按钮应与发送按钮同行`);
            }
          } else {
            // 宽度足够：所有控件保持单行。
            assert.ok(result.allOneRow, `${label}: 宽度 ${bw} 下意外换行`);
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
