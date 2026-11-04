/**
 * 内置 MSYS2 运行时的固定配置（唯一事实来源）。
 *
 * 背景：桌面端随包携带裁剪后的 MSYS2（bash + coreutils/grep/sed/gawk/
 * findutils 等），使 Windows 上 harness 的 bash tool 与 run_script 沙箱的
 * 字符串命令获得确定性的 POSIX 环境，不依赖用户机器预装 Git Bash/WSL。
 *
 * 约定（与上游 ZCode native-search-tools 同纪律）：
 * - base 归档固定版本 + SHA-256，prepare 时强制校验，任何不匹配中止构建；
 * - 归档入 git（dependencies/msys2/），干净构建不依赖网络；
 * - pacman 仅在 base 缺包时补装（构建期行为，产物不含 pacman 套件）。
 */

export const MSYS2_RUNTIME = {
  /** base 快照日期版本（msys2-base-x86_64-<version>.tar.xz）。 */
  version: "20260927",
  /** base 归档固定 SHA-256（首次自官方镜像下载后钉死，后续构建强制校验）。 */
  archiveSha256: "ea2f31a0b6ade63914ce441ffb022f0f6aa96982bfefa2326460a26d5fb01322",
  /** 归档下载源（按序尝试；本地 dependencies/msys2/ 命中则不下载）。 */
  downloadBaseUrls: [
    "https://repo.huaweicloud.com/msys2/distrib/x86_64",
    "https://repo.msys2.org/distrib/x86_64",
  ],
  /**
   * 运行时必须存在的文件（相对 <root>，base 自带）。缺失即构建失败——
   * 这是"随包保证"的契约清单。
   */
  requiredFiles: [
    "usr/bin/bash.exe",
    "usr/bin/sh.exe",
    "usr/bin/msys-2.0.dll",
    "usr/bin/grep.exe",
    "usr/bin/sed.exe",
    "usr/bin/gawk.exe",
    "usr/bin/find.exe",
    "usr/bin/cat.exe",
    "usr/bin/ls.exe",
    "usr/bin/head.exe",
    "usr/bin/tail.exe",
    "usr/bin/wc.exe",
    "usr/bin/sort.exe",
    "usr/bin/xargs.exe",
    "usr/bin/gzip.exe",
    "usr/bin/tar.exe",
    "usr/bin/which.exe",
    "usr/bin/curl.exe",
  ],
  /**
   * base 缺失、需 pacman 构建期补装的文件（diffutils 包）。补装失败仅
   * 告警并从产物剔除（模型可用 git diff --no-index / cmp 替代），
   * 不中止构建。
   */
  extraPackageFiles: ["usr/bin/diff.exe", "usr/bin/diff3.exe", "usr/bin/sdiff.exe"],
  /** base 缺失、需 pacman 补装的包。 */
  extraPackages: ["diffutils"],
  /** pacman 补装用的镜像 Server 列表（按序）。 */
  pacmanServers: [
    "https://mirrors.tuna.tsinghua.edu.cn/msys2/msys/$arch",
    "https://repo.huaweicloud.com/msys2/msys/$arch",
    "https://repo.msys2.org/msys/$arch",
  ],
  /**
   * 裁剪清单（相对 <root>）。base 解包 ~253MB，裁剪后目标 <80MB。
   * 只删"运行期用不到且删除安全"的部分；usr/bin 保留核心工具全家桶
   * （可预测性优先，模型命令面不因裁剪而出现意外缺口）。
   */
  trimDirs: [
    "usr/share/locale", // 63MB 消息目录，POSIX 命令非交互不需要
    "usr/share/man", // 14MB
    "usr/share/info", // 3.6MB
    "usr/share/doc", // 6.8MB（许可在 usr/share/licenses，独立保留）
    "usr/share/bash-completion", // 5.1MB 非交互
    "usr/share/misc", // 11MB magic.mgc（file 降级，harness 不用）
    "usr/share/mintty", // 3MB 无头运行不需要终端模拟器
    "usr/share/terminfo", // 9.1MB 无 tty，less 退化为 dumb 亦可
    "usr/lib/terminfo", // 9.1MB 同上
    "mingw32", // 空骨架目录
    "mingw64",
    "ucrt64",
    "clang64",
    "clangarm64",
    "var/lib/pacman/sync", // 仓库同步 db（~3MB），许可/版本信息在 local
    "var/cache",
    "opt", // 空目录/孤儿依赖
  ],
  /** 根目录启动器/维护脚本/ini 配置（mintty 拉起器、autorebase、各 shell ini）。 */
  trimRootFiles: [
    "msys2.exe",
    "mingw32.exe",
    "mingw64.exe",
    "ucrt64.exe",
    "clang64.exe",
    "clangarm64.exe",
    "msys2.ico",
    "mingw32.ico",
    "mingw64.ico",
    "ucrt64.ico",
    "clang64.ico",
    "clangarm64.ico",
    "autorebase.bat",
    "postinstall/*",
    "msys2_shell.cmd", // mintty 拉起辅助
    "msys2.ini",
    "mingw32.ini",
    "mingw64.ini",
    "ucrt64.ini",
    "clang64.ini",
    "clangarm64.ini",
  ],
  /**
   * usr/bin 中随包但运行期不需要的套件（harness 无 gpg 交互场景；
   * pacman 套件在裁剪前已用于补装 diffutils，此时一并移除）。
   */
  trimBins: [
    "pacman.exe",
    "pacman-conf.exe",
    "pactree.exe",
    "testpkg.exe",
    "makewhatis.exe",
    "gpg.exe",
    "gpgv.exe",
    "gpgsm.exe",
    "gpg-agent.exe",
    "gpgconf.exe",
    "gpg-connect-agent.exe",
    "gpgparsemail.exe",
    "kbxutil.exe",
    "dirmngr.exe",
    "dirmngr-client.exe",
    "pinentry.exe",
    "pinentry-curses.exe",
    "pinentry-gnome3.exe",
    "pinentry-qt.exe",
    "wget.exe", // curl 已在，wget 冗余
    "nano.exe", // 无头 harness 不做交互编辑
    "flock.exe",
    "nice.exe",
    "tsort.exe",
  ],
  /** 体积门禁：裁剪后超过该值（MB）prepare 告警并失败，需复议策略。 */
  maxTrimmedSizeMiB: 80,
};

export function msys2ArchiveName() {
  return `msys2-base-x86_64-${MSYS2_RUNTIME.version}.tar.xz`;
}
