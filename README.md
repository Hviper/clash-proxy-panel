# Clash Proxy Panel

用于管理 Clash Verge / Mihomo 多订阅 provider、代理组与独立监听端口的本地桌面面板。面板仅在用户主动调用“应用配置”或“回滚”接口时才会写入 Clash Verge 的 `Script.js`。

## 开发与桌面启动

```bash
npm install
npm start             # 启动 Electron 桌面应用
npm run start:web     # 仅启动本机 Express Web 服务（默认 127.0.0.1:3690）
npm test              # 运行测试
npm run build:assets  # 构建本地 Vue、Lucide 与 Tailwind 资源
```

Electron 启动后在 `127.0.0.1` 的随机端口托管页面与 API，且每次启动都会生成新的 API token。渲染页只能通过 `window.desktop.request('/api/...')` 经 preload 和主进程访问 API；token 不会暴露到页面。Web 模式不启用此 token，以兼容原有本机开发流程。

桌面模式安全边界：禁用 Node integration、开启 context isolation 与 sandbox；禁止外部导航、新窗口、权限请求与外部资源请求；仅允许 Electron 主窗口主 frame 发起 IPC。

配置保存在 Electron `userData/config.json`。首次桌面启动时，如果该文件不存在，会迁移旧开发目录的 `data/config.json`；该文件不会被包含在发行包中。

## macOS arm64 打包

```bash
npm run build:mac
```

产物为免签名的目录应用：`release/mac-arm64/Clash Proxy Panel.app`。该构建适合本机测试；因未配置 Apple Developer ID 签名和公证，其他 Mac 首次打开可能需要通过系统安全设置确认。

可选 DMG：

```bash
npm run build:dmg
```

若要公开分发，请配置 Developer ID Application 证书并完成 Apple notarization；本项目默认不尝试签名或公证。

## 配置应用与回滚

`POST /api/apply` 会：

1. 按 Script.js 的两个托管标记生成订阅、代理组与监听器段；
2. 用内置 `node:vm` 编译校验 JavaScript 语法（打包后不依赖外部 `node --check`）；
3. 在 Script.js 同目录创建备份；
4. 使用临时文件加 `rename` 原子写回；
5. 刷新已配置 provider，并检测面板端口。

代理组和监听器可能仍需 Clash Verge 重新生成运行时配置后才会出现在 Mihomo 中。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 内核状态、版本、当前配置、端口存活 |
| GET/POST/DELETE | `/api/subscriptions` | 订阅管理 |
| POST | `/api/subscriptions/:id/refresh` | 刷新订阅 |
| GET | `/api/nodes` | provider 节点列表 |
| GET/POST/DELETE | `/api/groups` | 代理组管理 |
| POST | `/api/groups/:name/delay` | 代理组测速 |
| POST | `/api/groups/:name/select` | 切换组内节点 |
| GET/POST/DELETE | `/api/listeners` | 监听器管理 |
| GET | `/api/test-port?port=7891` | 检测端口 |
| POST | `/api/apply` | 写入托管段并刷新 provider |
| GET | `/api/backups` | 备份列表 |
| POST | `/api/backups/restore` | 回滚指定备份 |

## 安全边界

- Web 服务仅绑定 `127.0.0.1`，拒绝非本机 Host 和跨站 Origin。
- Electron 模式的 `/api` 需每次启动随机 token；token 只由主进程向内部 loopback 请求添加。
- 默认配置不含订阅 URL、token 或 Mihomo secret；Mihomo secret 只从本机 Clash Verge 配置读取，未配置时不发送 Authorization 头。
- 回滚文件名限制为 `Script.js.bak-panel-*`，防止路径穿越。
