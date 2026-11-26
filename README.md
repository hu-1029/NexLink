# NexLink

> **新一代现代化 Windows 代理客户端**  
> *融合现代级别的高颜值 UI + 极致自由的全格式多源订阅与剪贴板导入体验*

---

## 🌟 核心理念与特色

目前市面上主流代理客户端各有千秋，但也存在明显痛点：
* **某代理**：界面现代精致、视觉体验优良，但订阅导入相对单一死板，对剪贴板单节点、多格式混合内容无法直接无缝解析，往往依赖第三方在线 subconverter 转换，存在节点与私密密钥泄露风险。
* **某某代理**：订阅与节点导入极为灵活、支持直接复制粘贴各种协议链接，但界面属于传统网格风格，视觉与交互体验相对陈旧。

**NexLink** 旨在融合两者长处，打造兼具顶尖桌面颜值与全格式自由导入体验的新一代代理客户端：

1. **统一全格式智能导入中心 (Smart Import Hub)**：
   * 支持进入客户端直接按 `Ctrl + V` 或粘贴导入，无需预先知晓格式。
   * **智能流水线引擎**：自动嗅探内容类型、自动补齐与解码 Base64、自动识别 VMess / VLESS (含 Reality、gRPC、Vision) / Shadowsocks (含 2022 与插件) / Trojan / Hysteria 2 / TUIC / WireGuard / Clash YAML / sing-box JSON / V2Ray JSON。
   * **纯本地无损解析与转换**：100% 本地运算，0 外部 API 依赖，零隐私泄露风险。
   * **可视化导入工作台**：导入前提供参数预览、协议彩色徽标、指纹节点去重以及兼容性提示。

2. **现代化 Windows 视觉体系 **：
   * 采用深色与浅色双模式自适应设计，告别黑白杂糅与反光刺眼。
   * 现代化毛玻璃 、卡片化布局、圆角微渐变与细腻动态交互。
   * 首页动态带宽波形仪表盘、今日累计流量统计、一键启停与系统代理切换。

3. **核心守护与原生 Windows 深度整合**：
   * 默认内嵌成熟高效的 **Mihomo Meta (with_gvisor)** 代理核心，保证出站性能与全协议兼容。
   * 深度整合 Windows WinINet 系统代理控制，秒级免刷新切换并支持灵活的域名/IP 绕过列表。
   * 支持 Windows TUN 虚拟网卡模式（混合堆栈），全面接管系统与各应用全局流量。
   * 零断网平滑热重载（Hot Reload）：订阅更新与节点切换优先通过 RESTful API 热加载，保持已有网络连接不断线。
   * 系统托盘（System Tray）支持：关闭窗口最小化至托盘后台驻留，避免误关中断代理；支持开机自启动与静默启动。

---

## 📁 项目目录结构规范

严格遵守模块化、多文件、分目录的架构规范：

```text
NexLink/
├── src/                         # 核心源代码
│   ├── main/                    # 桌面应用主进程
│   │   ├── core/                # 代理核心管理 (Mihomo 启停、守护、REST API、配置生成与预检)
│   │   ├── network/             # 系统网络控制 (WinINet 系统代理、TUN 网卡检测与提权)
│   │   ├── storage/             # 本地持久化存储 (原子文件读写、备份与损坏容灾)
│   │   ├── subscription/        # 订阅全生命周期管理与定时拉取调度
│   │   ├── ipc/                 # 前后端通信 IPC 总线
│   │   └── index.ts             # Electron 主程序入口与系统托盘管理
│   ├── renderer/                # UI 界面与交互层 (React 18 + TailwindCSS + Lucide)
│   │   ├── pages/               # 各功能主页面
│   │   │   ├── dashboard/       # 首页仪表盘与实时流量
│   │   │   ├── subscriptions/   # 订阅管理中心
│   │   │   ├── nodes/           # 节点列表与真实并发测速
│   │   │   ├── profiles/        # 分流规则与 DNS 运行时配置
│   │   │   ├── settings/        # 系统与客户端设置
│   │   │   └── import/          # 智能导入中心
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
└── docs/                        # 项目技术设计与架构文档
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

# 4. 执行 TypeScript 静态类型检查
npm run typecheck

# 5. 编译构建生产版本
npm run build
```

---

## 📜 开源协议

本项目采用 [MIT 许可证](LICENSE) 进行开源。
