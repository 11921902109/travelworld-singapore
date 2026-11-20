# Travelworld 新加坡

> 将一切交给对话

Travelworld 是面向新加坡自由行的 AI 旅行客服。从一句话开始，协助用户完成 **1–7 天**的行程规划。当前公开版本为 **V40**。

[开始在线规划](https://hello-travel-26915.vocal-fern-4292.chatgpt.site/travel/new) · [完整四日图解（38 张图）](./docs/singapore-walkthrough.md) · [问题与版本演进](./record.md) · [修复、验证和发布记录](./fix.md)

## 旅行客服怎么工作

1. **意图理解。** 用户可以用自己的话说明想怎么旅行。客服把日期、人数、预算、节奏和时段整理成可核对的条件，区分「希望晚上九点回酒店」与「最晚九点必须回酒店」，并针对缺失或含糊的条件继续追问。
2. **理解后的行动。** 用户确认条件后，系统据此推荐和核实地点，协助分天、录入航班、比较住宿，并按营业时段、交通和机场预留核算每天的安排。遇到冲突会说明影响并给出调整入口。用户确认后即可生成地图，并可创建只读分享链接。

## 当前体验

| 阶段 | 用户可以做什么 |
| --- | --- |
| 对话确认条件 | 用一句话说明旅行愿望。页面列出已识别的条件，助手针对缺失或含糊的信息继续追问。 |
| 挑地点、按天安排 | 从真实候选中挑选地点，把每一站放入指定日期的上午或下午，也可确认保留自由日。 |
| 确认航班与住宿 | 可录入已订航班的当地起降时刻，或查询航班参考。住宿可比较全程同住和分段住宿，再按区域和预算选择酒店。 |
| 核算和修改 | 按日期查看营业、交通、机场预留及活动余量。在同一份预览中连续处理多处冲突，所有受影响日期通过后一次保存。首日可改当地结束时间，末日可改当地出发时间。 |
| 地图与分享 | 按天查看地面路线、预计耗时和地点详情。可按路段切换交通方式、就当天行程提问，或创建 30 天有效的只读分享链接。 |

分阶段规划中的「需要帮助」会随当前步骤提供三个可点问题，例如「还有哪些地点没安排到某一天？」。帮助解释已确认的条件和进度，行程修改通过各阶段的表单或选项保存。

## 数据与技术

- **阿里云百炼 Managed Agent** 在运行时参与复杂意图理解、候选建议和答疑。可明确校验的日期、人数等字段也可以由本地规则处理。服务端保存已确认条件，并按实际约束核对方案。
- **Google Places API（New）** 提供地点身份、坐标和常规开放信息。**Google Routes API** 计算地面路线和耗时，**Maps JavaScript API** 渲染地图。
- **FlyAI／飞猪** 提供航班查询与酒店、景点的商品和价格参考。酒店先由 Google Places 按片区找候选，再按具体酒店和入住日期向飞猪查询。最终价格与可订状态以供应方页面为准。
- **Next.js 路由、React、TypeScript、Vite／Vinext、Cloudflare Workers、D1 和 Drizzle** 提供页面、服务端接口及规划状态与分享快照的持久化。

## 本地复现

需要 Node.js 22.13 或更新版本，以及 `package.json` 指定的 pnpm 版本。先安装锁定依赖并构建。

```sh
pnpm install --frozen-lockfile
npm run build
```

### 无密钥检查

以下定向测试使用合成数据和模拟服务，覆盖意图理解、规划状态、多地点冲突、时间编辑和只读分享。

```sh
node --test --test-concurrency=1 tests/intent-fast-path.test.mjs tests/singapore-intent.test.mjs tests/planning-state.test.mjs tests/planning-conflicts.test.mjs tests/schedule-time-arrivals.test.mjs tests/shared-trip.test.mjs
```

### 接入真实服务

1. 复制 [`.env.example`](./.env.example) 为本地 `.dev.vars`。配置自己的百炼工作空间、Managed Agent 和 Google Maps API 凭据。需要查询飞猪时，在 Agent 中安装并配置 FlyAI Skill。
2. Google 服务端凭据用于 Places 与 Routes。浏览器地图密钥配置来源域名及 Maps JavaScript API 限制。服务端凭据仅保存于本地配置或部署平台的密钥管理。
3. 生产构建会生成 `dist/server/wrangler.json`。新建本地 D1 数据库按文件名顺序执行 `drizzle/` 下的 SQL，绑定名为 `DB`。已有数据库只应用尚未执行的迁移。

```sh
for file in drizzle/[0-9]*.sql; do
  node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file "$file" || exit 1
done
npm start -- --env-file .dev.vars
```

Windows PowerShell 可用同一套配置和迁移顺序。

```powershell
Get-ChildItem drizzle -Filter '*.sql' | Sort-Object Name | ForEach-Object {
  node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "D1 migration failed: $($_.Name)" }
}
npm start -- --env-file .dev.vars
```

打开终端给出的本地地址并访问 `/travel`。发布验证和各版本检查结果记在 [fix.md](./fix.md)。

## 已知范围与后续方向

景点开放信息为常规时段，实际安排可查场馆公告。国际航班参考查询可能出现缺少结果或接口错误，已订航班可手动录入。地面交通和到达时刻为规划估算。

1. **扩展目的地。** 将地点检索、区域词表和交通规则拆成可配置的目的地规则。
2. **增强按日意图理解。** 在旅行整体偏好之外，进一步识别某天的必去、避开、时段和留白要求。
3. **改进调整建议。** 结合营业窗口、交通和首末日限制，解释各个调整如何影响当天和跨天路线。

[案例图片署名](./TRAVEL_CASE_IMAGE_CREDITS.md) · [参赛 Issue #206](https://github.com/modelstudioai/modelstudioai.github.io/issues/206)
