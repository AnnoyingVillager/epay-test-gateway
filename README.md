# Epay Test Gateway

一个自托管、面向开发联调与自动化测试的 Epay 兼容网关。内置用户分权、虚拟银行卡、卡 BIN、3DS 密码、余额、订单超时、模拟拒付/退单、异步回调和管理面板。

> **仅用于测试环境。** 本项目不会连接真实银行或支付网络，也不应处理真实银行卡、密码或生产资金。

## 功能

- 兼容常见 Epay 风格的 `/submit.php`、`/api.php`、`/mapi.php` 与 MD5 签名流程
- 用户管理：区分管理员与普通用户；普通用户仅能创建、查看自己的卡片并消费
- 管理面板：仪表盘、虚拟卡、卡 BIN、订单、用户、商户、系统设置
- 创建符合 Luhn 校验的虚拟卡号，支持自定义 BIN 前缀、品牌、卡号长度
- 管理员可修改虚拟卡余额、有效期、CVV、3DS 密码、状态，并记录手工消费
- 一键“模拟拒付”，并可模拟已支付订单的拒付/退单
- 订单绑卡：已绑定订单只接受指定虚拟卡；未绑定订单可登录选卡或直接输入卡片 ID
- 未携带 `bind_card` 的 `/submit.php` 请求不再报错，会跳转到绑卡支付页
- 订单超时倒计时、自动过期和服务端二次校验
- 后台订单页轮询状态变化，支付成功、失败、超时或回调更新后自动刷新
- 支付成功、失败、超时、拒付均生成签名回调；成功或失败都按 Epay 参数返回商户
- SQLite 数据持久化，单容器部署
- 多阶段 Dockerfile，GitHub Actions 自动构建 `linux/amd64` 与 `linux/arm64` 镜像

## 已发布镜像

- `ghcr.io/annoyingvillager/epay-test-gateway:latest`
- `ghcr.io/annoyingvillager/epay-test-gateway:1.1.2` 和 `:1.1`（对应 Git 标签 `v1.1.2`）
- 同时提供 `linux/amd64` 与 `linux/arm64` 多架构镜像

## 无需克隆源码部署

只需要下载一个 `docker-compose.yml`。所有部署参数都在该文件内，无需准备 `.env`，也无需 clone 源码。

### Windows PowerShell

```powershell
Invoke-WebRequest -UseBasicParsing `
  -Uri "https://raw.githubusercontent.com/AnnoyingVillager/epay-test-gateway/main/docker-compose.yml" `
  -OutFile "docker-compose.yml"

notepad .\docker-compose.yml
docker compose up -d
```

### Linux / macOS

```bash
curl -fsSL \
  https://raw.githubusercontent.com/AnnoyingVillager/epay-test-gateway/main/docker-compose.yml \
  -o docker-compose.yml

nano docker-compose.yml
docker compose up -d
```

启动前至少修改 `docker-compose.yml` 中的：

- `ADMIN_PASSWORD`：管理员密码
- `APP_SECRET`：64 位随机十六进制字符串
- `DEFAULT_MERCHANT_KEY`：默认商户 MD5 密钥
- `BASE_URL`：对外访问地址；同机通过 IP 访问时可留空

默认端口为 `3001`。如果要换宿主机端口，只修改 `ports` 中冒号左侧的值，例如 `8080:3001`。

访问地址：

- 管理面板：<http://localhost:3001/admin>
- 健康检查：<http://localhost:3001/healthz>

初始管理员账号为 `admin`，首次启动时密码来自 `ADMIN_PASSWORD`。之后可在“用户”页面创建普通用户或其他管理员。

生成 `APP_SECRET`：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

停止服务：

```bash
docker compose down
```

保留数据卷的停止方式就是上面的默认方式。删除数据卷会清空所有虚拟卡和订单：

```bash
docker compose down -v
```

更新到最新 GHCR 镜像：

```bash
docker compose pull
docker compose up -d
```

### 从源码构建

开发或修改源码时，使用独立的构建文件：

```bash
cp .env.example .env
# 修改 .env 中的 ADMIN_PASSWORD、APP_SECRET、DEFAULT_MERCHANT_KEY
docker compose -f docker-compose.build.yml up -d --build
```

### Docker CLI

