// RAVENアプリ用:海上保安庁の航行警報(公開ページ)を定期的に取得し、
// warnings.json にまとめて保存するスクリプト。
// 実行頻度は1時間に1回程度を想定(サイト側の更新頻度と同じ)。
//
// 取得先:
//   - 一覧: https://www1.kaiho.mlit.go.jp/TUHO/keiho/cgi/warnings.cgi (POST)
//   - 詳細: https://www1.kaiho.mlit.go.jp/TUHO/keiho/cgi/disp_warnings.cgi (GET)
// これらは海上保安庁の公開ページが内部で使っているのと同じ仕組みで、
// 一般の閲覧と同程度のアクセス頻度に抑えて利用する。

import fs from 'node:fs/promises';

const USER_AGENT = 'RAVEN-app/1.0 (personal non-commercial project; contact: eidakouta@gmail.com)';

const TYPES = [
  { code: 'NAVAREA11', label: 'NAVAREA XI' },
  { code: 'JAPANNW', label: '日本航行警報' },
  { code: 'NAVTEX', label: 'NAVTEX' },
];

const YEAR = new Date().getFullYear();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 全角文字(数字・記号)を半角に変換する(日本航行警報の原文が全角のため)
function toHalfWidth(str) {
  return str
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/−/g, '-')
    .replace(/　/g, ' ');
}

async function fetchList(typeCode) {
  const res = await fetch('https://www1.kaiho.mlit.go.jp/TUHO/keiho/cgi/warnings.cgi', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': USER_AGENT,
    },
    body: `YEAR=${YEAR}&TYPE=${typeCode}&LANG=JP`,
  });
  const xml = await res.text();
  const members = [...xml.matchAll(/<Member>([\s\S]*?)<\/Member>/g)].map((m) => m[1]);
  return members
    .map((block) => {
      const get = (tag) => {
        const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        return m ? m[1].trim() : '';
      };
      return {
        category: get('categoly'),
        number: get('number'),
        tana: get('tana'),
        title: get('title'),
      };
    })
    // 「有効一覧（9/26）」のような、個別警報ではないまとめ通知を除外する
    .filter((item) => !item.title.includes('有効一覧'));
}

async function fetchDetailHtml(typeCode, tana) {
  const url = `https://www1.kaiho.mlit.go.jp/TUHO/keiho/cgi/disp_warnings.cgi?TYPE=${typeCode}&TANA=${tana}&LANG=JP`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  const html = await res.text();
  return { html, url };
}

function extractBodyText(html) {
  const m = html.match(/<STRONG>([\s\S]*)/i);
  let text = m ? m[1] : html;
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
  return toHalfWidth(text);
}

function extractPublishedAt(text) {
  const m = text.match(/発表日時[:：]\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2})時/);
  if (!m) return null;
  const [, y, mo, d, h] = m;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00+09:00`;
}

// 本文中の度分秒(DMS)座標を拾い、緯度経度のペアに組み立てる。
// 例: "28-15-15N 146-29-47E" → { lat: 28.25..., lon: 146.49... }
function extractCoordinatePairs(text) {
  const re = /(\d{2,3})-(\d{2})(?:-(\d{2}))?\s*([NSEW])/g;
  const tokens = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const deg = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const sec = m[3] ? parseInt(m[3], 10) : 0;
    let val = deg + min / 60 + sec / 3600;
    const dir = m[4];
    if (dir === 'S' || dir === 'W') val = -val;
    tokens.push({ dir, val });
  }

  const pairs = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    const aIsLat = a.dir === 'N' || a.dir === 'S';
    const bIsLon = b.dir === 'E' || b.dir === 'W';
    if (aIsLat && bIsLon) {
      pairs.push([b.val, a.val]); // [lon, lat]
      i++; // 消費した2つ分読み飛ばす
    }
  }
  return pairs;
}

function buildGeometry(pairs) {
  if (pairs.length === 0) return null;
  if (pairs.length === 1) return { type: 'point', coordinates: pairs[0] };
  if (pairs.length === 2) return { type: 'line', coordinates: pairs };
  return { type: 'polygon', coordinates: pairs };
}

async function main() {
  const results = [];

  for (const t of TYPES) {
    console.log(`--- ${t.label} (${t.code}) の一覧を取得中 ---`);
    const list = await fetchList(t.code);
    console.log(`${list.length}件`);

    for (const item of list) {
      await sleep(250); // サイトへの負荷を抑えるための小休止
      try {
        const { html, url } = await fetchDetailHtml(t.code, item.tana);
        const text = extractBodyText(html);
        const publishedAt = extractPublishedAt(text);
        const geometry = buildGeometry(extractCoordinatePairs(text));

        results.push({
          id: `${t.code}-${item.tana}`,
          type: t.code,
          typeLabel: t.label,
          category: item.category,
          number: item.number,
          title: item.title,
          publishedAt,
          geometry,
          rawText: text,
          sourceUrl: url,
        });
      } catch (e) {
        console.error(`詳細取得に失敗: ${t.code} ${item.tana}: ${e.message}`);
      }
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    disclaimer:
      'このデータは海上保安庁の公開ページ(航行警報)を自動で要約・構造化したものです。公式情報は必ず一次情報源(sourceUrl)でご確認ください。',
    count: results.length,
    warnings: results,
  };

  await fs.writeFile('warnings.json', JSON.stringify(out, null, 2), 'utf-8');
  console.log(`完了: ${results.length}件を warnings.json に保存しました`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
