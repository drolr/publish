# 汽车经销商草稿助手

面向汽车经销商内容运营的本地桌面工程，使用 Electron、React、TypeScript、Playwright 和 SQLite。首个平台适配边界是巨懂车商家后台。

当前包含文章导入、手工编辑、图文顺序保存、文章列表与分页、本地封面配置、单篇和顺序批量草稿流程，以及停止、重启恢复和异常暂停机制。平台提交结果需要运营人员在后台核对；本仓库不承诺所有页面版本、账号或门店均可直接使用。

这是经过隐私整理的源码快照。私人平台会话、真实文章、数据库、图片、验收截图、运行日志、安装备份和历史审批记录均未公开。源码中原有的特定门店绑定和历史任务恢复批准也已移除，公开版本不会继承原账号的操作授权。详见[发布范围与隐私说明](docs/PUBLICATION.md)。

## 开发环境

当前构建目标为 Windows x64。需要 Node.js 24.x 和 npm 11.17–11.x；依赖以 `package-lock.json` 为准。

```powershell
npm ci
npm run check
npx playwright install chromium --only-shell
npm run test:fixture
npm run test:renderer
npm start
```

`npm run check` 包含格式、lint、严格类型检查、架构边界、迁移顺序和单元/集成/契约测试。浏览器 fixture 使用合成页面并禁止外部网络；正常 CI 不连接真实商家后台。

## 构建与打包

```powershell
npm run test:dev
npm run make
npm run test:desktop
npm run test:package
npm audit
```

`make` 生成 Windows x64 ZIP。桌面及打包测试使用临时数据目录，需要对应构建产物和可运行的 Electron。首次安装可能需要下载 Electron 和 Playwright 浏览器。原生依赖固定为锁文件版本，升级 Electron、SQLite、图像库或打包链后需要重新验证。

依赖审计是独立质量门。来源工程此前记录过开发依赖高危告警，本次隐私整理没有升级依赖或降低审计门槛；CI 中的 `npm audit` 可能因此失败，应以当前审计结果为准。

## 本地数据与平台使用

SQLite、文章图片和专用浏览器会话保存在应用自己的本地数据目录。不要将数据目录、Cookie、平台会话、备份、诊断导出或含真实内容的截图提交到 Git。登录和安全验证由人工完成；不使用日常浏览器配置，也不绕过验证码或风控。

公开源码移除了私有门店和历史任务授权，相关平台流程可能保持“需要人工处理/平台暂停”。接入自己的真实账号前，应阅读平台适配代码、确认页面契约，并对账号、门店、测试内容和单次操作范围进行独立验证。离线测试通过不代表真实草稿已保存。

历史私人备份未包含在仓库。schema6 备份测试默认跳过；如需在本地自愿运行，可将 `DRAFT_ASSISTANT_SCHEMA6_BACKUP` 指向符合 fixture 契约的只读备份目录。常规合成迁移测试仍正常运行。

## 工程导航

- [文档入口](docs/README.md)
- [产品范围](docs/product/PROJECT.md)
- [架构与安全边界](docs/architecture/ARCHITECTURE.md)
- [开发规则](AGENTS.md)
- [Article Package 示例](tests/fixtures/article-packages/mixed.json)

`package.json` 当前标记为 `UNLICENSED`，仓库尚未授予开源许可证。
