# Epay API 详细约定

## 端点

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET/POST | `/api.php` | JSON 创建订单 |
| GET/POST | `/mapi.php` | `/api.php` 的别名 |
| GET/POST | `/submit.php` | 直接跳转支付页；自动成功模式下直接跳回商户 |
| GET | `/pay/:tradeNo` | 支付页；未绑卡时显示绑卡页面 |
| POST | `/pay/:tradeNo/login` | 绑卡前登录账号 |
| POST | `/pay/:tradeNo/bind` | 使用卡号、有效期和 CVV 绑定卡片到订单 |
| POST | `/pay/:tradeNo/account` | 登录后使用账户余额支付 |
| GET | `/pay/:tradeNo/status` | 轮询订单状态 |
| POST | `/api.php?act=refund` | 发起担保期内退款 |
| GET | `/healthz` | 健康检查 |

## 订单字段

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `act` | API 必填 | string | 固定为 `order` |
| `pid` | 是 | string | 商户 PID |
| `type` | 是 | string | `alipay`、`wxpay`、`qqpay` 或后台配置的类型 |
| `out_trade_no` | 是 | string | 商户订单号，1-128 位字母、数字、下划线或连字符 |
| `notify_url` | 是 | URL | 异步通知地址，必须为 HTTP/HTTPS |
| `return_url` | 是 | URL | 同步返回地址，必须为 HTTP/HTTPS |
| `name` | 是 | string | 商品名称，最多 128 字符 |
| `money` | 是 | decimal | 正金额，最多 2 位小数 |
| `sitename` | 否 | string | 商户站点名称 |
| `param` | 否 | string | 原样透传字段 |
| `bind_card` | 否 | string | 预绑定虚拟卡 ID；不传时在支付页登录选卡或直接绑卡 |
| `timeout` | 否 | integer | 订单超时秒数，60-86400 |
| `sign` | 是 | string | 小写 MD5 |
| `sign_type` | 否 | string | 固定 `MD5` |

同一个商户下的 `out_trade_no` 必须唯一。如果重复请求同一未过期订单，API 会返回原订单的 `trade_no` 与 `payurl`。

## 签名

参与签名的字段是除 `sign`、`sign_type` 外的全部非空请求字段。字段按名称 ASCII 升序排列。

```text
message = "money=10.00&name=Test&notify_url=https%3A%2F%2F..."
sign = md5(message + merchant_key)

# 如果传入 bind_card，它同样需要参与签名：
message = "bind_card=CARD-123&money=10.00&name=Test&notify_url=https%3A%2F%2F..."
sign = md5(message + merchant_key)
```

实现注意事项：

- 使用原始参数值，不要先 URL 编码后参与签名。
- 不要把 `sign` 或 `sign_type` 加入待签名内容。
- 本项目输出小写 MD5；验证时按小写十六进制比较。
- 金额不要使用浮点运算，网关内部以分为单位存储。

