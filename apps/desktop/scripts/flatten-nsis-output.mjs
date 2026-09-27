import { readdir, rename, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * electron-builder afterAllArtifactBuild 钩子
 * 将 nsis-web/${version}/ 子目录中的 exe 安装包移动到根目录，实现扁平化结构
 * 
 * 打包后默认结构：
 *   nsis-web/
 *     ├── 0.1.19/
 *     │   └── OwnCoder Web Setup 0.1.19.exe
 *     ├── @owncoderdesktop-0.1.19-x64.nsis.7z
 *     └── latest.yml
 * 
 * 扁平化后结构：
 *   nsis-web/
 *     ├── OwnCoder Web Setup 0.1.19.exe
 *     ├── @owncoderdesktop-0.1.19-x64.nsis.7z
 *     └── latest.yml
 */
export default async function flattenNsisOutput(buildResult) {
  const { outDir, artifactPaths } = buildResult;

  // 查找 nsis-web 输出目录
  const nsisWebDir = join(outDir, 'nsis-web');
  
  try {
    const entries = await readdir(nsisWebDir, { withFileTypes: true });
    
    // 查找版本号子目录（数字开头的目录）
    const versionDir = entries.find(
      entry => entry.isDirectory() && /^\d+\.\d+\.\d+/.test(entry.name)
    );

    if (!versionDir) {
      console.log('[flatten-nsis-output] 未找到版本号子目录，跳过扁平化');
      return;
    }

    const versionDirPath = join(nsisWebDir, versionDir.name);
    const filesInVersionDir = await readdir(versionDirPath);

    // 移动版本号子目录中的所有文件到根目录
    for (const fileName of filesInVersionDir) {
      const srcPath = join(versionDirPath, fileName);
      const destPath = join(nsisWebDir, fileName);
      
      await rename(srcPath, destPath);
      console.log(`[flatten-nsis-output] 移动: ${versionDir.name}/${fileName} -> ${fileName}`);
    }

    // 删除空的版本号子目录
    await rmdir(versionDirPath).catch(() => {
      // 目录可能不为空或已被删除，忽略错误
    });
    
    console.log(`[flatten-nsis-output] 已删除空目录: ${versionDir.name}`);
    console.log('[flatten-nsis-output] ✓ 目录结构扁平化完成');
    
  } catch (error) {
    console.error('[flatten-nsis-output] 扁平化失败:', error.message);
    // 不阻断打包流程
  }
}