```bash
docker pull ghcr.io/annoyingvillager/epay-test-gateway:latest
docker run -d \
  --name epay-test-gateway \
  --restart unless-stopped \
  -p 3001:3001 \
  -e PORT='3001' \
  -e ADMIN_PASSWORD='replace-me' \
  -e APP_SECRET='replace-with-random-secret' \
  -e DEFAULT_MERCHANT_KEY='replace-with-random-merchant-key' \
  -v epay_data:/app/data \
  ghcr.io/annoyingvillager/epay-test-gateway:latest
```

## 首次配置

1. 使用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录管理面板。
2. 打开 **卡 BIN**，创建例如 `424242`、长度 16 的测试 BIN。
3. 打开 **用户**，创建普通用户账号，或让管理员直接创建卡片并指定所属用户。
4. 普通用户登录后打开 **虚拟卡 → 创建虚拟卡**，设置初始余额和 3DS 密码。
5. 用 `/api.php` 或 `/submit.php` 发起订单。
6. 如果传入 `bind_card=CARD-...`，支付页直接显示指定卡片。
7. 如果未传 `bind_card`，支付页会提示登录后选卡，或直接输入卡片 ID 绑卡。
8. 输入卡片详情中的 3DS 密码完成支付；管理员可在后台调额、手工消费或切换“模拟拒付”。

## 用户与权限

| 功能 | 管理员 | 普通用户 |
| --- | --- | --- |
| 创建卡 BIN | 是 | 否 |
| 创建虚拟卡 | 是，可指定所属用户 | 是，只能创建到自己的账号 |
| 查看虚拟卡 | 全部 | 仅自己的卡片 |
| 修改余额、3DS、CVV、状态 | 是 | 否 |
| 手工消费 | 是 | 否 |
| 绑卡支付消费 | 是 | 是，只能选择自己的卡片 |
| 查看订单 | 全部 | 仅自己卡片关联的订单 |
| 用户、商户、系统设置 | 是 | 否 |

管理员不能停用当前账号，也不能移除最后一个启用的管理员。

## 未绑定卡片的支付流程

`bind_card` 现在是可选参数。未携带卡片的订单仍会正常创建，`/submit.php` 返回 `302` 到支付页，而不是返回 `CARD_BINDING_REQUIRED`。支付页提供两种方式：

1. 使用管理员或普通用户账号登录，然后从自己的卡片中选择一张支付。
2. 不登录，直接输入管理员提供的 `CARD-...` 卡片 ID 绑卡后支付。

一旦订单绑定卡片，页面只接受该卡片，不能切换到其他卡。

## 商户接入

默认首次启动会创建一个商户：

| 配置 | 默认值 |
| --- | --- |
| PID | `1001` |
| 名称 | `Demo Merchant` |
| MD5 密钥 | `test-merchant-key-change-me` |

可在 **商户管理** 查看或轮换密钥。

### API 创建订单

```http
GET /api.php?act=order&pid=1001&type=alipay
  &out_trade_no=ORDER-001
  &notify_url=https://merchant.example.com/epay/notify
  &return_url=https://merchant.example.com/epay/return
  &name=Test+Order
  &money=10.00
  &sitename=Demo+Shop
  # bind_card 可选；不传时进入登录选卡/直接绑卡页面
  &bind_card=CARD-1234567890
  &timeout=900
  &sign=<MD5>
  &sign_type=MD5
```

成功响应示例：

```json
{
  "code": 1,
  "msg": "success",
  "trade_no": "T20261106120000A1B2C3D4E5",
  "out_trade_no": "ORDER-001",
  "payurl": "http://localhost:3001/pay/T20261106120000A1B2C3D4E5",
  "urlscheme": "http://localhost:3001/pay/T20261106120000A1B2C3D4E5",
  "qrcode": "http://localhost:3001/pay/T20261106120000A1B2C3D4E5",
  "money": "10.00",
  "status": "pending",
  "bind_card": "CARD-1234567890"
}
```

未传 `bind_card` 时，响应中的 `bind_card` 为 `null`，`payurl` 指向绑卡支付页。

错误响应：

```json
{ "code": -1, "msg": "Invalid signature", "errcode": "SIGN_ERROR" }
```

`/mapi.php` 是 `/api.php` 的别名。

### 浏览器提交订单

