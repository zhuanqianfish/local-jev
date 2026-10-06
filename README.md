# 本地版 Jev —— 浏览器端 System One 判断模型

对标 TypeSafe Jev（2026-09 发布）的 API 形状：**state + questions 进，结构化判断出**。
区别在于全部在浏览器本地跑（ONNX Runtime Web / transformers.js），零 token 费用、数据不离本机。

```
const jev = await LocalJev.create();   // 一次加载，多次复用

const out = await jev.ask(
  '客户留言：账单多收了我200块，打了三次电话，再不解决就投诉销号！',
  {
    want_fix: { type: 'noul', statement: '客户正在要求退款或纠正账单' },
    team: { type: 'choice', options: {
      billing: '账单和费用问题',
      tech: '技术故障或产品使用问题',
      sales: '销售、套餐和业务咨询',
    }},
    anger: { type: 'score', levels: ['完全不生气', '有点不满', '很生气', '极其愤怒'] },
  }
);
// {
//   want_fix: { noul: 0.93 },
//   team: { choice: 'billing', probabilities: { billing: 0.91, tech: 0.06, sales: 0.03 }, confidence: 0.91 },
//   anger: { score: 3.42, probabilities: {...}, confidence: 0.58 },
// }
```

## 运行 demo

```bash
cd ~/workspace/local-jev
npm install
npm run dev
```

Chrome / Edge 打开 `http://localhost:5173` → 加载模型（首次下载约 280MB，之后走浏览器缓存）→ 选预设或自己写 questions → 运行判断。

## API（src/jev.js，可直接搬到你自己的项目）

`LocalJev.create({ model, dtype, hypothesisTemplate, progress })`
- `model`：NLI 零样本分类模型（带 ONNX 权重）。默认 `MoritzLaurer/mDeBERTa-v3-base-mnli-xnli`
  （多语言含中文，原生带 `onnx/model_quantized.onnx`）。英文场景可换 `Xenova/bart-large-mnli`。
- `dtype`：默认 `'q8'`。`device` 自动选 webgpu（无则回退 wasm）。

`jev.ask(state, questions)` —— state 为字符串或 JSON 对象；questions 为 `{ 名字: 问题定义 }`：

| 类型 | 定义 | 返回 |
|---|---|---|
| `noul` | `{ statement, negation? }` 肯定/否定陈述句 | `{ noul: 0~1 }` |
| `choice` | `{ options: {key: 描述} 或 [标签] }` | `{ choice, probabilities, confidence }` |
| `score` | `{ levels: [档1, …, 档N] }` 有序 | `{ score（1~N 期望）, probabilities, confidence }` |

**写好 questions 的关键**：用**陈述句**而非疑问句（NLI 模型吃"前提→假设"结构）；
choice 的每个选项给一句清晰的描述而非单个词；score 的档位之间保持等距语义。

## 和 Jev 的对比

| | TypeSafe Jev | 本地版 Jev（本项目） |
|---|---|---|
| 输出 | noul / choice / score 原语 | 同样三种，API 形状对齐 |
| 延迟 | 70~500ms（含网络） | 本地 10~200ms/问题（WebGPU） |
| 费用 | $0.042 / 1M input tokens | 0（权重下载一次） |
| 隐私 | state 发到云端 | 全本地 |
| 模态 | 目前仅文本 | 文本（NLI）；图像版可用 CLIP 零样本照此模式再包一层 |
| 概率校准 | RLCD 专门训练 | 通用 NLI 零样本的 softmax，不如专用校准模型 |
| 问题理解 | 自然语言理解问题本身 | 靠"标签描述"间接表达，复杂条件不如 Jev |

## 值得关注的开源动向

- `wfzyx/von`（2026-09-19，Apache 2.0）：社区做的开源 System One 决策模型，
  ModernBERT-large 底，自带 `calibration.json`，tag 里直接写了 `jevbench` / `calibrated`。
  目前只有 safetensors 无 ONNX，转出 ONNX 后可直接替换本项目的默认模型，校准度会更好。

## 已知限制（诚实版）

1. **校准不如 Jev**：零样本 NLI 的概率是 softmax 副产品，没有经过 RLCD 这类校准训练，
   0.9 不一定真的是 90% 把握。阈值要按你的业务数据调。
2. **一次一个问题**：Jev 单次请求并行多问题；这里是串行循环（可自行改成 batch）。
3. **长文本截断**：NLI 模型一般 512 token 上下文，state 太长会被截断，大文档先摘要或切片。
4. **英文模型更准**：默认多语言模型中文可用，但英文 NLI 模型在英文任务上通常更准。
