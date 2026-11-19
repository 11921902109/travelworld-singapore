# Travelworld 新加坡

> 将一切交给对话

用一句话说明旅行愿望，减少反复填写条件和在不同工具之间切换的时间。Travelworld 从自然语言中整理出行条件，再陪用户挑地点、排日期、选住宿，直到行程可以在地图上核对。新加坡是首个完整目的地。当前公开源码对应在线版 V40。

## 在线体验

- [Travelworld 首页](https://hello-travel-26915.vocal-fern-4292.chatgpt.site/travel)
- [新加坡四日案例](https://hello-travel-26915.vocal-fern-4292.chatgpt.site/travel/demo-singapore#case-walkthrough)
- [创建自己的行程](https://hello-travel-26915.vocal-fern-4292.chatgpt.site/travel/new)
- [四日案例图解](./docs/singapore-walkthrough.md) · [问题与改进方案](./record.md) · [修复及发布记录](./fix.md)

打开「创建自己的行程」，输入下面的例子，或者换成未来的 1–7 天日期。

> 我和伴侣两位成人，2026 年 12 月 20 日至 23 日去新加坡，住 Bugis 附近。每天 09:30 出发、21:00 回酒店，节奏轻松，喜欢建筑、美食和夜景。

## 从条件到地图

| 阶段 | 可以做什么 |
| --- | --- |
| 意图理解 | 保留本次访问已确认的条件，只追问缺失或含糊之处。结构化结果继续由日期、预算和时段规则校验。 |
| 挑地点与分天 | 查看根据偏好推荐、经 Google Places 核实的地点，搜索其他景点，把地点安排到对应日期的上午或下午。 |
| 航班与住宿 | 按需查航班、录入已订时刻，或跳过航班。按分天安排比较住宿区域，再用 Google Places 查具体酒店，按酒店和入住日期获取飞猪价格参考。 |
| 逐日核算 | 核对活动、交通、开放窗口和留白。可添加用餐、休息和自定义安排。首日可改结束时间，末日可改出发时间，航班边界仍参与核算。存在多个冲突时可在同一预览连续调整，所有受影响日期通过后一次确认。 |
| 地图与分享 | 查看路线和地点详情，按路段切换交通方式，或生成只读分享。住宿信息可按分享设置隐藏。 |

分阶段规划时，左侧的「需要帮助」展示当前阶段三个可直接点选的问题，也接受自定义提问。回复基于已确认的条件和进度，行程编辑在各阶段各自的操作项中完成。

## 技术与数据来源

- **阿里云百炼 Managed Agent** 在运行时参与复杂意图理解、地点候选建议、住宿规划和阶段答疑。明确且可校验的输入可走本地规则。意图、规划任务和帮助使用各自的会话用途，在同一次访问内按用途复用。
- **Google Places API（New）** 提供真实地点的名称、坐标、类别和常规开放信息。**Google Routes API** 核算交通，**Maps JavaScript API** 渲染地图。
- **FlyAI／飞猪** 通过百炼 Agent 中的 Skill 补充航班查询和酒店／景点商品参考。价格与可订状态以供应方页面为准。餐厅保留地点信息。
- **Next.js 路由、React、TypeScript、Vite／Vinext、Cloudflare Workers、D1 与 Drizzle** 提供应用和服务端的持久化与运行环境。会话、规划状态和分享快照使用 D1。

## 本地运行

需要 Node.js 22.13+ 和 `package.json` 中指定的 pnpm 版本。先安装锁定依赖并构建。应用含服务端接口，在线版托管在 ChatGPT Sites。

```sh
pnpm install --frozen-lockfile
npm run build
```

### 无密钥检查

以下定向测试使用合成数据和服务桩，覆盖意图规则、规划状态、批量冲突预览、到达时间及分享。构建和测试都可以填空凭据运行。

```sh
node --test --test-concurrency=1 tests/intent-fast-path.test.mjs tests/singapore-intent.test.mjs tests/planning-state.test.mjs tests/planning-conflicts.test.mjs tests/schedule-time-arrivals.test.mjs tests/shared-trip.test.mjs
```

### 接入自己的服务

1. 用自己的阿里云百炼工作空间部署 Managed Agent，填入 `DASHSCOPE_API_KEY`、`BAILIAN_API_BASE_URL`、`BAILIAN_AGENT_ID` 和 `BAILIAN_ENVIRONMENT_ID`。需要飞猪报价或查询时，在 Agent 安装并配置 FlyAI Skill。`FLYAI_API_KEY` 仅用于服务端。
2. 启用 Google Places API（New）、Routes API 和 Maps JavaScript API。为 `GOOGLE_MAPS_SERVER_KEY` 配置服务端权限，为浏览器可见的 `GOOGLE_MAPS_BROWSER_KEY` 限制 HTTP 来源和 API。
3. 从 [`.env.example`](./.env.example) 复制出本地 `.dev.vars`，仅在本地填写凭据。给新建本地数据库依次执行 `drizzle/` 下的所有 SQL，再启动 Worker。`dist/server/wrangler.json` 由构建生成，`DB` 是本地绑定名。

```sh
for file in drizzle/[0-9]*.sql; do
  node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file "$file" || exit 1
done
npm start -- --env-file .dev.vars
```

以上迁移循环适用于 Bash。Windows PowerShell 可用 `Get-ChildItem drizzle -Filter '*.sql' | Sort-Object Name` 列出文件，并按相同顺序将文件逐个传给 `--file`。已有本地库只执行尚未应用的迁移。启动后打开终端给出的本地地址，访问 `/travel`。仓库内的 Sites 项目标识为占位值，托管时使用自己的项目和服务端密钥管理。

本次源码整理验证了生产构建、55 项定向测试和 16 个迁移文件在 SQLite 中的顺序执行。本地 Worker 环境和实时供应方调用仍需用自己的服务配置复现。

## 当前范围与未来工作

当前覆盖 1–7 天的新加坡规划。Google 提供的是常规开放信息，节假日安排宜以场馆公告为准。国际航班查询可能缺少某些方向或返回错误，已订时刻可手动录入。地图上展示的行程时间仍是估算。

1. **扩展目的地。** 将新加坡的地点检索、区域词表和交通约束拆成可配置的目的地规则。
2. **加强按日意图理解。** 从旅行总偏好进一步识别每一天的必去、避开、时段和留白要求，减少重复追问。
3. **增强可核验的调整建议。** 将营业窗口、交通、首末日约束与用户偏好放在同一份候选比较中，说明每项调整的原因和影响。

新加坡案例中的摄影素材及许可见 [图片署名](./TRAVEL_CASE_IMAGE_CREDITS.md)。
