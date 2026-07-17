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
assert(/--card-w:\s*48px/.test(css), '手机牌张缩小以避免横向裁切');

console.log('无障碍契约');
assert((html.match(/role="dialog"/g) || []).length === 3, '三个弹窗均有 dialog 语义');
assert((html.match(/aria-modal="true"/g) || []).length === 3, '三个弹窗均声明 aria-modal');
assert(html.includes('aria-live="assertive"') && html.includes('aria-live="polite"'), '关键状态提供实时播报');
assert(ui.includes("el(selectable ? 'button' : 'div', 'card')"), '可选择牌使用原生按钮');
assert(ui.includes("setAttribute('aria-pressed'"), '牌张暴露选中状态');
assert(ui.includes('trapModalTab') && ui.includes("e.key === 'Escape'"), '弹窗支持焦点循环与 Esc');
assert(css.includes('@media (prefers-reduced-motion: reduce)'), '尊重系统减少动画设置');

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
