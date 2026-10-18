# 实施计划：按 target 设置思考强度

## 前置

- 先完成 `input-media-filter`：同一套三层 target 配置、endpoint 归一化、`RequestEvent` / `RequestActivity` 可选字段的写法都在那个任务里落地。

## 步骤

1. 配置层（`src/config.ts`）
   - 增加 `ReasoningSetting` 类型；`Provider` 增加 `reasoning`；`TargetConfig` / `endpoints` 增加 `reasoning`。
   - `normalizeConfig` 解析并校验固定集合；非法值抛错，消息带字段路径。
   - 新增 `resolveReasoning(provider, model, endpoint)`。
   - 测试：`test/config.test.ts` 增加 provider / model / endpoint 覆盖与非法值用例。
2. 纯函数（新增 `src/reasoning.ts`）
   - 实现 `applyReasoning(body, endpoint, setting)` → `{ body, requested, applied }`。
   - `passthrough` 快路径；chat / responses 字段规则；删等价字段。
   - 新增 `test/reasoning.test.ts`：responses/chat 写入、关闭写 none、覆盖客户端值、客户端没带时注入、不修改 identity、写错 endpoint 不动、非 JSON 原样。
3. 请求路径（`src/server.ts`）
   - `handleProxy` 在 input filter 之后调用 `applyReasoning`。
   - `proxyRequest` 用返回的 body；`finalize()` 写 `RequestEvent.reasoning` 和 `metrics.record(...)`；`applied !== null` 时 `debugLog`。
4. 统计与 TUI
   - `src/stats/event.ts` 增加可选 `reasoning`；`src/metrics.ts` 的 `RequestActivity` 增加同名字段。
   - `src/tui/model.ts` 解析；`src/tui/render.ts` 活动行追加 `rsn medium→high` 之类摘要。
   - 测试：`test/metrics.test.ts`、`test/tui.test.ts`。
5. 文档同步
   - `.trellis/spec/backend/usage-stats.md`：字段清单 + 测试清单。
   - `README.md` / `docs/README.zh-CN.md`：配置示例与“不修改 / 关闭 / 等级”语义。
6. 验证
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```

## 评审门 / 止损点

- 先做步骤 1–2，跑 `npm run typecheck` + `test/reasoning.test.ts`，确认字段规则稳定，再接入 server。
- 接入后先跑 `test/server.test.ts`，确认写入的 body 与统计字段，再动 TUI 与文档。

## 回滚

- 改动集中在 config / reasoning / server / stats / tui 与测试、文档；无数据迁移。
- 回滚 = revert 对应 commit；旧 JSONL 行没有新字段不受影响。
