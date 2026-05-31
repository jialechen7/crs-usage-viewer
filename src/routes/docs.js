const express = require('express')

// ---------------------------------------------------------------------------
// crs spec — reads CRS (claude-relay-service) Redis. Mounted at /stats.
// ---------------------------------------------------------------------------
const CRS_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'CRS Usage Viewer (crs)',
    version: '0.2.0',
    description:
      '只读 HTTP 服务,直接从 CRS (claude-relay-service) 的 Redis 读取用量数据,按 Anthropic 5h / 7d 窗口聚合后返回。\n\n' +
      '不调用任何上游 API,不需要鉴权,不修改任何数据。\n\n' +
      '> crs2 (sub2api) 的同类接口在 `/stats/crs2/*`,见独立的 `/stats/crs2/docs`。'
  },
  servers: [
    { url: 'https://250924.xyz', description: '生产环境' },
    { url: 'http://localhost:3001', description: '本地开发' }
  ],
  tags: [
    { name: 'meta', description: '服务自身信息' },
    { name: 'account', description: '账号维度查询' },
    { name: 'key', description: 'API Key 维度查询' }
  ],
  paths: {
    '/stats/health': {
      get: {
        tags: ['meta'],
        summary: '存活探针',
        description: '检查服务和 Redis 连接状态。',
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
                example: { ok: true, backend: 'crs', store: 'connected', redis: 'connected', ts: '2026-05-13T03:21:02.525Z' }
              }
            }
          }
        }
      }
    },
    '/stats/accounts': {
      get: {
        tags: ['account'],
        summary: '列出所有 Claude 账号',
        description: '返回 CRS 里所有 Claude 账号的概要(名称、ID、5h/7d utilization、reset 时间、状态)。',
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AccountsListResponse' } }
            }
          }
        }
      }
    },
    '/stats/account/{name}': {
      get: {
        tags: ['account'],
        summary: '按账号名查该账号下所有 key 在 5h/7d 窗口的用量',
        description:
          '返回该账号当前 5h / 7d 窗口的概况(以 Anthropic 的 resetsAt 倒推)、绑定到该账号的所有 API Key 在两个窗口的 cost / tokens / 占比。\n\n' +
          '**重名时返回数组**(多个匹配元素,各自完整数据)。',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' }, description: '账号名称,完全匹配。', example: 'WANGLEI' }
        ],
        responses: {
          200: {
            description: 'OK,返回数组',
            content: {
              'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/AccountReport' } } }
            }
          },
          404: {
            description: '账号名不存在',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: { error: 'account name not found', name: 'unknown-account' }
              }
            }
          }
        }
      }
    },
    '/stats/key/{identifier}': {
      get: {
        tags: ['key'],
        summary: '按 key 名或 cr_xxx token 查该 key 在 5h/7d 窗口的用量',
        description:
          '`identifier` 自动识别:\n' +
          '- 以 `cr_` 开头 → 当 raw token 解析(sha256 + ENCRYPTION_KEY → keyId)\n' +
          '- 否则 → 当 key name 全匹配\n\n' +
          '**响应里 `account` 子对象**:包含该 key 绑定账号的完整状态(schedulable、status、sessionWindowStatus、opusUtilization 等)。\n\n' +
          '重名时返回数组。',
        parameters: [
          { name: 'identifier', in: 'path', required: true, schema: { type: 'string' }, description: 'key 名称 或 完整 cr_xxx token。', example: 'Jiale' }
        ],
        responses: {
          200: {
            description: 'OK,返回数组',
            content: {
              'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/KeyReport' } } }
            }
          },
          404: {
            description: 'key 名或 token 不匹配',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/KeyNotFoundError' },
                example: { error: 'api key token not found', lookupMode: 'token' }
              }
            }
          }
        }
      }
    }
  },
  components: {
    schemas: {
      HealthResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          backend: { type: 'string', example: 'crs' },
          store: { type: 'string', example: 'connected' },
          redis: { type: 'string', example: 'connected', description: 'crs 后端的兼容别名' },
          ts: { type: 'string', format: 'date-time' }
        }
      },
      AccountSummary: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          platform: { type: 'string', example: 'claude' },
          accountType: { type: 'string', example: 'dedicated' },
          status: { type: 'string', example: 'active' },
          schedulable: { type: 'boolean' },
          fiveHour: {
            type: 'object',
            properties: {
              resetsAt: { type: 'string', format: 'date-time', nullable: true },
              utilization: { type: 'number', nullable: true, description: '0–100' }
            }
          },
          sevenDay: {
            type: 'object',
            properties: {
              resetsAt: { type: 'string', format: 'date-time', nullable: true },
              utilization: { type: 'number', nullable: true },
              opusUtilization: { type: 'number', nullable: true },
              opusResetsAt: { type: 'string', format: 'date-time', nullable: true }
            }
          },
          lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
          usageUpdatedAt: { type: 'string', format: 'date-time', nullable: true }
        }
      },
      AccountsListResponse: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          accounts: { type: 'array', items: { $ref: '#/components/schemas/AccountSummary' } }
        }
      },
      Tokens: {
        type: 'object',
        properties: {
          input: { type: 'integer' },
          output: { type: 'integer' },
          cacheRead: { type: 'integer' },
          cacheCreate: { type: 'integer' },
          total: { type: 'integer' }
        }
      },
      KeyWindowReport: {
        type: 'object',
        description: '某个 key 在一个窗口(5h 或 7d)的用量',
        properties: {
          windowStart: { type: 'string', format: 'date-time' },
          windowEnd: { type: 'string', format: 'date-time' },
          resetsAt: { type: 'string', format: 'date-time' },
          cost: { type: 'number', description: 'USD' },
          tokens: { $ref: '#/components/schemas/Tokens' },
          requests: { type: 'integer' },
          activeHours: { type: 'integer' },
          accountTotalCost: { type: 'number', description: '该账号在该窗口的总成本 USD' },
          shareOfAccount: { type: 'number', nullable: true, description: '0–1 之间,8 位小数精度。' },
          accountUtilization: { type: 'number', nullable: true, description: 'Anthropic 报的整数 utilization(0–100)。' },
          contributionToUtilization: { type: 'number', nullable: true, description: '= accountUtilization × shareOfAccount。' }
        }
      },
      AccountReportKeyItem: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          isActive: { type: 'boolean' },
          cost: { type: 'number', description: 'USD' },
          tokens: { $ref: '#/components/schemas/Tokens' },
          requests: { type: 'integer' },
          activeHours: { type: 'integer' },
          shareOfWindow: { type: 'number', description: '0–1。8 位小数。' },
          contributionToUtilization: { type: 'number', nullable: true }
        }
      },
      AccountReport: {
        type: 'object',
        properties: {
          account: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              platform: { type: 'string' },
              accountType: { type: 'string' },
              status: { type: 'string' },
              fiveHour: {
                type: 'object',
                properties: {
                  windowStart: { type: 'string', format: 'date-time' },
                  windowEnd: { type: 'string', format: 'date-time' },
                  resetsAt: { type: 'string', format: 'date-time' },
                  utilization: { type: 'number', nullable: true }
                }
              },
              sevenDay: {
                type: 'object',
                properties: {
                  windowStart: { type: 'string', format: 'date-time' },
                  windowEnd: { type: 'string', format: 'date-time' },
                  resetsAt: { type: 'string', format: 'date-time' },
                  utilization: { type: 'number', nullable: true },
                  opusUtilization: { type: 'number', nullable: true }
                }
              },
              usageUpdatedAt: { type: 'string', format: 'date-time', nullable: true }
            }
          },
          keys: {
            type: 'object',
            properties: {
              fiveHour: { type: 'array', items: { $ref: '#/components/schemas/AccountReportKeyItem' } },
              sevenDay: { type: 'array', items: { $ref: '#/components/schemas/AccountReportKeyItem' } }
            }
          },
          totals: {
            type: 'object',
            properties: {
              fiveHour: { type: 'object', properties: { cost: { type: 'number' }, tokens: { $ref: '#/components/schemas/Tokens' } } },
              sevenDay: { type: 'object', properties: { cost: { type: 'number' }, tokens: { $ref: '#/components/schemas/Tokens' } } }
            }
          }
        }
      },
      KeyReport: {
        type: 'object',
        properties: {
          key: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              isActive: { type: 'boolean' },
              accountId: { type: 'string', nullable: true },
              accountName: { type: 'string', nullable: true }
            }
          },
          account: { $ref: '#/components/schemas/FullAccountDetail' },
          fiveHour: { $ref: '#/components/schemas/KeyWindowReport' },
          sevenDay: { $ref: '#/components/schemas/KeyWindowReport' }
        }
      },
      FullAccountDetail: {
        allOf: [
          { $ref: '#/components/schemas/AccountSummary' },
          {
            type: 'object',
            properties: {
              sessionWindowStatus: { type: 'string', nullable: true },
              sessionWindowStart: { type: 'string', format: 'date-time', nullable: true },
              sessionWindowEnd: { type: 'string', format: 'date-time', nullable: true },
              errorMessage: { type: 'string', nullable: true },
              autoStopOnWarning: { type: 'boolean' }
            }
          }
        ]
      },
      Error: { type: 'object', properties: { error: { type: 'string' }, name: { type: 'string' } } },
      KeyNotFoundError: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'api key token not found' },
          lookupMode: { type: 'string', enum: ['name', 'token'] }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// crs2 spec — reads crs2 (sub2api) Postgres. Mounted at /stats/crs2.
