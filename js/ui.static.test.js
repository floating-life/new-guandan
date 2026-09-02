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
assert(html.includes('id="selLocalEngine"') && html.includes('value="pimc-v1"')
  && html.includes('value="root-pimc-v1"') && html.includes('value="ismcts-v2"')
  && html.includes('成对根 PIMC（实验）'), '提供专家、PIMC、成对根 PIMC 与 ISMCTS v2 引擎开关');
assert(!html.includes('dmc-v1') && !ui.includes("engine === 'dmc-v1'"),
  'DMC 未具备可加载模型前不在产品选择器或复盘标签中伪装为可选引擎');
assert(ui.includes("applySettings(state, { localAiEngine: engine })")
  && ui.includes('公平信息集模拟') && ui.includes('成对根 PIMC 已启用'), '本地引擎开关接入设置并说明公平采样、成对覆盖与安全回退');
assert(ui.includes('localEngine.disabled') && ui.includes("实验搜索仅在大师难度运行"),
  '非大师难度禁用实验搜索选择器，并说明当前不会启用');
assert(html.includes('id="replayStatus"') && ui.includes('refreshReplayCollectorStatus'),
  '复盘状态胶囊展示本机采集器状态');
assert(ui.includes("'/api/replay/status'") && ui.includes('replayEventQueue.setEnabled')
  && ui.includes('setInterval'), '页面按服务端启用与缺口状态自动启停复盘提交');
assert(html.includes('id="replayCollectorPanel"') && html.includes('id="btnReplayPause"')
  && html.includes('id="btnReplayResume"') && html.includes('id="btnReplayClear"'),
  '采集控制提供暂停、恢复和清空待发');
assert(ui.includes('replaySubmitPaused') && ui.includes('clearPending')
  && ui.includes('readerConnected') && ui.includes('lastSequence')
  && ui.includes('retentionSeconds'),
  '采集面板展示最后序号、保留期和智能体连接，暂停不会被状态刷新覆盖');
assert(ui.includes('brokenMatchIds') && ui.includes('result.deferred')
  && ui.includes('下一副新对局会自动恢复'),
  '清空待发对链破坏给出明确警告，进行中提交时推迟清空而非竞争回执');
assert(ui.includes('replayCollectionInterruptedMatchId') && ui.includes('hasMatchTrace')
  && ui.includes('unreproducible_match')
  && ui.includes('当前对局采集链已中断、请新开一局以恢复采集')
  && ui.includes('新开一局自动恢复')
  && ui.includes('replayEventQueue.hasMatchTrace'),
  '待发队列被清空后恢复进行中对局会停止采集并提示新开一局自动恢复');
assert(ui.includes('replayCollectionInterruptedMatchId = null')
  && ui.includes("startMatch(state)"),
  '新开一局会清除采集中断标记并从 sequence 0 恢复采集');
assert(ui.includes('事件构造失败') && ui.includes('replayLastEventError')
  && ui.includes('replayObserverErrors'),
  '复盘胶囊暴露事件构造失败与观察器错误计数，便于定位缺口来源');
assert(ui.includes('混合搜索') && ui.includes('个可能牌面') && ui.includes('个模拟节点'),
  '逐手复盘展示混合层是否改选、采样数和模拟节点数');
assert(ui.includes('成对根 PIMC') && ui.includes('次成对 rollout'),
  '逐手复盘区分 PIMC 与成对根 PIMC，并展示真实 rollout 数');
assert(ui.includes('ISMCTS v3/成对 sweep') && ui.includes('次成对 sweep')
  && !html.includes('value="ismcts-v3"'),
  '复盘正确标注 ISMCTS v3/成对 sweep，但不把它加入产品选择器');
assert(html.includes('id="btnValueModel"') && html.includes('id="fileValueModel"')
  && ui.includes('configureAIWorkerValueModel') && ui.includes('restoreValueModel'),
 '界面可加载并在刷新后恢复经过本地校验的训练价值模型');
assert(html.includes('500 组未见种子镜像赛') && ui.includes('model_not_promoted'),
  '网页拒绝未晋级训练模型并明确展示发布门禁');
assert(ui.includes('persistThenActivateValueModel') && ui.includes('未启用新模型'),
  '模型保存失败时不会先启用新模型，并向用户说明当前状态');
assert(ui.includes('实际用炸、残局压力和相对座次') && ui.includes('不会把过牌当成'),
  '统计页说明真人画像只使用公开的领牌、应手、用炸与座次证据');
assert(html.includes('id="selOpponentModel"') && html.includes('value="observe"')
  && html.includes('value="adaptive"') && ui.includes('opponentModelMode')
  && ui.includes('100 副半衰期'), '提供本机画像的关闭、观察、自适应模式与时效说明');
assert(ui.includes('state.opponentModel = cleared.opponentModel')
  && ui.includes('state.opponentModel = getSkillStats().opponentModel')
  && ui.includes('persistMatch(state)'),
  '清空或导入统计后立即刷新本局真人画像并写入对局快照，不遗留旧策略偏置');
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
assert(ui.includes('llmReportHtml') && ui.includes('p95LatencyMs'), '复盘展示云端 API 调用报告');
console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