## API 成功响应

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
  "bind_card": null
}
```

传入 `bind_card` 时，该字段返回实际卡 ID；未传入时为 `null`，`payurl` 指向绑卡页面。

## 自动成功模式

管理员可在系统设置中开启“所有传入的支付请求直接返回成功”。该模式只跳过支付页面和卡片校验，不会跳过 PID、MD5 签名、必填参数及 URL 校验。

开启后：

- `/submit.php` 返回 `302`，目标为 `return_url` 并附带签名后的 `trade_status=TRADE_SUCCESS`
- `/api.php`、`/mapi.php` 的 `status` 为 `paid`
- API 的 `payurl`、`urlscheme`、`qrcode` 均指向带成功参数的 `return_url`
- 订单不会绑定虚拟卡，即使传入 `bind_card` 也会被忽略
- 订单会立即触发 `notify_url` 异步通知

## API 错误响应

HTTP 状态通常保持 `200`，便于兼容只解析 JSON 的 Epay 客户端。

```json
{
  "code": -1,
  "msg": "Invalid signature",
  "errcode": "SIGN_ERROR"
}
```

常见 `errcode`：

- `MISSING_PARAMETER`
- `INVALID_PID`
- `SIGN_ERROR`
- `INVALID_MONEY`
- `INVALID_NOTIFY_URL`
- `INVALID_RETURN_URL`
- `UNSUPPORTED_PAY_TYPE`
- `CARD_NOT_FOUND`
- `DUPLICATE_OUT_TRADE_NO`
- `SYSTEM_ERROR`

## 支付校验

订单已预绑定卡片时只展示该卡。未绑定时，用户可以登录并选择自己名下的卡，也可以输入卡号、`MM/YY` 有效期和 CVV。卡号、有效期或 CVV 不匹配时不会绑定。绑定完成后，页面只接受该卡。确认支付时按顺序校验：

1. 订单仍为 `PENDING` 且未过期
2. 虚拟卡存在，所属账号启用且未被风控阻断
3. 卡 BIN 仍启用，且当前用户分组仍有该 BIN 权限
4. 卡片状态为 `active`，有效期未过，币种与订单一致
5. 该卡所属 BIN 开启 3DS 时，3DS 密码正确
6. 卡片余额大于等于订单金额，且未超过账号消费限额

3DS 密码错误不会关闭订单，用户可以再次输入。对应 BIN 关闭 3DS 后，支付确认请求无需携带 `pin`。余额不足、卡拒付、卡过期、BIN 停用、分组权限撤销和订单超时会将订单置为终止状态。

支付页默认使用 AJAX 提交确认请求，并附带请求头 `X-Payment-Ajax: 1`。成功时网关返回包含 `redirectUrl` 的 JSON，页面先显示“订单已完成”，随后自动跳转商户 `return_url`。如果 JavaScript 不可用，同一个端点仍会返回标准 `303` 跳转。

## 成功同步返回

支付成功后浏览器被 `303` 重定向到 `return_url`，并附加签名参数：

```text
pid=1001
trade_no=T20261106120000A1B2C3D4E5
out_trade_no=ORDER-001
type=alipay
name=Test+Order
money=10.00
trade_status=TRADE_SUCCESS
sign=...
sign_type=MD5
```

商户必须用同样的签名算法验证参数。

## 异步通知

网关向 `notify_url` 发起 GET 请求。每次尝试都会写入后台回调日志。

商户返回：

```http
HTTP/1.1 200 OK
Content-Type: text/plain

success
```

只有 HTTP 2xx 且正文去除首尾空白后等于 `success` 才算送达。否则按 `NOTIFY_RETRY_COUNT` 重试，并允许管理员在订单详情中手动重发。

## 失败和超时

支付失败：

```text
trade_status=TRADE_CLOSED
errcode=CARD_DECLINED
errmsg=Card payment declined
```

余额不足：

```text
trade_status=TRADE_CLOSED
errcode=INSUFFICIENT_FUNDS
```

卡过期：

```text
trade_status=TRADE_CLOSED
errcode=CARD_EXPIRED
```

订单超时：

```text
trade_status=TRADE_CLOSED
errcode=ORDER_EXPIRED
```

这些字段同样参与签名。

## 退款

借记卡订单采用即时结算，支付成功后不可退款。信用卡和账户余额订单进入担保期，默认 300 秒，可通过系统设置调整。担保期内可调用：

```http
POST /api.php
act=refund
pid=1001
trade_no=T20261106120000A1B2C3D4E5
out_refund_no=REFUND-001
money=10.00
reason=test-refund
sign=<MD5>
sign_type=MD5
```

`money` 可省略表示退款剩余全部金额。同一 `out_refund_no` 重试会返回原退款单；如果同一退款单号用于其他订单或不同金额，返回 `IDEMPOTENCY_CONFLICT`。GET 请求不能发起退款。

退款金额按原渠道返回虚拟卡或账户余额。部分退款后订单保持 `PAID`；全额退款后变为 `CHARGEBACK`，并发送带以下字段的签名回调：

```text
trade_status=TRADE_CLOSED
refund_status=REFUND_SUCCESS
refund_no=R...
refund_money=10.00
errcode=CHARGEBACK
errmsg=Full refund completed
```

商户后台的账单详情页也可以发起全额或指定金额退款。

## 支付页超时

订单创建时计算 `expires_at = created_at + timeout`。支付页前端显示倒计时并在到期后禁用表单；服务端在确认支付、打开支付页和后台定时清理时再次验证，避免仅依赖浏览器时间。

## 幂等性

- 同一商户下重复且未过期的 `out_trade_no` 会返回原订单。
- 已支付订单再次确认不会重复扣款。
- 退款请求应携带稳定的 `out_refund_no`；相同请求重复提交不会重复入账。
- 回调重发不会改变订单金额或卡片余额。

## 限制

- 只支持 Epay 的 MD5 签名方式，不支持 RSA。
- 不提供真实银行 3DS 协议，3DS 密码只是可开关的测试字段。
- 不支持真实退款清算、银联网络、银行对账或银行卡网络通信。
- 仅建议部署在隔离的测试网络。
