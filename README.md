# crs-usage-viewer

只读 HTTP 服务,直接从 CRS (`claude-relay-service`) 的 Redis 读取用量数据,按 Anthropic 5h / 7d 窗口聚合后返回。

不调任何上游 API、不修改任何 Redis 数据,不依赖 CRS 代码。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/stats/health` | 存活探针 |
| GET | `/stats/accounts` | 列出所有 Claude 账号 |
| GET | `/stats/account/:name` | 按账号名查该账号下所有 key 在 5h/7d 窗口的用量 |
| GET | `/stats/key/:identifier` | 按 key 名 **或** 原始 `cr_xxx` token 查该 key 在 5h/7d 窗口的用量 + 占账号份额 |

`/stats/key/:identifier` 自动识别参数:以 `cr_` 开头按 token 查(需配置 `ENCRYPTION_KEY` 与 CRS 一致),否则按 name 查。重名时返回数组。

> 安全提示:把原始 cr_ token 放在 URL 里会落到 nginx access log / Cloudflare 边缘缓存。仅在受控网络内使用。

窗口边界对齐 Anthropic 计费:
- 5h 窗口 = `claudeFiveHourResetsAt - 5h` ~ now
- 7d 窗口 = `claudeSevenDayResetsAt - 7d` ~ now

## 本地运行

```bash
cp .env.example .env
# 编辑 .env 填 Redis 连接信息
npm install
npm run dev
curl http://localhost:3001/stats/health
```

## 部署 (pm2)

```bash
pm2 start ecosystem.config.js
pm2 save
```

## nginx (示例 location 块)

```nginx
location /stats/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $http_host;
}
```