// ---------------------------------------------------------------------------
const CRS2_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'CRS Usage Viewer (crs2 / sub2api)',
    version: '0.2.0',
    description:
      '只读 HTTP 服务,从 crs2 (sub2api) 的 **PostgreSQL** 读取用量,按 5h / 7d 窗口聚合后返回。\n\n' +
      '与 crs 的差异(数据模型不同):\n' +
      '- 账号没有 Anthropic utilization 百分比,所有 `utilization*` 字段恒为 `null`。\n' +
      '- 账号 5h 窗口取自 `session_window_start/end`;无会话窗时回退为滚动 5h。7d 为滚动窗。\n' +
      '- key 与账号**非静态绑定**:`/key` 返回 `account: null`,改用 `byAccount` 给出按账号拆分的明细。\n' +
      '- token 直查匹配明文 `sk-` key,无需 ENCRYPTION_KEY。'
  },
  servers: [
    { url: 'https://250924.xyz', description: '生产环境' },
    { url: 'http://localhost:3001', description: '本地开发' }
  ],
  tags: [
    { name: 'meta', description: '服务自身信息' },
    { name: 'account', description: '账号维度查询' },
    { name: 'key', description: 'API Key 维度查询' }
  ],
  paths: {
    '/stats/crs2/health': {
      get: {
        tags: ['meta'],
        summary: '存活探针',
        description: '检查服务和 PostgreSQL 连接状态。',
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
                example: { ok: true, backend: 'crs2', store: 'connected', ts: '2026-05-31T03:21:02.525Z' }
              }
            }
          }
        }
      }
    },
    '/stats/crs2/accounts': {
      get: {
        tags: ['account'],
        summary: '列出所有上游账号',
        description: '返回 sub2api 所有未删除账号的概要(name、platform、type、status、session window)。utilization 恒为 null。',
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccountsListResponse' } } } }
        }
      }
    },
    '/stats/crs2/account/{name}': {
      get: {
        tags: ['account'],
        summary: '按账号名查该账号在 5h/7d 窗口被哪些 key 消耗',
        description:
          '从 `usage_logs` 聚合:该账号在 5h(会话窗)/ 7d(滚动)窗口内,各 API Key 的 cost / tokens / requests / 占比。\n\n' +
          '**重名时返回数组**。',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' }, description: '账号名称,完全匹配。', example: 'Max2' }
        ],
        responses: {
          200: { description: 'OK,返回数组', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/AccountReport' } } } } },
          404: { description: '账号名不存在', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
        }
      }
    },
    '/stats/crs2/key/{identifier}': {
      get: {
        tags: ['key'],
        summary: '按 key 名或 sk-xxx token 查该 key 在 5h/7d 窗口的用量',
        description:
          '`identifier` 自动识别:以 `sk-` 开头 → 明文 token 等值匹配;否则 → key name 全匹配(可重名返回数组)。\n\n' +
          '窗口为滚动 5h / 7d。响应含按账号拆分的 `byAccount` 明细;`account` 恒为 `null`。',
        parameters: [
          { name: 'identifier', in: 'path', required: true, schema: { type: 'string' }, description: 'key 名称 或 完整 sk-xxx token。', example: 'Jiale' }
        ],
        responses: {
          200: { description: 'OK,返回数组', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/KeyReport' } } } } },
          404: { description: 'key 名或 token 不匹配', content: { 'application/json': { schema: { $ref: '#/components/schemas/KeyNotFoundError' } } } }
        }
      }
    }
  },
  components: {
    schemas: {
      HealthResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          backend: { type: 'string', example: 'crs2' },
          store: { type: 'string', example: 'connected' },
          ts: { type: 'string', format: 'date-time' }
        }
      },
      AccountSummary: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          platform: { type: 'string', example: 'anthropic' },
          accountType: { type: 'string', example: 'oauth', description: 'sub2api accounts.type' },
          status: { type: 'string', example: 'active' },
          schedulable: { type: 'boolean' },
          sessionWindowStatus: { type: 'string', nullable: true },
          sessionWindowStart: { type: 'string', format: 'date-time', nullable: true },
          sessionWindowEnd: { type: 'string', format: 'date-time', nullable: true },
          fiveHour: {
            type: 'object',
            properties: {
              resetsAt: { type: 'string', format: 'date-time', nullable: true, description: '= session_window_end' },
              utilization: { type: 'number', nullable: true, description: 'crs2 恒为 null' }
            }
          },
          sevenDay: {
            type: 'object',
            properties: {
              resetsAt: { type: 'string', format: 'date-time', nullable: true },
              utilization: { type: 'number', nullable: true },
              opusUtilization: { type: 'number', nullable: true },
              opusResetsAt: { type: 'string', format: 'date-time', nullable: true }
            }
          },
          lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
          usageUpdatedAt: { type: 'string', format: 'date-time', nullable: true }
        }
      },
      AccountsListResponse: {
        type: 'object',
        properties: { count: { type: 'integer' }, accounts: { type: 'array', items: { $ref: '#/components/schemas/AccountSummary' } } }
      },
      Tokens: {
        type: 'object',
        properties: {
          input: { type: 'integer' },
          output: { type: 'integer' },
          cacheRead: { type: 'integer' },
          cacheCreate: { type: 'integer' },
          total: { type: 'integer' }
        }
      },
      AccountReportKeyItem: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string', nullable: true },
          isActive: { type: 'boolean' },
          cost: { type: 'number', description: 'USD' },
          tokens: { $ref: '#/components/schemas/Tokens' },
          requests: { type: 'integer' },
          activeHours: { type: 'integer' },
          shareOfWindow: { type: 'number', description: '0–1。8 位小数。' },
          contributionToUtilization: { type: 'number', nullable: true, description: 'crs2 恒为 null' }
        }
      },
      AccountReport: {
        type: 'object',
        properties: {
          account: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              platform: { type: 'string' },
              accountType: { type: 'string' },
              status: { type: 'string' },
              sessionWindowStatus: { type: 'string', nullable: true },
              fiveHour: {
                type: 'object',
                properties: {
                  windowStart: { type: 'string', format: 'date-time' },
                  windowEnd: { type: 'string', format: 'date-time' },
                  resetsAt: { type: 'string', format: 'date-time', nullable: true },
                  utilization: { type: 'number', nullable: true }
                }
              },
              sevenDay: {
                type: 'object',
                properties: {
                  windowStart: { type: 'string', format: 'date-time' },
                  windowEnd: { type: 'string', format: 'date-time' },
                  resetsAt: { type: 'string', format: 'date-time', nullable: true },
                  utilization: { type: 'number', nullable: true },
                  opusUtilization: { type: 'number', nullable: true }
                }
              },
              usageUpdatedAt: { type: 'string', format: 'date-time', nullable: true }
            }
          },
          keys: {
            type: 'object',
            properties: {
              fiveHour: { type: 'array', items: { $ref: '#/components/schemas/AccountReportKeyItem' } },
              sevenDay: { type: 'array', items: { $ref: '#/components/schemas/AccountReportKeyItem' } }
            }
          },
          totals: {
            type: 'object',
            properties: {
              fiveHour: { type: 'object', properties: { cost: { type: 'number' }, tokens: { $ref: '#/components/schemas/Tokens' } } },
              sevenDay: { type: 'object', properties: { cost: { type: 'number' }, tokens: { $ref: '#/components/schemas/Tokens' } } }
            }
          }
        }
      },
      KeyAccountBreakdown: {
        type: 'object',
        properties: {
          accountId: { type: 'string', nullable: true },
          accountName: { type: 'string', nullable: true },
          cost: { type: 'number', description: 'USD' },
          tokens: { $ref: '#/components/schemas/Tokens' },
          requests: { type: 'integer' },
          activeHours: { type: 'integer' }
        }
      },
      KeyWindowReport: {
        type: 'object',
        properties: {
          windowStart: { type: 'string', format: 'date-time' },
          windowEnd: { type: 'string', format: 'date-time' },
          resetsAt: { type: 'string', format: 'date-time', nullable: true, description: 'crs2 滚动窗,恒为 null' },
          cost: { type: 'number', description: 'USD' },
          tokens: { $ref: '#/components/schemas/Tokens' },
          requests: { type: 'integer' },
          activeHours: { type: 'integer' },
          byAccount: { type: 'array', items: { $ref: '#/components/schemas/KeyAccountBreakdown' } }
        }
      },
      KeyReport: {
        type: 'object',
        properties: {
          key: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              isActive: { type: 'boolean' },
              userId: { type: 'string', nullable: true },
              accountId: { type: 'string', nullable: true, description: 'crs2 恒为 null' },
              accountName: { type: 'string', nullable: true, description: 'crs2 恒为 null' }
            }
          },
          account: { type: 'object', nullable: true, description: 'crs2 恒为 null(key 非静态绑定账号)' },
          fiveHour: { $ref: '#/components/schemas/KeyWindowReport' },
          sevenDay: { $ref: '#/components/schemas/KeyWindowReport' }
        }
      },
      Error: { type: 'object', properties: { error: { type: 'string' }, name: { type: 'string' } } },
      KeyNotFoundError: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'api key token not found' },
          lookupMode: { type: 'string', enum: ['name', 'token'] }
        }
      }
    }
  }
}

// makeDocsRouter(backend, basePath) -> GET /openapi.json + /docs for that backend.
module.exports = function makeDocsRouter(backend, basePath) {
  const router = express.Router()
  const spec = backend.name === 'crs2' ? CRS2_SPEC : CRS_SPEC
  const openapiUrl = `${basePath}/openapi.json`

  router.get('/openapi.json', (req, res) => {
    res.json(spec)
  })

  router.get('/docs', (req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>crs-usage-viewer · ${backend.name} · API Reference</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>body { margin: 0; }</style>
</head>
<body>
  <script id="api-reference" data-url="${openapiUrl}"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`)
  })

  return router
}