`GET` 或 `POST /submit.php`，参数与 API 相同，但不要求 `act`。成功时返回 `302` 跳转到支付页；缺少 `bind_card` 时跳转到绑卡页面。

### 扩展参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `bind_card` | 否 | 预绑定虚拟卡 ID，例如 `CARD-AB12CD34EF`；也可使用别名 `card_id`。不传时在支付页绑卡 |
| `timeout` | 否 | 订单超时秒数，范围 60-86400 |
| `expires_in` | 否 | `timeout` 的别名 |
| `param` | 否 | 商户透传参数，会原样出现在回调中 |
| `sitename` | 否 | 站点名称 |

这些扩展参数都需要参与签名。系统设置中的“未绑卡订单允许在支付页绑定虚拟卡”默认开启；关闭后，未绑定订单只能提示商户重新下单。

### 签名算法

1. 取所有请求参数，排除 `sign` 和 `sign_type`，忽略空值。
2. 按参数名 ASCII 升序排列。
3. 拼接为 `key1=value1&key2=value2...`。
4. 末尾直接追加商户 MD5 密钥。
5. 对完整字符串计算小写 MD5。

Node.js 示例：

```js
const crypto = require('node:crypto');

function makeSign(params, key) {
  const canonical = Object.entries(params)
    .filter(([k, v]) => k !== 'sign' && k !== 'sign_type' && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return crypto.createHash('md5').update(canonical + key).digest('hex');
}
```

仓库内提供了完整测试脚本：

```bash
BASE_URL=http://localhost:3001 \
MERCHANT_PID=1001 \
MERCHANT_KEY=test-merchant-key-change-me \
BIND_CARD=CARD-XXXXXXXXXX \
npm run test:merchant
```

默认通知地址是 `/merchant-notify`，该路径没有内置处理逻辑。正式联调时请通过 `NOTIFY_URL` 指向你自己的服务。

## 回调与返回规则

### 支付成功

异步通知和同步返回都包含：

```text
pid, trade_no, out_trade_no, type, name, money, trade_status=TRADE_SUCCESS,
sign, sign_type=MD5
```

商户的 `notify_url` 必须返回纯文本 `success`，否则网关会按 `NOTIFY_RETRY_COUNT` 重试并记录失败原因。

### 支付失败 / 超时

支付失败或订单过期时，网关使用 Epay 风格扩展状态：

```text
trade_status=TRADE_CLOSED
errcode=CARD_DECLINED | INSUFFICIENT_FUNDS | CARD_EXPIRED | PAYMENT_FAILED | ORDER_EXPIRED
errmsg=...
sign=...
sign_type=MD5
```

同步返回会附带相同参数并跳回 `return_url`；异步通知会发送到 `notify_url`。

### 模拟拒付 / 退单

已支付订单可在订单详情中点击“模拟拒付 / 退单”，金额会退回虚拟卡。回调额外包含：

```text
trade_status=TRADE_CLOSED
refund_status=REFUND_SUCCESS
errcode=CHARGEBACK
```

> 不同 Epay 实现的拒付/退款扩展字段可能不同。如果你的商户系统只支持标准成功通知，请不要依赖本项目的失败/拒付同步逻辑。

## 支付失败场景

在后台或测试流程中可以触发以下结果：

- 卡片状态设置为“模拟拒付”或“冻结”
- 3DS 密码错误（订单仍可重试）
- 卡内余额不足
- 卡片有效期已过
- 订单超过 `timeout` / `expires_in` 时间
- 已支付订单手动模拟拒付/退单

## 管理面板概览

