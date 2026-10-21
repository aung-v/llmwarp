# llmwarp

llmwarp 是一个本机的 OpenAI 兼容代理：客户端只看到 `warp` 和本地端点，真实上游由配置决定。

## Language

**Target（上游目标）**:
请求最终落到的那一个上游身份：provider + model + endpoint 三者合起来才算一个 target。
_Avoid_: 供应商、模型、路由目标

**Media part（媒体块）**:
请求体 content 数组里承载 image / audio / file / video 的那一个元素。
_Avoid_: 附件、二进制块、图片字段

**Input filter（输入过滤）**:
按 target 配置的开关，决定请求体里的 image / audio / file / video 媒体块在转发前是否被移除。
_Avoid_: strip、reject、媒体过滤

**Filter note（过滤说明）**:
媒体块被移除时，在原位置留下的一句短文本，让模型和用户知道这里原本有什么被去掉了。
_Avoid_: 占位符、marker、提示语

**Reasoning switch（思考强度开关）**:
按 target 配置的一个值，决定转发时如何处理请求里的思考强度：不修改 / 关闭 / 具体等级。
_Avoid_: reasoning 模式、thinking 开关

**Reasoning level（思考等级）**:
llmwarp 固定提供的一组等级名：none / minimal / low / medium / high / xhigh / max / ultra；关闭等于 none。
_Avoid_: effort 名单、上游等级

**Warp mode（warp 模式）**:
TUI 里的一个**全局**开关（配置键仍是 `useClientModel`）：按客户端请求里的 `model` 名转发，还是统一替换成当前选中的模型。它不是按模型的设置。
_Avoid_: 模型模式、路由模式、模型路由

**Settings block（选中模型设置）**:
模型页右栏、随选中模型变化的那一块：按模型列出输入过滤开关与思考强度，末尾是全局的 warp 模式行。
_Avoid_: 面板、弹窗、浮动层

**Stale daemon（旧版本守护进程）**:
由更早的 CLI 构建启动、仍在运行的守护进程：`daemon.json` 里的版本与当前 `VERSION` 不一致，新配置键会被它静默忽略，需要 `llmwarp start` 重启才能升级。
_Avoid_: 过期进程、未升级进程
