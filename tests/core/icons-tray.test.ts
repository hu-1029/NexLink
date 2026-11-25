import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { getTrayIcon, getResourcesDir } from '../../src/main/index';

describe('应用图标与托盘图标多状态切换专项验证 (App & Tray Icons Verification)', () => {
  const resourcesDir = path.resolve(process.cwd(), 'resources');

  it('1. 核心图标资源完整性校验：程序蓝色图标与 TUN 模式绿色图标均存在且大小合法', () => {
    const requiredIcons = [
      'icons/app-icon.ico',
      'icons/icon.ico',
      'icons/app-icon.png',
      'icons/icon.png',
      'icons/tray-blue.png',
      'icons/tray-blue@2x.png',
      'icons/tray-blue.ico',
      'icons/tray-green.png',
      'icons/tray-green@2x.png',
      'icons/tray-green.ico',
      'icons/icon-green.ico',
      'icons/icon-green.png',
      'icons/tray-16.png',
      'icons/tray.png',
    ];

    for (const relPath of requiredIcons) {
      const fullPath = path.join(resourcesDir, relPath);
      assert.ok(fs.existsSync(fullPath), `图标文件必须存在: ${relPath}`);
      const stat = fs.statSync(fullPath);
      assert.ok(stat.size > 200, `图标文件大小异常 (${stat.size} 字节): ${relPath}`);
    }
  });

  it('2. public 静态目录资源校验：favicon 与图标完整供 Vite 打包与 Web 端引用', () => {
    const publicDir = path.resolve(process.cwd(), 'public');
    assert.ok(fs.existsSync(publicDir), 'public 目录必须存在');

    const expectedFiles = [
      'favicon.ico',
      'icon.ico',
      'icon.png',
      'icon-green.ico',
      'icon-green.png',
    ];

    for (const file of expectedFiles) {
      const fullPath = path.join(publicDir, file);
      assert.ok(fs.existsSync(fullPath), `public 文件缺失: ${file}`);
      assert.ok(fs.statSync(fullPath).size > 200, `public 文件大小异常: ${file}`);
    }
  });

  it('3. getTrayIcon 动态模式解析：常规模式返回蓝色托盘图标，TUN 模式返回绿色托盘图标', () => {
    const loadedPaths: string[] = [];
    const mockNativeImage: any = {
      createFromPath: (filePath: string) => {
        loadedPaths.push(filePath);
        return {
          isEmpty: () => false,
          getSize: () => ({ width: 16, height: 16 }),
        };
      },
      createFromDataURL: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 16, height: 16 }),
      }),
    };

    const normalIcon = getTrayIcon(resourcesDir, false, mockNativeImage);
    assert.ok(normalIcon, '常规模式必须成功返回 NativeImage');
    assert.strictEqual(normalIcon.isEmpty(), false, '常规模式托盘图标不可为空');
    assert.ok(
      loadedPaths[0].includes('tray-blue.png'),
      `常规模式必须优先加载蓝色托盘图标，实际为: ${loadedPaths[0]}`
    );

    const tunIcon = getTrayIcon(resourcesDir, true, mockNativeImage);
    assert.ok(tunIcon, 'TUN 模式必须成功返回 NativeImage');
    assert.strictEqual(tunIcon.isEmpty(), false, 'TUN 模式托盘图标不可为空');
    assert.ok(
      loadedPaths[1].includes('tray-green.png'),
      `TUN 模式必须优先加载绿色托盘图标，实际为: ${loadedPaths[1]}`
    );

    const normalSize = normalIcon.getSize();
    const tunSize = tunIcon.getSize();
    assert.strictEqual(normalSize.width, 16, '常规托盘图标基准尺寸必须为 16');
    assert.strictEqual(normalSize.height, 16, '常规托盘图标基准高度必须为 16');
    assert.strictEqual(tunSize.width, 16, 'TUN 模式托盘图标基准尺寸必须为 16');
    assert.strictEqual(tunSize.height, 16, 'TUN 模式托盘图标基准高度必须为 16');
  });

  it('4. index.html 与 Titlebar.tsx 图标引用验证', () => {
    const indexHtml = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf-8');
    assert.ok(indexHtml.includes('<link rel="icon"'), 'index.html 必须包含 favicon 关联标签');

    const titlebarTsx = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/layouts/Titlebar.tsx'),
      'utf-8'
    );
    assert.ok(
      titlebarTsx.includes('import appIcon from'),
      'Titlebar.tsx 必须引入真实应用图标'
    );
    assert.ok(
      titlebarTsx.includes('<img src={appIcon}'),
      'Titlebar.tsx 必须渲染真实应用图标元素'
    );
  });
});
