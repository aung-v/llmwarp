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
