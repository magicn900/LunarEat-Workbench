# 部署指南

## 数据目录

默认目录为 .local-data/demo。通过 WORKBENCH_DATA 可以指定独立目录；相对路径以启动命令所在目录为准。不要让多个服务同时使用同一数据目录。

README 中的 seed 用于体验虚构示例。真实团队可以从空环境开始，无需加载示例。

## 创建管理员和项目

先安装依赖，在应用目录使用 PowerShell：

```powershell
$env:WORKBENCH_DATA = Join-Path $HOME 'workbench-data'
$env:WORKBENCH_PASSWORD = Read-Host '设置管理员密码（至少十位）' -MaskInput
pnpm admin create-admin admin
Remove-Item Env:WORKBENCH_PASSWORD
pnpm build
pnpm start
```

Read-Host -MaskInput 需要 PowerShell 7.1 或更高版本。其他终端请通过安全方式设置 WORKBENCH_PASSWORD，不要把真实密码写进命令历史或文件。

登录 http://127.0.0.1:14311/admin 创建项目、账号并分配项目权限。平台管理员不会自动获得项目内容权限；需要进入策划页面时，也应为自己的账号授权。示例账号默认不是平台管理员。

本机管理命令要求先停止服务。让已有账号成为管理员，可以执行 pnpm admin grant-admin 用户名。至少保留一位已启用的管理员。

## 配置

| 环境变量 | 用途 |
| --- | --- |
| HOST | 监听地址，默认 127.0.0.1 |
| PORT | HTTP 端口，默认 14311 |
| WORKBENCH_DATA | 数据保存目录 |
| WORKBENCH_ORIGIN | 对外访问的可信 Origin，例如 https://workbench.example.com |
| COOKIE_SECURE | HTTPS 部署时设为 true |

.env.example 是配置参考。直接运行服务不会自动加载该文件，需要通过终端、服务管理器或容器环境传入配置。修改开发 API 端口时也要调整开发代理。

## Docker

体验示例：

```sh
docker compose build
docker compose run --rm workbench node --import tsx src/server/admin.ts seed
docker compose up -d
```

初始化和启动分开执行。容器以非 root 用户运行，数据保存在命名卷中，默认端口仅映射到本机。

真实部署可跳过 seed：安全设置宿主终端 WORKBENCH_PASSWORD 后，执行 docker compose run --rm -e WORKBENCH_PASSWORD workbench node --import tsx src/server/admin.ts create-admin admin，再清除该环境变量并启动服务。

团队访问请在前面配置 HTTPS 反向代理，转发 WebSocket，并设置实际 WORKBENCH_ORIGIN 和 COOKIE_SECURE=true。当前要求独立 Origin，不支持部署在 URL 子路径下。

## 轻量部署

使用生产构建运行服务，不要在团队服务器上使用开发监听模式。可在开发机或构建环境提前构建镜像，避免构建过程与日常编辑争用服务器资源。

工作台保持单实例部署。运行缓存有容量上限，正式内容仍以磁盘与数据库为准；不要把缓存当作备份。反向代理可以对静态资源和 JSON 响应启用压缩。

浏览器首次进入仍会加载完整工作区，后续更新使用差量同步。首次加载、全文搜索以及历史较多的项目仍需要结合实际数据量评估；自动历史清理尚未启用，不会为了节省空间擅自删除可撤销的内容或发布历史。

## 备份与更新

停止服务后，执行 pnpm admin backup，后接数据目录之外的全新备份目录路径。备份包括账号与凭据、草稿、共享灵感、正式版本和设计 Git 历史，必须按敏感数据保存。

恢复时停服，把完整备份复制到新的目录，让 WORKBENCH_DATA 指向该目录。不要混用不同备份里的数据库、文本对象或 Git 历史。

更新时先停服并备份，再安装依赖、重新构建并启动，最后刷新浏览器；不要重新 seed。开发阶段不保证旧数据格式兼容。
