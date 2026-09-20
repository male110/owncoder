# OwnCoder 发布流程

## 背景

安装包从 0.1.9（~99M）涨到 0.1.10（~165M），主要因为引入 `@xenova/transformers` + `sqlite-vec` 拉入了 `onnxruntime-node` (92M) + `sharp` (50M)。**Gitee 单文件上传上限 100M**，所以 165M 的全量包放不上去了。

采用方案：**NSIS Web Installer + Aliyun OSS / 腾讯 COS 全量分发**。

## 产物分布

```
[Gitee Release 页]                          [OSS 桶]
  ↓ 用户下载 679KB 引导器                     https://<bucket>.<endpoint>/<prefix>/
  ↓                                          ├── latest.yml                                    (更新清单)
OwnCoder Web Setup 0.1.10.exe    →           ├── 0.1.10/
  ↓ (引导器 UI,运行时拉取)                     │   ├── @owncoderdesktop-0.1.10-x64.nsis.7z        (165M 全量)
  ↓ 拉到完整安装包并执行安装                    │   └── OwnCoder Web Setup 0.1.10.exe             (679K,OSS 镜像)
                                              ├── 0.1.9/
                                              │   ├── OwnCoder Setup 0.1.9.exe                   (99M,差量基线)
                                              │   └── OwnCoder Setup 0.1.9.exe.blockmap
                                              └── 0.1.10-0.1.11.delta                            (升级用差量,首发无)
```

- **引导器**（679KB）→ Gitee release 资产（满足 100M 上限）
- **全量包 + 差量 + 清单** → OSS（无单文件大小限制）
- 升级流程：`electron-updater` 拉 OSS 上的 `latest.yml`，发现新版本后优先下 `.delta`（5-30M），找不到再回退下全量 `.7z`。

## 发布步骤

### 1. 一次性 OSS 桶初始化（运维）

- 创建 OSS 桶，公共读
- 配置 CORS：允许 GET 来源 `https://gitee.com`、`https://gitee.io`、自家站点
- 推荐挂 CDN 自定义域名 + HTTPS 证书
- 在 `apps/desktop/package.json` 的 `build.publish.url` 填入 CDN 域名（替换 `PLACEHOLDER` 占位符）

### 2. 准备本地凭据

复制 `apps/desktop/scripts/publish-release.example.env` 为本地 `.env`，填入：

```bash
OSS_ACCESS_KEY_ID=...
OSS_ACCESS_KEY_SECRET=...
OSS_BUCKET=owncoder-releases
OSS_REGION=oss-cn-hangzhou
OSS_ENDPOINT=oss-cn-hangzhou.aliyuncs.com
OSS_PATH_PREFIX=owncoder

# 可选:Gitee release 自动上传
GITEE_TOKEN=...
GITEE_OWNER=f6688
GITEE_REPO=owncoder
```

### 3. 打包

```bash
pnpm --filter @owncoder/desktop pack:win
```

产物在 `apps/desktop/release/`：

```
nsis-web/
├── OwnCoder Web Setup 0.1.10.exe              # 引导器(679K)→ Gitee
├── @owncoderdesktop-0.1.10-x64.nsis.7z       # 全量(165M)→ OSS
└── latest.yml                                # 更新清单 → OSS
```

### 4. 上传

```bash
source .env
pnpm --filter @owncoder/desktop publish:oss
```

脚本行为：
- 全量包 + latest.yml → OSS 对应版本目录 + 根目录
- Web installer → OSS（同步）+ Gitee release（如果给了 `GITEE_TOKEN`）
- 完成后打印 Gitee release URL，方便手动补传

**首次发版前**：先把 0.1.9 的全量 `OwnCoder Setup 0.1.9.exe` 也同步到 OSS（作为后续差量基线）。

### 5. 在 Gitee release 页确认

访问 `https://gitee.com/<owner>/<repo>/releases/tag/v0.1.10`，确认引导器资产已上传（脚本自动做了）。

## 差量更新什么时候生效

`differentialPackage: true` 已配置，但**单次 `pack:win` 不会自动产出 `.delta`**——electron-builder 需要在打包时拿到"上一版全量"作为基线。

**做法**：
- 每次发版前，把 `apps/desktop/release/nsis-web/@owncoderdesktop-<prev>-x64.nsis.7z` 拷贝到 `apps/desktop/release/` 下
- 跑 `pack:win` 时，electron-builder 会自动产出 `<prev>-<current>.delta`（5-30M）
- 把 delta 也上传到 OSS 的 `0.1.<current>/` 目录
- 用户的 `electron-updater` 拉 `latest.yml` 时，如果文件列表里包含 `<prev>-<current>.delta`，就会走差量

## 自动升级走的是什么

`apps/desktop/src/main/updates.ts` 已改用 `electron-updater.NsisUpdater`：

- 启动期 `app.whenReady()` 8 秒后首次检查
- 每 4 小时复检
- 渲染端 IPC 协议保持不变（`UpdateCheckOutcomeDto` / `UpdateDownloadStatusDto`）
- 只在打包版 Windows 生效（dev / 其他平台静默跳过）

## 失败兜底

- 引导器拉 OSS 失败 → 用户可手动下载 OSS 上的全量 `.7z` 本地双击
- `electron-updater` 拉 `latest.yml` 失败 → 老的 Gitee 硬编码路径作为回退（仍然在 `apps/desktop/src/main/updates.ts` 里保留 URL 字符串）
- 差量应用失败 → 自动回退下全量

## 文件清单

| 文件 | 作用 |
|---|---|
| `apps/desktop/package.json` | `nsis-web` target + `publish.generic` provider + `electron-updater` 依赖 + `publish:oss` 脚本 |
| `apps/desktop/src/main/updates.ts` | 改为使用 `electron-updater.NsisUpdater` |
| `apps/desktop/scripts/publish-release.mjs` | OSS + Gitee 上传脚本 |
| `apps/desktop/scripts/publish-release.example.env` | 环境变量样例 |
| `apps/desktop/scripts/after-pack.mjs` | 已有,删除多余 locale/DLL/跨平台 prebuild |

## 验证清单

- [ ] `pnpm pack:win` 产出包含 `OwnCoder Web Setup *.exe`（< 1MB）+ `*.nsis.7z` + `latest.yml`
- [ ] `latest.yml` 里 `packages.x64.path` 指向 `.nsis.7z`，sha512 正确
- [ ] 把引导器和 7z 都放到 OSS 临时桶，本地双击引导器完成安装
- [ ] 装完后启动应用，日志可见 `checkForUpdates` 触发 + `latest.yml` 解析
- [ ] 模拟一次升级（OSS 上传新全量 + delta），客户端走差量下载
- [ ] Gitee release 上确认引导器 ≤ 100M