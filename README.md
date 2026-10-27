# crs-usage-viewer

只读 HTTP 服务,把上游中转项目的用量按 5h / 7d 窗口聚合后返回。不调任何上游 API、不修改任何数据。

支持两个后端,跑在**同一个进程**里:

| 后端 | 项目 | 数据源 | 路径前缀 |
|---|---|---|---|
| `crs` | CRS (`claude-relay-service`) | Redis | `/stats/*` |
| `crs2` | sub2api | PostgreSQL | `/stats/crs2/*` |

crs2 默认关闭;设 `ENABLE_CRS2=true` 并配好 `PG_*` 后才挂载(纯 CRS 部署无需安装/连接 Postgres)。

### Magpie 后端

设 `ENABLE_MAGPIE=true`，并将 Magpie 的 `/config` **只读挂载**到 `MAGPIE_DATA_DIR`。只运行 Magpie 时设 `ENABLE_CRS=false`；无需 Redis 或 PostgreSQL。需要 Python 3 和 Node.js 18+。此后端仅读本地 `quotas.json`、`caller-keys.json`、`usage.jsonl` 与价格缓存 `models.json`，不会请求 Anthropic，也不会主动刷新额度。

- `GET /stats/magpie/key`：通过 `Authorization: Bearer <Magpie 网关 key>` 查询该 key，返回与原 `/stats/key` 兼容的数组和 `account`、`fiveHour`、`sevenDay` 字段。密钥不放 URL。禁用或删除的 key 不可访问；设置了模型、账号或预算限制的 key 暂不支持，返回 403，避免扩大可见权限。
- `GET /stats/magpie/accounts`、`GET /stats/magpie/account/:name`：使用 `MAGPIE_STATS_ADMIN_TOKEN_FILE` 指向文件中的独立管理员 token，Bearer 认证。账号详情返回各 key；未配置管理员 token 时无法访问。
- `GET /stats/magpie/health`：进程存活检查，不验证本地文件可读性。

`shareOfAccount` 是该 key 的**本地网关估算费用 / 同账号本地网关估算费用**，`contributionToUtilization` 是该比例乘以账号已用额度。价格取自 Magpie 当前本地 Anthropic 模型价格缓存，计算输入、输出和缓存读写，不等于订阅实际账单；网关外的使用不在分母中，额度与 API 费用也未必线性对应。`dataQuality` 提供口径及额度快照时间。用量只统计到快照读取时间，避免用较新的成本分摊较旧额度。快照过期、没有成本、价格缺失或记录损坏时，份额为 `null`，不会伪造 0%。历史价格变化和未记录的请求也可能影响结果。

不要把 `/config` 里的密钥或登录文件公开。对外提供此接口时使用 HTTPS，并限制管理员 token 的持有者；网关 key 仅能查自己的份额。

## 接口

两个后端各自暴露同一组端点(crs2 把前缀换成 `/stats/crs2`):

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/stats/health` | 存活探针(`backend` 字段标明 crs/crs2) |
| GET | `/stats/accounts` | 列出所有账号 |
| GET | `/stats/account/:name` | 按账号名查该账号下各 key 在 5h/7d 窗口的用量 |
| GET | `/stats/key/:identifier` | 按 key 名 **或** 原始 token 查该 key 在 5h/7d 窗口的用量 |
| GET | `/stats/aggregate/account/:name` | 聚合 CRS + CRS2 同名账号,按同名 key 合并后重新计算相对占比 |
| GET | `/stats/docs` · `/stats/openapi.json` | API 文档(Scalar) |

`/key/:identifier` 自动识别参数;重名时返回数组。

`/stats/aggregate/account/:name` 用于同一个真实账号同时挂在 CRS 和 CRS2 的场景。接口会分别读取两个后端的账号明细,把 5h/7d 成本和 token 相加,再按 key `name` 合并后重新计算:

- 聚合使用名义窗口:5h = reset-5h ~ now,7d = reset-7d ~ now,不使用单平台接口的 reset cursor 裁剪
- key 名合并大小写不敏感,响应里的 `aliases` 保留原始 key 名
- `shareOfAccount` = 合并后 key cost / 两个平台账号总 cost
- `contributionToUtilization` = 共享账号 utilization × `shareOfAccount`
- 账号级 utilization 不相加,取 `usageUpdatedAt` 最新的非空来源,并在 `utilizationSource` / `utilizationSources` 中返回来源
- 如果两个平台账号名不一致,可用 `?crsName=...&crs2Name=...` 指定各自名称

> 安全提示:把原始 token 放在 URL 里会落到 nginx access log / Cloudflare 边缘缓存。仅在受控网络内使用。

### crs 后端(Redis)

token 以 `cr_` 开头时按 token 查(需配置 `ENCRYPTION_KEY` 与 CRS 一致,sha256 散列),否则按 name 查。

窗口边界对齐 Anthropic 计费:
- 5h 窗口 = `claudeFiveHourResetsAt - 5h` ~ now
- 7d 窗口 = `claudeSevenDayResetsAt - 7d` ~ now
- 默认只在明确 reset 边界已过时推进统计起点。`utilization` 自然下降/采样抖动不会被当成 reset,避免错误裁短 7d 用量。
- 如需恢复旧的 utilization-drop 推断,可显式设置 `ENABLE_UTILIZATION_DROP_RESETS=true`。
- 如果已知某账号真实刷新边界,可在 `.quota-reset-overrides.json` 指定人工边界。格式为 `"<backend>:<accountId>:<windowType>": "<ISO 时间>"`;边界落在名义窗口内才生效,否则忽略。
- 也可以通过接口设置人工边界。默认不认证;如果配置了 `RESET_OVERRIDE_ADMIN_TOKEN`,写接口需传 `Authorization: Bearer <token>` 或 `x-admin-token`。

```bash
curl -X PUT http://localhost:3001/stats/reset-overrides/account/Max2 \
  -H 'content-type: application/json' \
  -d '{"resetAt":"2026.6.20 00:00:00","windowType":"sevenDay","timezoneOffsetHours":8}'

curl http://localhost:3001/stats/reset-overrides
```

### crs2 后端(Postgres / sub2api)

数据模型与 CRS 不同,因此响应有差异:

- 账号**没有** Anthropic utilization 百分比 → 所有 `utilization*` 字段恒为 `null`。
- 用量从 `usage_logs` 实时聚合;`cost` = `total_cost`(USD)。
- 账号 5h 窗口取自 `session_window_start/end`,无会话窗(如 openai 账号)时回退为滚动 5h;7d 为滚动窗。
- key 与账号**非静态绑定**(一个 key 可被多个账号承接)→ `/key` 返回 `account: null`,并用 `byAccount` 给出按账号拆分的明细;窗口为滚动 5h / 7d。
- token 以 `sk-`(可配 `CRS2_API_KEY_PREFIX`)开头时直接等值匹配明文 key,**不需要** `ENCRYPTION_KEY`。

## 本地运行

```bash
cp .env.example .env
# 编辑 .env 填 Redis 连接信息(crs);需要 crs2 时设 ENABLE_CRS2=true 并填 PG_*
npm install
npm run dev
curl http://localhost:3001/stats/health
curl http://localhost:3001/stats/crs2/health   # 仅当 ENABLE_CRS2=true
```

## 部署 (pm2)

```bash
pm2 start ecosystem.config.js
pm2 save
```

## nginx (示例 location 块)

```nginx
# 一条 location 同时覆盖 /stats/ 和 /stats/crs2/
location /stats/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $http_host;
}
```
