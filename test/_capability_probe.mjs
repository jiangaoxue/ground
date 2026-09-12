// 能力体检：把 Ground 丢进真实硬案例，看它哪儿是真的不行。
// 判据只有一条：回执说的和它真读到的是不是一回事。
import { fetchPage } from '../src/engine/page.js';

const CASES = [
  ['纯 HTML（基线）', 'https://example.com'],
  ['PDF（子集字体 + ToUnicode）', 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf'],
  ['PDF（加密）', 'https://www.orimi.com/pdf-test.pdf'],
  ['图片（非文本）', 'https://www.w3.org/Icons/w3c_home.png'],
  ['会跳转的地址', 'https://httpbingo.org/redirect/3'],
  ['JS 渲染的 SPA', 'https://react.dev/'],
  ['纯 JSON API', 'https://api.github.com/repos/jiangaoxue/ground'],
  ['超长页面', 'https://en.wikipedia.org/wiki/Artificial_intelligence'],
  ['中文页面', 'https://www.gov.cn/'],
  ['404 页面', 'https://example.com/definitely-not-here-xyz'],
];

let bad = 0;
for (const [label, url] of CASES) {
  const p = await fetchPage(url);
  const t = String(p.text || '');
  console.log('─'.repeat(78));
  console.log(`${label}`);
  console.log(`  来源       : ${p.final_url}${p.redirected ? `   <<< 从 ${p.requested_url} 跳转而来` : ''}`);
  console.log(`  status     : ${p.status}  (${p.content_type})`);
  console.log(`  reachable  : ${p.reachable}   readable: ${p.readable}`);
  console.log(`  chars_read : ${p.chars_read}   truncated: ${p.truncated}   error: ${p.error}`);
  if (!p.readable) console.log(`  不可读原因 : ${p.unreadable_reason}`);
  console.log(`  text 前 90 : ${JSON.stringify(t.slice(0, 90))}`);

  // 自相矛盾的检查：说"可达无错"却读不到内容，就是对买家撒谎
  if (p.reachable && !p.error && !p.readable && !p.unreadable_reason) {
    console.log('  ❌ 自相矛盾：可达、无错、读不到，且没有理由');
    bad += 1;
  }
  // 空文档必须解释清楚
  if (p.reachable && !p.error && !p.readable && p.unreadable_reason) {
    console.log('  ✅ 干净降级：读不到，并说明了原因');
  }
  // 声称可读就必须真有字
  if (p.readable && t.length < 3) {
    console.log('  ❌ 声称可读但没内容');
    bad += 1;
  }
}
console.log('─'.repeat(78));
console.log(bad === 0 ? '体检通过：没有一张回执在自相矛盾。' : `体检失败：${bad} 处回执自相矛盾。`);
