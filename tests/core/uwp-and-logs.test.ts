import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { uwpToolService } from '../../src/main/services/uwp-tool';
import { MihomoProcessManager } from '../../src/main/core/mihomo-process';

describe('UWP 回环免流与系统日志专项测试', () => {
  test('1. UWP 工具服务能够安全读取应用列表与字段规范', async () => {
    // Windows 环境下调用真实或回退逻辑
    const apps = await uwpToolService.getUwpApps();
    assert.ok(Array.isArray(apps), 'getUwpApps 返回必须是数组');
    
    // 如果系统中有 UWP 应用，断言结构字段规范
    if (apps.length > 0) {
      const first = apps[0];
      assert.ok(typeof first.sid === 'string', 'sid 必须为字符串');
      assert.ok(typeof first.displayName === 'string', 'displayName 必须为字符串');
      assert.ok(typeof first.packageFamilyName === 'string', 'packageFamilyName 必须为字符串');
      assert.ok(typeof first.isExempt === 'boolean', 'isExempt 必须为布尔值');
    }
  });

  test('2. 日志系统在内存中限制最大保留 1000 条，先进先出淘汰', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink_log_test_'));
    const proc = new MihomoProcessManager();
    proc.initialize(tempDir, tempDir);

    // 推送 1200 条日志
    for (let i = 1; i <= 1200; i++) {
      proc.pushLog({
        id: `log-${i}`,
        time: '18:00:00',
        level: 'info',
        message: `测试日志信息 #${i}`,
      });
    }

    const currentLogs = proc.getLogs();
    assert.strictEqual(currentLogs.length, 1000, '内存日志总数必须被严格限制在 1000 条');
    assert.strictEqual(currentLogs[0].message, '测试日志信息 #201', '早于 1000 条的日志必须被按 FIFO 淘汰');
    assert.strictEqual(currentLogs[999].message, '测试日志信息 #1200', '最新一条日志必须为最新推入的内容');

    // 清空日志
    proc.clearLogs();
    assert.strictEqual(proc.getLogs().length, 0, 'clearLogs 必须彻底清空内存日志');

    // 清理临时目录
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('3. 磁盘滚动日志严格执行 7 天过期清理策略 (与其他主流代理客户端一致)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlink_log_retention_'));
    const proc = new MihomoProcessManager();
    proc.initialize(tempDir, tempDir);

    const logDir = path.join(tempDir, 'runtime', 'logs');
    fs.mkdirSync(logDir, { recursive: true });

    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    // 创建 3 天前（未过期）的日志文件
    const freshLogPath = path.join(logDir, 'mihomo-2026-11-05.log');
    fs.writeFileSync(freshLogPath, 'fresh log content');
    const freshTime = new Date(now - 3 * oneDayMs);
    fs.utimesSync(freshLogPath, freshTime, freshTime);

    // 创建 10 天前（已过期）的历史日志文件
    const oldLogPath = path.join(logDir, 'mihomo-2026-10-28.log');
    fs.writeFileSync(oldLogPath, 'expired log content');
    const oldTime = new Date(now - 10 * oneDayMs);
    fs.utimesSync(oldLogPath, oldTime, oldTime);

    // 执行 7 天保留清理
    proc.cleanExpiredLogs(7);

    assert.ok(fs.existsSync(freshLogPath), '3天前的日志文件应当保留');
    assert.ok(!fs.existsSync(oldLogPath), '10天前（超过7天）的过期日志文件应当被自动清除');

    // 清理临时目录
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('4. 验证导航栏与主页面均已完整接入日志模块', () => {
    const sidebarContent = fs.readFileSync(path.resolve('src/renderer/layouts/Sidebar.tsx'), 'utf8');
    const appContent = fs.readFileSync(path.resolve('src/renderer/App.tsx'), 'utf8');

    assert.ok(sidebarContent.includes("'logs'"), 'Sidebar.tsx 必须包含 logs tab');
    assert.ok(sidebarContent.includes('ScrollText'), 'Sidebar.tsx 必须使用 ScrollText 作为日志图标');
    assert.ok(appContent.includes('LogsPage'), 'App.tsx 必须引入 LogsPage 组件');
    assert.ok(appContent.includes("currentTab === 'logs'"), 'App.tsx 必须挂载 logs 页面路由');
  });
});
