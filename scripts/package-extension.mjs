import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..');
const manifestPath = join(projectRoot, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const outputDirectory = join(projectRoot, 'dist');
const stagingDirectory = join(outputDirectory, 'extension');
const safeName = manifest.name.replace(/[^\p{L}\p{N}._-]+/gu, '-');
const archivePath = join(outputDirectory, `${safeName}-v${manifest.version}.zip`);

// 只复制扩展运行时文件，避免把测试、文档和版本控制信息带入发布包。
const runtimeFiles = [
  'manifest.json',
  'assets',
  'src',
];

function assertRuntimeFiles() {
  const missing = runtimeFiles.filter((entry) => !existsSync(join(projectRoot, entry)));
  if (missing.length) {
    throw new Error(`扩展运行文件不存在：${missing.join(', ')}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败（退出码 ${result.status}）。`);
}

assertRuntimeFiles();
mkdirSync(outputDirectory, { recursive: true });
rmSync(stagingDirectory, { recursive: true, force: true });
mkdirSync(stagingDirectory, { recursive: true });

// 使用 cp 保留目录结构，再从暂存目录生成稳定的 ZIP 根路径。
run('cp', ['-R', ...runtimeFiles, stagingDirectory]);
rmSync(archivePath, { force: true });
run('zip', ['-qr', archivePath, '.'], { cwd: stagingDirectory });
rmSync(stagingDirectory, { recursive: true, force: true });

const archiveRelativePath = relative(projectRoot, archivePath);
console.log(`已生成扩展安装包：${archiveRelativePath}`);
