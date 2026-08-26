/** 响应式与无障碍静态契约测试。 */
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../css/style.css', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { passed++; console.log('  ✓', message); }
  else { failed++; console.error('  ✗', message); }
}

console.log('移动端信息架构');
assert(css.includes('@media (max-width: 1180px)'), '在拥挤前提前切换单栏布局');
assert(/grid-template-areas:\s*\n\s*"stage"\s*\n\s*"eval"\s*\n\s*"log"/.test(css), '单栏顺序为牌桌、评价、日志');
assert(css.includes('@media (max-width: 640px)'), '提供手机专用断点');
assert(css.includes('position: sticky') && css.includes('#actionBar'), '手机操作条吸底');
assert(html.indexOf('id="actionBar"') < html.indexOf('id="playerHand"'), '操作区位于手牌上方，笔记本无需向下滚动');
assert(html.includes('id="declarationChips"') && ui.includes('renderDeclarationChips'), '支持自定义牌型声明');
assert(html.includes('id="endHands"') && ui.includes('renderEndHands'), '每副结束自动亮出未出完AI手牌');
assert(html.includes('<option value="master">大师</option>'), '难度选择提供大师模式');
assert(html.includes('大师模式') && html.includes('不读取其他玩家未公开手牌'), '规则说明公开大师模式与公平信息边界');
assert(html.includes('id="selLocalEngine"') && html.includes('value="hybrid"')
  && html.includes('混合搜索（实验）'), '提供显式的专家策略/混合搜索本地引擎开关');
assert(ui.includes("applySettings(state, { localAiEngine: engine })")
  && ui.includes('公平信息集模拟'), '本地引擎开关接入设置并说明公平采样与安全回退');
assert(ui.includes('混合搜索：') && ui.includes('个可能牌面') && ui.includes('个模拟节点'),
  '逐手复盘展示混合层是否改选、采样数和模拟节点数');
assert(/--card-w:\s*48px/.test(css), '手机牌张缩小以避免横向裁切');

console.log('无障碍契约');
assert((html.match(/role="dialog"/g) || []).length === 4, '四个弹窗均有 dialog 语义');
assert((html.match(/aria-modal="true"/g) || []).length === 4, '四个弹窗均声明 aria-modal');
assert(html.includes('aria-live="assertive"') && html.includes('aria-live="polite"'), '关键状态提供实时播报');
assert(ui.includes("el(selectable ? 'button' : 'div', 'card')"), '可选择牌使用原生按钮');
assert(ui.includes("setAttribute('aria-pressed'"), '牌张暴露选中状态');
assert(ui.includes('trapModalTab') && ui.includes("e.key === 'Escape'"), '弹窗支持焦点循环与 Esc');
assert(css.includes('@media (prefers-reduced-motion: reduce)'), '尊重系统减少动画设置');

assert(html.includes('id="selLLMMode"') && html.includes('value="cloud"'), '提供本地/智能增强/云端增强模式');
assert(html.includes('id="llmStatus"') && html.includes('id="btnLLMCheck"'), '提供 API 状态提示与检测按钮');
assert(html.includes('id="btnLLMConfig"') && html.includes('id="llmApiKey"'), '提供网页 API 配置面板');
assert(html.includes('DPAPI') && html.includes('不会写入浏览器存储'), '说明 API Key 的本机加密持久化边界');
assert(ui.includes('getLLMConfig') && ui.includes('updateLLMConfig') && ui.includes('submitLLMConfig'), 'API 配置面板连接本机代理');
assert(ui.includes('promptTokens') && ui.includes('totalTokens'), 'API 报告展示 Token 使用量');
assert(ui.includes('retry_wait') && ui.includes('llmFallbackActive'), '临时故障自动重试，配置故障才全场景本地 AI');
assert(ui.includes('下一关键回合重试') && ui.includes('尚未发起真实调用'),
  '临时退避状态与零调用报告说明真实重试时机');
assert(ui.includes("refreshLLMHealth({ silent: false, recover: true, deep: true })"),
  '切换到云端增强时深度验证成功可解除上一局本地回退标记');
assert(ui.includes("llmHealth.state === 'unverified'") && ui.includes('resetLLMFallback'),
  '健康端点不支持时，手动检测仍可解除旧回退并交给首手真实验证');
assert(!ui.includes('setUpdateCallback(() => {\n  persistMatch(state);'), '状态通知只保存一次，不在UI回调重复序列化存档');
assert(ui.includes("llmPolicyMode || LLM_POLICY_MODE.LOCAL) !== LLM_POLICY_MODE.LOCAL"), '本地AI启动时不主动检测云端API');
assert(html.includes('整局多次调用可能让第三方服务累计看到多名电脑玩家手牌'), '界面明确提示云端整局累计隐私范围');
console.log(`\n结果: ${passed} passed, ${failed} failed`);
assert(ui.includes('llmReportHtml') && ui.includes('p95LatencyMs'), '复盘展示云端 API 调用报告');
process.exit(failed ? 1 : 0);