- **仪表盘**：卡片余额、成功交易额、待支付/失败订单
- **虚拟卡**：完整测试卡号、CVV、3DS 密码、余额、状态、所属用户、卡片流水
- **卡 BIN**：仅管理员可创建和维护 BIN 前缀、品牌、卡类型、国家、卡号长度
- **订单**：管理员查看全部订单，普通用户仅查看自己卡片关联的订单
- **用户**：创建管理员/普通用户、启停、重置密码、调整角色
- **商户**：PID、MD5 密钥、启停、密钥轮换
- **设置**：站点名称、默认超时、结算货币、支付类型、支付页绑卡

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 容器内监听端口 |
| `APP_PORT` | `3001` | Docker Compose 映射到宿主机的端口 |
| `BASE_URL` | 空 | 对外公开地址；为空时根据请求自动识别 |
| `DB_PATH` | `/app/data/epay.db` | SQLite 数据库文件 |
| `ADMIN_USERNAME` | `admin` | 首次启动时创建的初始管理员账号 |
| `ADMIN_PASSWORD` | `change-me-now` | 首次启动时创建的初始管理员密码，必须修改 |
| `ADMIN_SESSION_HOURS` | `12` | 管理会话有效期 |
| `APP_SECRET` | 开发回退值 | 会话与卡片数据加密密钥，生产必须设置 |
| `DEFAULT_MERCHANT_PID` | `1001` | 首次启动创建的商户 PID |
| `DEFAULT_MERCHANT_NAME` | `Demo Merchant` | 首次启动创建的商户名称 |
| `DEFAULT_MERCHANT_KEY` | `test-merchant-key-change-me` | 首次启动创建的商户密钥 |
| `ORDER_TIMEOUT_SECONDS` | `900` | 默认订单超时 |
| `NOTIFY_RETRY_COUNT` | `3` | 回调额外重试次数 |
| `NOTIFY_TIMEOUT_MS` | `8000` | 单次回调 HTTP 超时 |
| `TRUST_PROXY` | `false` | 反向代理后设为 `true` |
| `COOKIE_SECURE` | `false` | HTTPS 部署时设为 `true` |

`DEFAULT_MERCHANT_*` 只在数据库没有商户时用于首次初始化。`ADMIN_USERNAME` / `ADMIN_PASSWORD` 只在没有可用管理员时用于初始化；之后请在用户管理中维护账号。

## 数据持久化与备份

Docker Compose 使用命名卷 `epay_test_gateway_data` 挂载到 `/app/data`。备份示例：

```bash
docker compose exec epay sh -c 'cp /app/data/epay.db /app/data/epay.backup.db'
docker cp epay-test-gateway:/app/data/epay.backup.db ./epay.backup.db
```

同一目录下还可能出现 SQLite WAL/SHM 文件。复制备份时应停止容器，或使用 SQLite 的在线备份能力。

## 本地开发

需要 Node.js 24+（使用内置 `node:sqlite`）。

```bash
npm install
npm run dev
```

测试：

```bash
npm test
```

## 发布到 GitHub 与 Docker 镜像

仓库已包含 `.github/workflows/docker.yml`。推送 `main` 分支会构建并推送 `ghcr.io/<owner>/<repo>:latest`；推送 `v1.1.2` 这类标签会额外生成版本标签。

```bash
git init -b main
git add .
git commit -m "feat: add Epay test gateway"
gh auth login
gh repo create epay-test-gateway --public --source=. --remote=origin --push
git tag v1.1.2
git push origin v1.1.2
```

首次使用 GHCR 时，Actions 使用仓库的 `GITHUB_TOKEN` 推送。部署机器拉取公开镜像：

```bash
docker pull ghcr.io/<owner>/epay-test-gateway:latest
```

如果包不是公开的，需要先在 GitHub Package settings 中调整可见性，或执行 `docker login ghcr.io`。

## 安全说明

- 此项目故意展示和修改测试虚拟卡信息。不要用于真实银行卡。
- 修改默认管理员密码、`APP_SECRET` 和商户密钥。
- 对外暴露时使用 HTTPS 反向代理，并设置 `COOKIE_SECURE=true`、`TRUST_PROXY=true`。
- 为管理面板增加网络访问限制或 VPN。
- 卡片号、CVV 和 3DS 密码使用 AES-256-GCM 加密后存储；加密密钥从 `APP_SECRET` 派生。
- 用户密码使用 scrypt 加盐哈希存储，不保存明文。
- 管理表单具有 CSRF 防护、登录限流和单次支付限流。
- 普通用户的卡片、订单和绑卡选择均按账号隔离。
- 不使用本项目处理真实持卡人数据。

## 兼容性说明

本项目实现的是常见“彩虹易支付”风格的自建 Epay 接口约定，包括 `pid`、`type`、`out_trade_no`、`notify_url`、`return_url`、`name`、`money`、MD5 签名、`trade_status=TRADE_SUCCESS` 与商户返回 `success`。不同 Epay 服务商对失败回调、退款/拒付字段可能有差异，详见 [API 文档](docs/EPAY_API.md)。

## License

MIT
