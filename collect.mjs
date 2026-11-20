// 하루 3번: 골드박스 + 전 카테고리 베스트(로켓배송만)를 모으고, Gemini가 시간대별 추천을 골라 data/candidates.json 에 저장
import fs from 'node:fs';
import path from 'node:path';
import { DATA, readJson, writeJson, goldbox, bestCategory, gemini, sleep, kstNow, appList, appDelete } from './lib.mjs';

// 쿠팡 파트너스 베스트 카테고리 (여행 제외 전부)
const CATEGORIES = [
  [1012, '식품'], [1014, '생활용품'], [1013, '주방용품'], [1016, '가전디지털'],
  [1015, '홈인테리어'], [1024, '헬스/건강식품'], [1010, '뷰티'], [1011, '출산/유아동'],
  [1030, '유아동패션'], [1020, '완구/취미'], [1029, '반려동물'], [1017, '스포츠/레저'],
  [1018, '자동차용품'], [1021, '문구/오피스'], [1019, '도서/음반'], [1001, '여성패션'], [1002, '남성패션']
];
const PER_CATEGORY = Number(process.env.PER_CATEGORY || 20);
const ROCKET_ONLY = process.env.ROCKET_ONLY !== 'false'; // 기본: 로켓배송(로켓프레시 포함)만
const SKIP_DAYS = 30; // 최근 30일 안에 올린 상품은 제외

function norm(p, source, category) {
  return {
    id: String(p.productId),
    name: p.productName,
    price: p.productPrice ?? null,
    originalPrice: p.originalPrice ?? null,
    discountRate: p.discountRate ?? null,
    image: p.productImage,
    url: p.productUrl,
    rocket: !!p.isRocket,
    freeShip: !!p.isFreeShipping,
    category: p.categoryName || category || '',
    rank: p.rank ?? null,
    source
  };
}

// ---------------- 시간대별 추천 ----------------
const SLOTS = [
  { key: 'morning', name: '아침', time: '7~9시', who: '출근, 등원 준비하며 폰 보는 직장인과 부모' },
  { key: 'lunch', name: '점심', time: '12~13시', who: '점심 먹고 쉬는 직장인, 장보기 앱 여는 주부' },
  { key: 'evening', name: '저녁', time: '19~21시', who: '퇴근 후, 아이 재우기 전 가족' },
  { key: 'night', name: '밤', time: '22~24시', who: '누워서 쇼핑하는 사람, 내일 새벽배송 받을 사람' }
];

async function recommend(items, history) {
  const now = new Date(Date.now() + 9 * 3600e3);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const list = items.map((i, k) => `${k}|${i.name.slice(0, 60)}|${i.price ?? ''}원${i.discountRate ? `|${i.discountRate}%할인` : ''}|${i.category}|${i.source}${i.rank ? ' ' + i.rank + '위' : ''}`).join('\n');
  const recent = history.posted.slice(0, 20).map(h => `- ${h.postedKst || ''} ${h.name}`).join('\n') || '(없음)';
  const prompt = `너는 스레드 쇼핑 계정 "서·운·아빠 Pick Deal"의 상품 기획자야. 팔로워는 30~40대 직장인, 아이 키우는 부모, 살림하는 사람.
지금은 ${now.getUTCFullYear()}년 ${now.getUTCMonth() + 1}월 ${now.getUTCDate()}일 (${days[now.getUTCDay()]}) ${now.getUTCHours()}시야.
아래 쿠팡 로켓배송 후보 중에서 시간대별로 올리기 좋은 상품을 골라줘.

[기준]
- 그 시간대에 폰을 보는 사람의 상황에 딱 맞는 것 (계절, 날씨, 요일, 다가오는 행사나 시즌 고려)
- 많은 사람이 살 만하고 1~5만 원대처럼 바로 결제하기 쉬운 것 우선. 단, 골드박스 큰 할인은 가격대 상관없이 고려
- 최근 올린 상품과 겹치거나 비슷한 것 제외, 시간대끼리도 겹치지 않게, 카테고리 고르게
- 밤 시간대는 식품, 생필품처럼 새벽배송 받기 좋은 것 우선

[시간대]
${SLOTS.map(s => `- ${s.key}: ${s.name} ${s.time} (${s.who})`).join('\n')}

[최근 올린 상품]
${recent}

[후보] 번호|상품명|가격|할인|카테고리|출처
${list}

[출력] 시간대마다 5개, JSON만:
{"slots":[{"key":"morning","picks":[{"no":0,"reason":"왜 지금 이 시간에 (30자 이내)","hook":"첫 줄 아이디어, 상품명 없이 상황으로 (30자 이내 반말)"}]}]}`;
  const g = await gemini(prompt);
  const used = new Set();
  return SLOTS.map(s => {
    const got = (g.slots || []).find(x => x.key === s.key) || { picks: [] };
    const picks = (got.picks || []).map(p => ({ item: items[Number(p.no)], reason: p.reason, hook: p.hook }))
      .filter(p => p.item && !used.has(p.item.id) && used.add(p.item.id))
      .slice(0, 5)
      .map(p => ({ id: p.item.id, reason: String(p.reason || ''), hook: String(p.hook || '') }));
    return { key: s.key, name: s.name, time: s.time, picks };
  });
}

