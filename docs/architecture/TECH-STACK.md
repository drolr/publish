# 技术栈

当前基线为 Electron + React + TypeScript + Playwright + SQLite。依赖版本以 `package.json` 和 `package-lock.json` 为准，当前开发与打包目标为 Windows x64、Node.js 24、npm 11.17–11.x。

- Electron main：组合根、窗口、生命周期、特权边界。
- React renderer：界面与状态投影。
- 类型化 preload bridge：窄 IPC 白名单和输入/来源校验。
- 应用/领域层：流程、状态、取消、重复执行和恢复规则。
- 基础设施：SQLite、资产文件、Playwright 专用会话、平台适配和本地诊断。
- Vitest、Playwright、ESLint、TypeScript、Prettier：离线验证与工程门。

优先使用运行时能力，避免同一职责引入多个库，不增加通用 DI、插件框架或未来平台依赖。
