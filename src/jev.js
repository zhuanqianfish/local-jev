import { pipeline } from '@huggingface/transformers';

/**
 * LocalJev —— 浏览器本地版 "System One" 判断模型。
 *
 * 对标 TypeSafe Jev 的 API 形状：state + questions 进，结构化判断出。
 * 底层是 NLI 零样本分类（MNLI/XNLI 模型），全部在浏览器本地跑（ONNX Runtime Web），
 * 无服务器、无 token 费用、数据不离本机。
 *
 * 三种问题原语：
 * - noul:   二元判断 → { noul: 0~1 的概率 }
 * - choice: 多选一路由 → { choice, probabilities, confidence }
 * - score:  有序量表评分 → { score, probabilities, confidence }
 */

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

export class LocalJev {
  constructor(classifier) {
    this.classifier = classifier;
  }

  /**
   * @param {Object} opts
   * @param {string} opts.model  Hugging Face 模型 ID（需为 NLI 零样本分类模型，带 ONNX 权重）
   * @param {string} opts.dtype  精度，默认 'q8'（int8 量化，体积小速度快）
   * @param {string} opts.hypothesisTemplate  NLI 假设模板，默认 '{}'（标签直接作为假设句）
   * @param {Function} opts.progress  进度回调
   */
  static async create({
    model = 'MoritzLaurer/mDeBERTa-v3-base-mnli-xnli',
    dtype = 'q8',
    hypothesisTemplate = '{}',
    progress = null,
  } = {}) {
    const isNode =
      typeof process !== 'undefined' && process?.release?.name === 'node';
    // Node 里 transformers.js 只支持 cpu/cuda；浏览器里用 webgpu（无则回退 wasm）
    const device = isNode
      ? 'cpu'
      : typeof navigator !== 'undefined' && navigator.gpu
        ? 'webgpu'
        : 'wasm';
    const classifier = await pipeline('zero-shot-classification', model, {
      device,
      dtype,
      progress_callback: progress || undefined,
    });
    const jev = new LocalJev(classifier);
    jev.hypothesisTemplate = hypothesisTemplate;
    jev.device = device;
    return jev;
  }

  /** state: 字符串或 JSON 对象；questions: { name: {type, ...} } */
  async ask(state, questions) {
    const text = typeof state === 'string' ? state : JSON.stringify(state);
    const out = {};
    for (const [name, q] of Object.entries(questions)) {
      if (q.type === 'noul') out[name] = await this.noul(text, q);
      else if (q.type === 'choice') out[name] = await this.choice(text, q);
      else if (q.type === 'score') out[name] = await this.score(text, q);
      else throw new Error(`未知问题类型: ${q.type}（应为 noul / choice / score）`);
    }
    return out;
  }

  /**
   * Noul: "这个陈述是否为真？" → 概率。
   * @param {string} statement 肯定陈述句，如 "客户正在要求退款"
   * @param {string} negation  否定陈述句，缺省自动生成 "并非：<statement>"
   */
  async noul(text, { statement, negation }) {
    if (!statement) throw new Error('noul 需要 statement（肯定陈述句）');
    const neg = negation || `并非：${statement}`;
    const probs = await this.#classifyProbs(text, [statement, neg]);
    return { noul: round4(probs[statement] ?? 0) };
  }

  /**
   * Choice: 从封闭选项集中选一个。
   * @param {Object|string[]} options { key: 描述 } 或 [标签]
   */
  async choice(text, { options }) {
    const { keys, labels } = normalizeOptions(options);
    if (labels.length < 2) throw new Error('choice 至少需要 2 个选项');
    const probs = await this.#classifyProbs(text, labels);
    const ranked = labels.slice().sort((a, b) => probs[b] - probs[a]);
    const best = ranked[0];
    const probabilities = {};
    for (const k of keys) probabilities[k] = round4(probs[labelOf(k, keys, labels)] ?? 0);
    return {
      choice: keyOf(best, keys, labels),
      probabilities,
      confidence: round4(probs[best]),
    };
  }

  /**
   * Score: 在有序量表上打分，返回期望值（1~N）+ 每档概率分布。
   * @param {string[]} levels 有序档位描述，如 ["完全不生气","有点不满","很生气","极其愤怒"]
   */
  async score(text, { levels }) {
    if (!Array.isArray(levels) || levels.length < 2)
      throw new Error('score 需要 levels（至少 2 档的有序数组）');
    const probs = await this.#classifyProbs(text, levels);
    let expected = 0;
    const probabilities = {};
    levels.forEach((lv, i) => {
      const p = probs[lv] ?? 0;
      probabilities[lv] = round4(p);
      expected += (i + 1) * p; // 1-based 量表期望
    });
    const confidence = Math.max(...levels.map((lv) => probs[lv] ?? 0));
    return { score: round2(expected), probabilities, confidence: round4(confidence) };
  }

  /** 底层：零样本分类 → { label: 概率 } */
  async #classifyProbs(text, candidateLabels) {
    const raw = await this.classifier(text, candidateLabels, {
      multi_label: false,
      hypothesis_template: this.hypothesisTemplate,
    });
    // transformers.js 返回 { sequence, labels: [...], scores: [...] }（scores 已 softmax）
    let labels, scores;
    if (raw && Array.isArray(raw.labels) && Array.isArray(raw.scores)) {
      ({ labels, scores } = raw);
    } else {
      // 兼容 [{ label, score }] 形状
      const items = Array.isArray(raw) ? raw : [raw];
      labels = items.map((it) => it.label);
      scores = items.map((it) => it.score);
    }
    const total = scores.reduce((s, x) => s + (x || 0), 0) || 1;
    const probs = {};
    labels.forEach((l, i) => {
      probs[l] = (scores[i] || 0) / total;
    });
    return probs;
  }

  async release() {
    await this.classifier?.dispose?.();
  }
}

function normalizeOptions(options) {
  if (Array.isArray(options)) return { keys: options.slice(), labels: options.slice() };
  const keys = Object.keys(options);
  return { keys, labels: keys.map((k) => options[k] || k) };
}
function labelOf(key, keys, labels) {
  return labels[keys.indexOf(key)];
}
function keyOf(label, keys, labels) {
  const i = labels.indexOf(label);
  return i >= 0 ? keys[i] : label;
}
