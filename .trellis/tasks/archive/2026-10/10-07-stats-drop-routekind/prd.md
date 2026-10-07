# 统计维度去掉 routeKind：按上游身份聚合

## Goal

统计只描述**上游**：同一条上游流量不该因为「从哪个入口进来」被拆成多行。用户原话：
「我们在给上游做统计，不关心从哪路由来的。」

## Background

- 现有聚合键是 `provider + model + endpoint + routeKind`，导致同一个上游模型被拆成
  `warp` / `按客户端` / `被开关覆盖` 等多行；表格必须再加「路由」列才能区分，而多数情况下
  该列对每一行都是同一个词（用户实际数据只有 1 个目标、全是 `warp`），纯占宽度。
- 统计页的「过滤」行与 `f` 键整套过滤器都建立在 routeKind 上，同理失去意义。
- `unrouted` 不是「入口」，而是**根本没到上游**（路由失败 / 请求体不可读 / API key 缺失），
  它是「上游统计」的补集，必须保留。

## 需求

1. 聚合键 = `provider + model + endpoint`；不同 routeKind 的事件合并进同一个 target。
2. 表格删除「路由」列；统计页删除「过滤」行与 `f` 键；选中详情标题去掉 routeKind。
3. `unrouted` 仍单独计数（`未发出`），不进入 targets/days/hours。
4. `.trellis/spec/backend/usage-stats.md`：统计键说明改为上游身份；出口矩阵维度里的
   `routeKind` 去掉；补充「常量列自动隐藏」规则。
5. 端点列：可见行里 `endpoint` 全相同时自动隐藏；窄终端同样让位给数值列。
6. TUI 解析兼容旧 daemon 载荷（仍带 `routeKind` 时忽略该字段，不报错）。
7. `routeKind` / `requestedModel` / `routingMode` 仍写 JSONL（审计 + 判定 unrouted），只是不进统计维度。

## 明确不做

- 不动版本号（保持 1.1.0）。
- 不改任何指标的计算口径（分位、错误率、tok/s、上游视图不变）。
- 不删 `unrouted` 计数与「未发出」展示。
- 不改 JSONL 事件 schema（routeKind 继续落盘）。

## Acceptance Criteria

- [ ] 同一 provider/model/endpoint 下 `warp` + `overridden` 两个事件合成 1 个 target，requests 相加。
- [ ] `overall.requests === Σ targets.requests` 不变；`unrouted` 不进 targets。
- [ ] 表格无「路由」列；页面无「过滤」行；`f` 键不再是统计页动作（改由 footer/spec 说明）。
- [ ] 端点列在全常量时隐藏，混用不同 endpoint 时出现；两种情况下渲染都不越界。
- [ ] 旧载荷（targets 带 routeKind）仍能解析并渲染，`未发出/—` 行不报错。
- [ ] `npm run typecheck` / `npm run build` / `npm test` 全绿；版本号仍为 `1.1.0`。