async function main() {
  const history = readJson(path.join(DATA, 'history.json'), { posted: [] });
  const cutoff = Date.now() - SKIP_DAYS * 864e5;
  const recent = new Set(history.posted.filter(h => new Date(h.postedAt).getTime() > cutoff).map(h => String(h.productId)));

  const items = [];
  const seen = new Set();
  let skippedRocket = 0;
  const add = it => {
    if (!it.id || seen.has(it.id) || recent.has(it.id)) return;
    if (ROCKET_ONLY && !it.rocket) { skippedRocket++; return; }
    seen.add(it.id);
    items.push(it);
  };

  try {
    const gb = await goldbox();
    (gb || []).forEach(p => add(norm(p, '골드박스')));
    console.log(`골드박스 ${gb?.length || 0}개`);
  } catch (e) { console.log('골드박스 실패:', e.message); }

  for (const [id, name] of CATEGORIES) {
    await sleep(1200);
    try {
      const list = await bestCategory(id, PER_CATEGORY);
      (list || []).forEach(p => add(norm(p, '베스트', name)));
      console.log(`${name} 베스트 ${list?.length || 0}개`);
    } catch (e) { console.log(`${name} 실패:`, e.message); }
  }

  if (!items.length) throw new Error('모은 상품이 없어요. 쿠팡 키를 확인해주세요.');
  console.log(`후보 ${items.length}개 (로켓배송 아님 ${skippedRocket}개 제외)`);

  let recs = [];
  try { recs = await recommend(items, history); console.log('시간대별 추천 완료'); }
  catch (e) { console.log('추천 실패:', e.message); }

  writeJson(path.join(DATA, 'candidates.json'), { updatedAt: kstNow(), items, recs });
  await cleanupVideos().catch(e => console.log('영상 정리 건너뜀:', e.message));
}

// 버린 초안의 릴스 영상, 그림을 공개 저장소에서 정리
async function cleanupVideos() {
  if (!process.env.GH_PAT) return;
  const dir = path.join(DATA, 'drafts');
  const used = new Set((fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(f => f.endsWith('.json'))
    .flatMap(f => { const d = readJson(path.join(dir, f), {}); return [d?.video?.path, d?.illust?.path]; }).filter(Boolean));
  let n = 0;
  for (const f of await appList('media')) {
    const made = parseInt(f.name.replace(/\.(mp4|png)$/, '').split('-').pop(), 36);
    const old = !made || Date.now() - made > 864e5; // 만든 지 하루 지난 것만
    if (/\.(mp4|png)$/.test(f.name) && old && !used.has(f.path)) { await appDelete(f.path); n++; }
  }
  if (n) console.log(`안 쓰는 파일 ${n}개 정리`);
}

main().catch(e => { console.error(e); process.exit(1); });
