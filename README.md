# Holaman

Holaman 是一个桌面端 API 调试工具，目标是在 Windows 11 和 macOS Apple Silicon 上提供本地优先、响应迅速、界面克制的 API 工作台体验。

应用基于 Tauri 2、React、TypeScript、Rust 和 SQLite 构建。打开应用后默认进入工作台，而不是营销首页。

## 功能概览

- 请求工作台：支持多 API tab、请求方法、URL、Params、Headers、Body、Mock、脚本和请求文档。
- 响应查看：支持响应体、响应头、原始响应、Cookie、测试占位和时间线。
- 集合管理：支持集合、子集合、API 右键菜单、复制粘贴、导入导出和拖拽移动。
- 环境变量：支持创建、编辑、删除环境，并在请求中选择当前环境。
- Mock：在请求功能区内配置本地 Mock 响应。
- 脚本：支持请求前脚本、响应后脚本、日志、`console` 输出、`expect` 断言和环境变量写入。
- 整体日志：右侧日志持久化记录请求、响应、Mock、脚本和错误，完整保存请求体与响应体。
- 本地存储：通过 SQLite 保存集合、请求、环境、历史和整体日志。

## 技术栈

- 桌面壳：Tauri 2
- 前端：React + TypeScript + Vite
- 编辑器：Monaco Editor
- 图标：lucide-react
- 后端：Rust + reqwest + sqlx + SQLite
- 包管理：pnpm

## 环境要求

- Node.js 20 或更高版本
- pnpm 10 或更高版本
- Rust stable
- Windows：Microsoft Edge WebView2 Runtime、Visual Studio 2022 / Build Tools、MSVC
- macOS：macOS 12 或更高版本、Xcode Command Line Tools

安装依赖：

```powershell
pnpm install
```

检查 Tauri 环境：

```powershell
pnpm tauri info
```

## 开发运行

启动 Tauri 开发版：

```powershell
pnpm tauri:dev
```

项目会在启动前尝试释放 `1420` 端口，避免 Vite 端口被旧进程占用。

仅启动前端预览：

```powershell
pnpm dev
```

## 编译与打包

前端构建：

```powershell
pnpm build
```

Tauri 打包：

```powershell
pnpm tauri:build
```

Windows 生成产物位于：

```text
src-tauri/target/release/bundle/
```

更完整的编译说明见 [docs/编译打包.md](docs/编译打包.md)。

## 脚本能力

请求功能区的 `脚本` tab 分为：

- 请求前：发送前运行，可修改 URL、Params、Headers、Body 和 BodyMode。
- 响应后：收到响应后运行，可读取响应、写入环境变量、执行断言。
- 日志：显示当前请求 tab 本次运行产生的脚本日志。

可用对象包括：

- `request`
- `response`
- `env`
- `console`
- `expect`
- `uuid()`
- `timestamp()`

示例：

```js
request.headers.set("X-Request-Id", uuid())
request.params.set("ts", timestamp())
```

响应后脚本示例：

```js
const data = response.json()
env.set("token", data.token)
expect(response.status).toBe(200)
```

详细 API 说明可在应用顶部导航的 `使用文档` 中查看。

## 数据与安全

- 数据默认保存在应用本地 SQLite 数据库。
- 数据库文件、构建产物和打包产物不会提交到 Git。
- 当前阶段脚本在前端受限上下文中运行，不支持外部依赖、文件系统和 Tauri API。

## 项目文档

- [功能列表](docs/功能列表.md)
- [界面设计稿](docs/界面设计稿.md)
- [编译打包](docs/编译打包.md)
