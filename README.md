# crs-usage-viewer

只读 HTTP 服务,把上游中转项目的用量按 5h / 7d 窗口聚合后返回。不调任何上游 API、不修改任何数据。

支持两个后端,跑在**同一个进程**里:

| 后端 | 项目 | 数据源 | 路径前缀 |
|---|---|---|---|
| `crs` | CRS (`claude-relay-service`) | Redis | `/stats/*` |
| `crs2` | sub2api | PostgreSQL | `/stats/crs2/*` |

crs2 默认关闭;设 `ENABLE_CRS2=true` 并配好 `PG_*` 后才挂载(纯 CRS 部署无需安装/连接 Postgres)。

## 接口

两个后端各自暴露同一组端点(crs2 把前缀换成 `/stats/crs2`):

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/stats/health` | 存活探针(`backend` 字段标明 crs/crs2) |
| GET | `/stats/accounts` | 列出所有账号 |
| GET | `/stats/account/:name` | 按账号名查该账号下各 key 在 5h/7d 窗口的用量 |
| GET | `/stats/key/:identifier` | 按 key 名 **或** 原始 token 查该 key 在 5h/7d 窗口的用量 |
| GET | `/stats/docs` · `/stats/openapi.json` | API 文档(Scalar) |

`/key/:identifier` 自动识别参数;重名时返回数组。

> 安全提示:把原始 token 放在 URL 里会落到 nginx access log / Cloudflare 边缘缓存。仅在受控网络内使用。

### crs 后端(Redis)

token 以 `cr_` 开头时按 token 查(需配置 `ENCRYPTION_KEY` 与 CRS 一致,sha256 散列),否则按 name 查。

窗口边界对齐 Anthropic 计费:
- 5h 窗口 = `claudeFiveHourResetsAt - 5h` ~ now
- 7d 窗口 = `claudeSevenDayResetsAt - 7d` ~ now
- 如果 Anthropic 已经重置额度但 reset 时间未推进,服务会把实际统计起点推进到 reset 后或本地检测到的 reset cursor,避免用重置前的用量稀释当前 utilization 占比。

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
