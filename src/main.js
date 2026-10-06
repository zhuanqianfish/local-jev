import { LocalJev } from './jev.js';

const $ = (id) => document.getElementById(id);
const deviceStatus = $('device-status');
const bar = $('bar');
const statusText = $('status-text');
const resultsEl = $('results');

let jev = null;

// ---------- 预设 ----------
const PRESETS = {
  cs: {
    state: '客户留言：你们这个月账单多收了我200块钱，我已经打了三次电话了！再不解决我就投诉然后销号！',
    questions: {
      want_fix: { type: 'noul', statement: '客户正在要求退款或纠正账单' },
      team: {
        type: 'choice',
        options: {
          billing: '账单和费用问题',
          tech: '技术故障或产品使用问题',
          sales: '销售、套餐和业务咨询',
        },
      },
      anger: { type: 'score', levels: ['完全不生气', '有点不满', '很生气', '极其愤怒'] },
    },
  },
  mod: {
    state: '用户评论：这产品真是垃圾，浪费我500块钱，客服还爱答不理，大家千万别买！',
    questions: {
      toxic: { type: 'noul', statement: '这条内容包含辱骂或人身攻击' },
      intent: {
        type: 'choice',
        options: { complaint: '投诉和差评', question: '咨询和提问', praise: '表扬和好评' },
      },
      severity: { type: 'score', levels: ['无害', '轻微负面', '中度负面', '严重有害'] },
    },
  },
};

function applyPreset(name) {
  const p = PRESETS[name];
  $('state').value = p.state;
  $('questions').value = JSON.stringify(p.questions, null, 2);
}
$('preset-cs').onclick = () => applyPreset('cs');
$('preset-mod').onclick = () => applyPreset('mod');
applyPreset('cs');

// ---------- 环境 ----------
if (navigator.gpu) {
  deviceStatus.textContent = '✅ WebGPU 可用，将使用 GPU 加速推理';
  deviceStatus.classList.add('ok');
} else {
  deviceStatus.textContent = '⚠️ 无 WebGPU，将回退到 WASM（CPU）推理，速度较慢';
  deviceStatus.classList.add('warn');
}

// ---------- 加载 ----------
$('btn-load').onclick = async () => {
  const model = $('model').value.trim();
  if (!model) return alert('请填写模型 ID');
  $('btn-load').disabled = true;
  bar.style.width = '0%';
  try {
    if (jev) { await jev.release(); jev = null; }
    statusText.textContent = '下载 / 加载模型中（首次约 280MB，之后走浏览器缓存）…';
    jev = await LocalJev.create({
      model,
      progress: (p) => {
        if (p && typeof p.progress === 'number') {
          bar.style.width = Math.round(p.progress) + '%';
          statusText.textContent = `${p.status || ''} ${p.file || ''} ${Math.round(p.progress)}%`.trim();
        } else if (p && p.status) {
          statusText.textContent = `${p.status} ${p.file || p.name || ''}`.trim();
        }
      },
    });
    statusText.textContent = `✅ 模型就绪（${jev.device}）`;
    bar.style.width = '100%';
    $('btn-ask').disabled = false;
    $('btn-release').disabled = false;
  } catch (e) {
    console.error(e);
    statusText.textContent = '❌ 加载失败：' + (e?.message || e);
  } finally {
    $('btn-load').disabled = false;
  }
};

// ---------- 提问 ----------
$('btn-ask').onclick = async () => {
  if (!jev) return;
  let questions;
  try {
    questions = JSON.parse($('questions').value);
  } catch (e) {
    return alert('questions JSON 解析失败：' + e.message);
  }
  const state = $('state').value;
  if (!state.trim()) return alert('请填写 state');

  $('btn-ask').disabled = true;
  resultsEl.innerHTML = '';
  const t0 = performance.now();
  try {
    statusText.textContent = '判断中…（多个问题串行执行）';
    const out = await jev.ask(state, questions);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $('timing').textContent = `（${Object.keys(questions).length} 个问题，共用时 ${secs}s）`;
    statusText.textContent = '✅ 完成';
    render(out, questions);
  } catch (e) {
    console.error(e);
    statusText.textContent = '❌ 判断失败：' + (e?.message || e);
  } finally {
    $('btn-ask').disabled = false;
  }
};

$('btn-release').onclick = async () => {
  if (jev) { await jev.release(); jev = null; }
  $('btn-ask').disabled = true;
  $('btn-release').disabled = true;
  statusText.textContent = '模型已释放';
};

// ---------- 渲染 ----------
function render(out, questions) {
  for (const [name, ans] of Object.entries(out)) {
    const type = questions[name]?.type || '';
    const div = document.createElement('div');
    div.className = 'result';
    let html = `<div><span class="qname">${esc(name)}</span><span class="badge ${type}">${type}</span></div>`;
    if (type === 'noul') {
      html += `<div class="big">${ans.noul}</div>`;
      html += probBar('为真概率', ans.noul);
    } else if (type === 'choice') {
      html += `<div class="big">${esc(ans.choice)}</div>`;
      const entries = Object.entries(ans.probabilities).sort((a, b) => b[1] - a[1]);
      for (const [k, p] of entries) html += probBar(k, p, k === ans.choice);
      html += `<div class="conf">confidence: ${ans.confidence}</div>`;
    } else if (type === 'score') {
      const n = Object.keys(ans.probabilities).length;
      html += `<div class="big">${ans.score} <small>/ ${n} 档</small></div>`;
      for (const [lv, p] of Object.entries(ans.probabilities)) html += probBar(lv, p);
      html += `<div class="conf">confidence: ${ans.confidence}</div>`;
    } else {
      html += `<pre>${esc(JSON.stringify(ans, null, 2))}</pre>`;
    }
    div.innerHTML = html;
    resultsEl.appendChild(div);
  }
}

function probBar(label, p, highlight = false) {
  const pct = Math.round(p * 100);
  return `<div class="prow">
    <span class="lbl" title="${esc(label)}">${esc(label)}${highlight ? ' ⭐' : ''}</span>
    <span class="track"><span class="fill" style="width:${pct}%"></span></span>
    <span class="val">${p.toFixed(3)}</span>
  </div>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
