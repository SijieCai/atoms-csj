# 开发 / 线上环境区分与阿里云 ECS 部署方案

- **日期**：2026-11-25
- **分支**：`feat/env-separation-and-ecs-deploy`
- **状态**：Implemented

---

## 1. 背景与目标

`atoms` 原先仅通过单一 `.env` 文件和默认 `NODE_ENV=development` 启动，开发态与线上态在域名、HTTPS Cookie 策略、前端构建变量及部署脚本上缺少清晰分层。本次改造目标：

1. **项目内显式区分开发环境与线上环境**：
   - 服务端与前端均有版本化的环境默认文件（`.env.development` / `.env.production`、`web/.env.development` / `web/.env.production`），不含任何密钥，可直接提交至 Git；
   - 私有密钥与账号配置仍保留在被 `.gitignore` 忽略的 `.env`（以及可选的 `.env.<env>.local`）中；
   - 线上部署将本地 `.env` 一并同步至 ECS，同时由 `APP_ENV=production` / `NODE_ENV=production` 决定加载线上配置，避免本地 `.env` 中的 `NODE_ENV=development` 污染线上运行模式。
2. **线上域名与 ECS 共存部署**：
   - 目标实例：`i-bp1gfc3u8rfhf0xh08ju`（华东1·杭州，`116.62.157.145`，Ubuntu 24.04，2 vCPU / 1.7 GiB RAM）。
   - 实例上已有 `/opt/class-map` 服务通过 Docker 版 `caddy:2.10-alpine` 占用 `80`/`443` 端口并服务根域名 `https://maplink.site`。
   - 经确认采用**子域名共存方案**：保留 `https://maplink.site` 给 `class-map`，为本项目在阿里云 DNS 新增 A 记录 **`atoms.maplink.site` → `116.62.157.145`**，并通过现有 Caddy 统一反向代理与自动签发 HTTPS 证书（反代至宿主机网桥 `172.18.0.1:3000`，零停机热重载）。

---

## 2. 环境变量分层与优先级设计

### 2.1 服务端（`server/src/config.ts`）

首先由进程外部传入的 `APP_ENV` 或 `NODE_ENV` 决定运行环境 `appEnv`（默认为 `development`）：

- 本地开发：`npm run dev` 显式注入 `APP_ENV=development NODE_ENV=development`
- 线上运行：`npm run start` / `systemd`（`deploy/atoms.service`）显式注入 `APP_ENV=production NODE_ENV=production`

随后按从高到低优先级加载配置文件（已存在的键不被低优先级覆盖）：

1. **进程环境变量**（最高优先级，来自命令行或 systemd `Environment=`）
2. `.env.<appEnv>.local`（单环境私有覆盖，gitignored）
3. `.env.<appEnv>`（`.env.development` / `.env.production`，提交入库，无密钥）
4. `.env.local`（本地私有覆盖，gitignored）
5. `.env`（共享密钥与配置，如 `GLM_API_KEY`、`DEMO_USERS`、`SESSION_SECRET`，gitignored，部署时随同同步）

> 关键点：由于步骤 1 和步骤 3 均优先于步骤 5，即便把本地 `.env`（内含 `NODE_ENV=development`）直接同步到服务器，线上 systemd 启动时仍会以 `production` 模式运行并自动应用 `PUBLIC_DOMAIN=atoms.maplink.site`、`PUBLIC_URL=https://atoms.maplink.site` 与 `COOKIE_SECURE=true`，同时完整复用 `.env` 中的 `GLM_API_KEY` 与 `DEMO_USERS`。

### 2.2 新增配置项

| 变量名 | 开发环境默认值 | 线上环境默认值 | 说明 |
|---|---|---|---|
| `APP_ENV` | `development` | `production` | 应用运行环境标识 |
| `PUBLIC_DOMAIN` | `localhost:5173` | `atoms.maplink.site` | 对外访问域名 |
| `PUBLIC_URL` | `http://localhost:5173` | `https://atoms.maplink.site` | 对外访问完整 Origin（用于分享链接与元信息） |
| `COOKIE_SECURE` | `false` | `true` | Session Cookie 是否强制 `Secure`（未显式设置时按 `isProd && publicUrl.startsWith('https://')` 推导） |
| `TRUST_PROXY` | `false` | `1` | Express `trust proxy` 设置，线上经 Caddy 反代需开启 |

### 2.3 前端（Vite）

- `web/.env.development`：`VITE_APP_ENV=development`、`VITE_PUBLIC_URL=http://localhost:5173`
- `web/.env.production`：`VITE_APP_ENV=production`、`VITE_PUBLIC_URL=https://atoms.maplink.site`
- `web/src/env.ts`：统一导出 `APP_ENV`、`IS_PROD`、`PUBLIC_URL` 与 `getPublicOrigin()`，供分享链接生成和开发环境角标展示使用。

---

## 3. 安全与资源保障

1. **Session Cookie**：`server/src/auth.ts` 中 `setSessionCookie` / `clearSessionCookie` 依据 `config.cookieSecure` 动态设置 `secure`，线上 HTTPS 环境下自动启用 `Secure` 属性。
2. **内存与 Swap**：目标 ECS 为 2C / 1.7 GiB 物理内存，在宿主机配置 2 GiB `/swapfile`（持久化至 `/etc/fstab`），并在 `atoms.service` 中限制 `NODE_OPTIONS=--max-old-space-size=768`。前端含 Monaco Editor（2690 模块），为避免在 2 GiB 小内存 ECS 上触发 Rollup/Vite 打包抖动，`deploy/deploy-ecs.sh` 采用**本地 `npm run build:prod` 后同步产物至 ECS**的策略，远程仅管理运行时依赖与服务重启。
3. **反向代理与 SSE / WebSocket**：
   - Caddy 针对 `atoms.maplink.site` 配置 `reverse_proxy 172.18.0.1:3000 { flush_interval -1 }`，保证 SSE 实时流不缓冲且 LSP WebSocket 自动透传。
   - 不限制 512KB 请求体（使用 10MB 上限），避免文件保存/工作区接口被反代截断。
4. **重复部署脚本**：新增 `deploy/deploy-ecs.sh`，支持从本地一键同步源码与 `.env` 到 ECS、安装依赖、生产编译、重启 `atoms.service` 并执行健康检查。
