# 实施计划：按 target 过滤媒体输入

## 步骤

1. 配置层（`src/config.ts`）
   - 增加 `InputFilterConfig` / `TargetConfig` 类型；`Provider` 增加 `inputFilter` / `targets`。
   - `normalizeConfig` 解析三层配置；值非布尔时抛错，消息带字段路径。
   - 新增 `resolveInputFilter(provider, model, endpoint)`；endpoint 用 `stripVersionPrefix` + 去尾部 `/` 归一化。
   - 测试：`test/config.test.ts` 增加 provider / model / endpoint 覆盖与非法值用例。
2. 过滤纯函数（新增 `src/inputfilter.ts`）
   - 实现 `applyInputFilter(body, filter)`，返回 `{ body, filtered }`。
   - 全关快捷路径、JSON 解析失败、媒体白名单、说明插入、Chat 扁平化。
   - 新增 `test/input-filter.test.ts`：Chat / Responses / `function_call_output` / `computer_call_output` 不动 / 非 JSON / 全关 identity / 同数组合并 / 只剩文本扁平化。
3. 请求路径（`src/server.ts`）
   - `handleProxy` 解析路由后调用 `resolveInputFilter` 与 `applyInputFilter`。
   - `proxyRequest` 传 `options.body = forwardBody`。
   - `finalize()` 写 `RequestEvent.inputFilter`；`metrics.record` 透传。
   - 过滤数 > 0 时 `debugLog`。
4. 统计与 TUI
   - `src/stats/event.ts` 增加可选 `inputFilter`。
   - `src/metrics.ts` 的 `RequestActivity` 增加同名字段。
   - `src/tui/model.ts` 解析；`src/tui/render.ts` 活动行追加 `img×2` 之类摘要。
   - 测试：`test/metrics.test.ts`、`test/tui.test.ts` 补字段与渲染断言。
5. 文档同步
   - `.trellis/spec/backend/usage-stats.md`：`RequestEvent` 字段清单 + 测试清单。
   - `README.md` / `docs/README.zh-CN.md`：配置示例与过滤语义、默认不过滤、不处理 multipart / computer 截图。
6. 验证
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```

## 评审门 / 止损点

- 先做步骤 1–2，跑 `npm run typecheck` + 相关单测，确认过滤算法与配置解析稳定，再接入 server。
- 接入后先跑 `test/server.test.ts` / `test/proxy.test.ts`，确认 body 改写与统计字段，再动 TUI 与文档。

## 回滚

- 改动集中在 config / inputfilter / server / stats / tui 与测试、文档；无数据迁移。
- 回滚 = revert 对应 commit；旧 JSONL 行没有新字段不受影响。
