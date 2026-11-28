# NexLink

> **新一代现代化 Windows 代理客户端**  
> *融合现代级别的高颜值 UI + 极致自由的全格式多源订阅与剪贴板导入体验*

---

## 🌟 核心理念与特色

目前市面上主流代理客户端各有千秋，但也存在明显痛点：
* **某代理**：界面现代精致、视觉体验优良，但订阅导入相对单一死板，对剪贴板单节点、多格式混合内容无法直接无缝解析，往往依赖第三方在线 subconverter 转换，存在节点与私密密钥泄露风险。
* **某某代理**：订阅与节点导入极为灵活、支持直接复制粘贴各种协议链接，但界面属于传统网格风格，视觉与交互体验相对陈旧。

**NexLink** 旨在融合两者长处，打造兼具顶尖桌面颜值与全格式自由导入体验的新一代代理客户端：

1. **统一全格式多源订阅与智能导入（订阅管理中心）**：
   * 在「订阅管理」页面内置全格式导入能力，支持直接按 `Ctrl + V` 或粘贴导入，无需预先知晓格式。
   * **智能流水线引擎**：自动嗅探内容类型、自动补齐与解码 Base64、自动识别 VMess / VLESS (含 Reality、gRPC、Vision) / Shadowsocks (含 2022 与插件) / Trojan / Hysteria 2 / TUIC / WireGuard / Clash YAML / sing-box JSON / V2Ray JSON。
   * **纯本地无损解析与转换**：100% 本地运算，0 外部 API 依赖，零隐私泄露风险。
   * **可视化导入预览**：导入前提供节点与协议徽标预览、确定性指纹去重以及兼容性提示。

2. **现代化 Windows 视觉体系**：
   * 采用深色与浅色双模式自适应设计，支持随 Windows 系统外观动态切换并同步刷新主题配色。
   * 现代化毛玻璃、卡片化布局、圆角微渐变与细腻动态交互。
   * 首页动态带宽波形仪表盘、今日累计流量统计、一键启停与系统代理切换。

3. **核心守护与原生 Windows 深度整合**：
   * 默认内嵌成熟高效的 **Mihomo Meta (with_gvisor)** 代理核心，支持链式代理、真实并发测速、实时日志监控与内置内核/客户端自动更新。
   * 深度整合 Windows WinINet 系统代理控制（含独立看门狗守护与第三方客户端/PAC 无损恢复），秒级免刷新切换并支持灵活的域名/IP 绕过列表。
   * 支持 **Windows 特权服务模式（Service Mode）** 与 TUN 虚拟网卡模式（混合堆栈），全面接管系统与各应用全局流量。
   * 零断网平滑热重载（Hot Reload）：订阅更新与节点切换优先通过 RESTful API 热加载，保持已有网络连接不断线。
   * 系统托盘（System Tray）支持：关闭窗口最小化至托盘后台驻留，避免误关中断代理；支持开机自启动与静默启动。

---

## 📁 项目目录结构规范

严格遵守模块化、多文件、分目录的架构规范：

```text
NexLink/
├── build/                       # NSIS 安装与卸载守护脚本
├── src/                         # 核心源代码
│   ├── main/                    # 桌面应用主进程
│   │   ├── core/                # 代理核心管理 (Mihomo 启停、守护、REST API、配置生成与预检)
│   │   ├── network/             # 系统网络控制 (WinINet 系统代理、ProxyGuard、TUN 特权服务、UWP)
│   │   ├── services/            # 应用与 Mihomo 内核自动更新服务
│   │   ├── storage/             # 本地持久化存储 (原子文件读写、备份与损坏容灾)
│   │   ├── subscription/        # 订阅全生命周期管理与定时拉取调度
│   │   ├── ipc/                 # 前后端通信 IPC 总线
│   │   └── index.ts             # Electron 主程序入口与系统托盘管理
│   ├── preload/                 # 安全隔离的 Preload IPC 桥接层
│   ├── shared/                  # 主进程与渲染进程共享类型及 IPC 事件契约
│   ├── renderer/                # UI 界面与交互层 (React 18 + TailwindCSS + Lucide)
│   │   ├── pages/               # 各功能主页面
│   │   │   ├── dashboard/       # 首页仪表盘与实时流量
│   │   │   ├── subscriptions/   # 订阅管理与全格式智能导入
│   │   │   ├── nodes/           # 节点列表、链式代理与真实并发测速
│   │   │   ├── profiles/        # 分流规则与 DNS 运行时配置
│   │   │   ├── test/            # 连通性与延迟测试工具
│   │   │   ├── logs/            # 实时内核日志监控
│   │   │   └── settings/        # 系统与客户端设置
│   │   ├── components/          # 公共组件库 (Modal, Button, Input, Switch, Badge)
│   │   ├── layouts/             # 自适应现代化布局 (MainLayout, Titlebar, Sidebar)
│   │   ├── store/               # 界面状态驱动 (Zustand 状态机)
│   │   └── styles/              # 全局样式与毛玻璃深浅主题
│   └── services/                # 核心业务逻辑 (纯 TS 无副作用逻辑引擎)
│       ├── importer/            # 智能导入 (剪贴板识别、嗅探与多源提取)
│       ├── parser/              # 全协议 URI 解析 (vless, vmess, ss, trojan, hy2, tuic...)
│       ├── converter/           # 格式转换引擎 (sing-box, v2ray, clash -> Mihomo)
│       └── node/                # 确定性节点哈希 ID、指纹去重与校验
├── resources/                   # 软件打包与静态资源
│   ├── icons/                   # 软件图标
│   ├── mihomo/                  # Mihomo 内核与 wintun.dll 驱动
│   └── rules/                   # 规则资源 (Country.mmdb, ASN.mmdb, geoip, geosite)
├── tests/                       # 自动化测试套件
├── docs/                        # 项目技术设计与架构文档
├── LICENSE                      # GNU General Public License v3.0 协议全文
└── THIRD_PARTY_NOTICES.md       # 第三方组件与规则数据声明
```

---

## 🛠️ 快速上手与本地开发

### 环境依赖
* Node.js >= 20.0.0
* npm >= 10.0.0
* Windows 10/11 64-bit

### 安装与运行
```bash
# 1. 安装项目依赖
npm install

# 2. 启动开发模式 (包含 Vite 热更新与 Electron 主窗口)
npm run dev

# 3. 运行自动化测试套件
npm test

# 4. 执行代码规范与 TypeScript 静态类型检查
npm run lint
npm run typecheck

# 5. 编译构建生产版本 / 打包 Windows 安装包与便携版
npm run build
npm run dist
```

---

## 📜 开源协议

Copyright (C) 2026 hu-1029

本项目采用 [GNU General Public License v3.0 (GPL-3.0)](LICENSE) 协议开源，第三方组件与规则数据声明详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## 代码签名政策
本项目的 Windows 安装包由 SignPath.io 提供免费代码签名，证书由 SignPath Foundation 颁发（Free code signing provided by SignPath.io, certificate by SignPath Foundation）。签名仅用于证明安装包由本项目构建流程产出，不收集、不上传用户个人信息。
