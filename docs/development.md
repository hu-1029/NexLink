# NexLink 开发规范与指南 (Development Guide)

## 一、开发环境要求

* **操作系统**：Windows 10 / 11 64-bit
* **Node.js**：>= 20.0.0
* **包管理器**：npm >= 10.0.0

---

## 二、代码风格与架构纪律

1. **严格 TypeScript 类型安全**：
   * 严禁在核心逻辑中滥用 `any`；
   * 所有数据模型与前后端通信载荷均需在 `src/shared/types.ts` 和 `src/shared/ipc-events.ts` 中完成类型定义。

2. **模块职责隔离**：
   * `src/services`：只能包含纯 TypeScript 逻辑，严禁直接依赖 Electron 主进程 API 或 React UI 状态，确保 100% 具备单测能力。
   * `src/main`：负责系统级交互（Mihomo 进程控制、Windows 注册表系统代理、系统托盘、文件持久化）。
   * `src/renderer`：负责 UI 表现，通过 `window.nexlinkAPI` 调用主进程功能。

3. **安全准则**：
   * 严禁在主进程拼接未经校验的命令字符串执行 Shell；
   * 监听地址必须严格遵循最小权限原则（如未开启局域网共享时，仅监听 `127.0.0.1`）；
   * 任何可能涉及不可逆改动的写入操作必须具备原子性（`.tmp` 写入后原子替换，并维护 `.bak` 副本）。

---

## 三、常用命令速查

```bash
# 安装依赖
npm install

# 启动开发服务器与 Electron 应用
npm run dev

# 运行自动化测试套件
npm test

# 执行 TypeScript 静态类型检查
npm run typecheck

# 构建生产版本安装包
npm run build
```
