/* Exact Worksheet Maker — Diagram Engine
 * Pure vanilla JS, no external libraries. Renders math diagrams (function
 * graphs, geometry, number lines, Venn diagrams, statistics charts, factor
 * trees) as inline SVG strings, driven by a compact tag syntax embedded in
 * the raw worksheet text: [[type: key=value; key2=value2]].
 */

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

function escText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function numOrDefault(v, def) {
  // Koma desimal ala Indonesia ("8,66", "8,66 m"): tanpa ini parseFloat berhenti di koma
  // dan diam-diam memotong jadi 8. Daftar ("1,2,3") dan "0,0" tidak terpengaruh nilainya.
  const t = typeof v === 'string' ? v.replace(/^(\s*-?\d+),(\d+)(?=[^\d,.:|;]*$)/, '$1.$2') : v;
  const n = parseFloat(t);
  return isFinite(n) ? n : def;
}

function niceStep(range) {
  const raw = range / 8;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const norm = raw / mag;
  let step;
  if (norm < 1.5) step = 1;
  else if (norm < 3.5) step = 2;
  else if (norm < 7.5) step = 5;
  else step = 10;
  return step * mag || 1;
}

const MATH_FUNCS = [
  'asin', 'acos', 'atan', 'sin', 'cos', 'tan', 'sqrt', 'abs',
  'log10', 'log', 'exp', 'floor', 'ceil', 'round', 'min', 'max', 'pow',
];

// JS's native "**" rejects a unary minus directly before it (e.g. "-(x-1)**2"
// throws a SyntaxError — "Unary operator used immediately before exponentiation
// expression"), which silently broke any "^" expression shaped like -(...)^n.
// Converting "A^B" to a POW(A,B) call instead sidesteps the whole grammar
// restriction: a function call is never ambiguous with a leading unary minus,
// and -POW(x,2) correctly means -(x^2) — the standard math reading of -x^2.
function convertCaretToPow(expr) {
  let s = expr;
  const leftAtomRe = /((?:[A-Za-z_][A-Za-z0-9_.]*)?\([^()]*\)|[A-Za-z0-9_.]+)$/;
  const rightAtomRe = /^(-?(?:[A-Za-z_][A-Za-z0-9_.]*)?\([^()]*\)|-?[A-Za-z0-9_.]+)/;
  for (let guard = 0; guard < 30; guard++) {
    const idx = s.indexOf('^');
    if (idx === -1) break;
    const leftPart = s.slice(0, idx);
    const rightPart = s.slice(idx + 1);
    const leftMatch = leftPart.match(leftAtomRe);
    const rightMatch = rightPart.match(rightAtomRe);
    if (!leftMatch || !rightMatch) break;
    const left = leftMatch[0];
    const right = rightMatch[0];
    const before = leftPart.slice(0, leftPart.length - left.length);
    const after = rightPart.slice(right.length);
    s = before + 'POW(' + left + ',' + right + ')' + after;
  }
  return s;
}

// Math notation allows "9x", "2(x-1)", "(x+1)(x-2)" — juxtaposition means
// multiplication. JS has no such rule (a bare "9x-16" is either a syntax
// error or silently wrong), so a expr written the natural math way
// compiles to a function that always returns NaN and draws nothing, with
// no visible error anywhere. Inserting the "*" back in for the
// unambiguous cases (digit-then-letter, digit/paren-then-paren,
// paren-then-letter/digit/paren) fixes this before it ever reaches JS.
// Deliberately NOT handling letter-immediately-before-"(" — that's exactly
// the shape of a function call ("sin(", "sqrt(") and inserting "*" there
// would break it.
function insertImplicitMultiplication(expr) {
  let s = expr;
  // (?<!log1) guards the "0(" inside "log10(" — the one function name with
  // a digit right before its call paren, which otherwise looks exactly
  // like "9(x+1)" (an implied multiply) and would get split in two.
  s = s.replace(/(?<!log1)(\d)(\s*)([A-Za-z(])/g, (m, d, sp, next) => `${d}${sp}*${sp}${next}`);
  s = s.replace(/(\))(\s*)([0-9A-Za-z(])/g, (m, paren, sp, next) => `${paren}${sp}*${sp}${next}`);
  return s;
}

function compileExpr(exprStr) {
  let s = String(exprStr || 'x').trim();
  s = insertImplicitMultiplication(s);
  MATH_FUNCS.forEach((fn) => {
    s = s.replace(new RegExp('\\b' + fn + '\\(', 'g'), 'Math.' + fn + '(');
  });
  s = s.replace(/\bpi\b/g, 'Math.PI');
  s = s.replace(/\be\b/g, 'Math.E');
  s = convertCaretToPow(s);
  let fn;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function('x', 'POW', '"use strict"; return (' + s + ');');
  } catch (err) {
    return () => NaN;
  }
  return (x) => {
    try {
      const v = fn(x, Math.pow);
      return typeof v === 'number' && isFinite(v) ? v : NaN;
    } catch {
      return NaN;
    }
  };
}

// ---------------------------------------------------------------------
// 0. Gaya rumah — standar naskah A-Level (Cambridge / Edexcel)
// ---------------------------------------------------------------------
// Naskah ujian: hitam-putih (abu-abu hanya untuk garis bantu dan arsiran),
// sans-serif, tanpa bingkai di sekeliling gambar, sumbu berpanah dengan
// label "besaran / satuan" di ujungnya, dan "NOT TO SCALE" pada bangun
// yang ukurannya ditulis. Semua keluaran penggambar dilewatkan rapikanSVG()
// di renderDiagramTag, jadi warna lama yang masih tersisa di penggambar
// mana pun tetap tercetak hitam-putih. Sintaks tag TIDAK berubah — semua
// perbaikan lewat bawaan penggambar, bukan parameter baru, supaya perintah
// AI tidak bertambah panjang.
const GAYA = {
  hitam: '#000000',
  abu: '#7a7a7a',          // garis bantu, garis konstruksi putus-putus
  abuMuda: '#c9c9c9',      // grid
  arsir: '#e3e3e3',        // isian daerah / arsiran
  putih: '#ffffff',
  font: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  garis: 1.6,              // garis utama (kurva, sisi bangun, panah gaya)
  garisBantu: 0.9,         // grid, garis putus-putus, garis dimensi
  teks: 11.5,
  teksKecil: 10,
  putus: '6 4',
  putusHalus: '2 3'
};

// Warna lama (biru/merah/hijau/pastel) -> hitam-putih. Dipakai rapikanSVG.
const PETA_WARNA = {
  '#d8dce1': GAYA.abuMuda, '#94a3b8': GAYA.abu, '#64748b': '#5a5a5a',
  '#475569': '#3a3a3a', '#334155': GAYA.hitam, '#1e293b': GAYA.hitam,
  '#1d4ed8': GAYA.hitam, '#6366f1': GAYA.hitam, '#16a34a': '#3a3a3a',
  '#b91c1c': GAYA.hitam, '#dc2626': GAYA.hitam, '#2563eb': GAYA.hitam,
  '#eef0f3': '#ececec', '#e5e9ef': GAYA.arsir, '#e2e8f0': GAYA.arsir,
  '#cbd5e1': GAYA.abuMuda, '#b8c0cc': '#b5b5b5', '#dbeafe': GAYA.arsir,
  '#fee2e2': GAYA.arsir, '#fed7aa': GAYA.arsir, '#e0e7ff': GAYA.arsir,
  '#fff7ed': '#f2f2f2', '#fef3c7': '#f2f2f2', '#f0fdf4': '#f2f2f2',
  '#ecfccb': '#f2f2f2', '#bfdbfe': '#d6d6d6', '#86efac': '#c0c0c0'
};

// Pola garis seri ke-1, ke-2, ... di satu grafik: padat, putus, titik,
// putus-titik. Cara A-Level membedakan kurva tanpa warna.
const POLA_SERI = ['', '6 4', '2 3', '8 3 2 3'];
function polaSeri(i) {
  const p = POLA_SERI[i % POLA_SERI.length];
  return p ? ` stroke-dasharray="${p}"` : '';
}

// "m/s" -> "m s⁻¹", "m/s^2" -> "m s⁻²", "kg m/s" -> "kg m s⁻¹". Satuan
// pembagi ditulis dengan pangkat negatif, seperti di naskah Cambridge.
const SUPER = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
function satuanALevel(u) {
  u = String(u || '').trim();
  if (!u) return '';
  const sup = (n) => String(n).split('').map((c) => SUPER[c] || c).join('');
  u = u.replace(/\^(-?\d+)/g, (_, n) => sup(n));
  const bagi = u.split('/');
  if (bagi.length < 2) return u;
  const atas = bagi[0].trim();
  const bawah = bagi.slice(1).join(' ').trim().split(/\s+/).map((t) => {
    const m = t.match(/^([A-Za-zµΩ°%]+)([⁰¹²³⁴⁵⁶⁷⁸⁹]*)$/);
    if (!m) return t;
    const pangkat = m[2] ? '⁻' + m[2] : '⁻¹';
    return m[1] + pangkat;
  }).join(' ');
  return (atas ? atas + ' ' : '') + bawah;
}

// Label sumbu gaya A-Level: "v / m s⁻¹", "t / s". Tanpa satuan cukup besarannya.
function labelSatuan(besaran, satuan) {
  const s = satuanALevel(satuan);
  return s ? `${besaran} / ${s}` : String(besaran || '');
}

// "kecepatan (m/s)" atau "v (m/s)" -> "kecepatan / m s⁻¹": label lama yang
// ditulis pemakai/AI dengan satuan dalam kurung dibawa ke bentuk A-Level.
function labelSumbuALevel(teks) {
  const t = String(teks || '').trim();
  const m = t.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  return m ? labelSatuan(m[1].trim(), m[2]) : t;
}

// Sumbu berpanah dari titik asal (x0,y0) ke kanan sampai xEnd dan ke atas
// sampai yEnd (koordinat SVG, yEnd < y0). Label di ujung panah.
function sumbuSVG(o) {
  let s = '';
  const w = o.strokeWidth || 1.2;
  // xMulai/yMulai (opsional): sumbu menerus ke sisi negatif sampai tepi grid.
  if (o.xMulai != null && o.xMulai < o.x0) s += `<line x1="${o.xMulai.toFixed(1)}" y1="${o.y0.toFixed(1)}" x2="${o.x0.toFixed(1)}" y2="${o.y0.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${w}"/>`;
  if (o.yMulai != null && o.yMulai > o.y0) s += `<line x1="${o.x0.toFixed(1)}" y1="${o.yMulai.toFixed(1)}" x2="${o.x0.toFixed(1)}" y2="${o.y0.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${w}"/>`;
  if (o.xEnd != null) s += arrowSVG(o.x0, o.y0, o.xEnd, o.y0, { headLen: 7, strokeWidth: w });
  if (o.yEnd != null) s += arrowSVG(o.x0, o.y0, o.x0, o.yEnd, { headLen: 7, strokeWidth: w });
  if (o.labelX) s += `<text x="${(o.xEnd).toFixed(1)}" y="${(o.y0 + 15).toFixed(1)}" text-anchor="end" font-size="${GAYA.teks}" fill="${GAYA.hitam}">${escText(o.labelX)}</text>`;
  if (o.labelY) s += `<text x="${(o.x0 + 6).toFixed(1)}" y="${(o.yEnd - 5).toFixed(1)}" text-anchor="start" font-size="${GAYA.teks}" fill="${GAYA.hitam}">${escText(o.labelY)}</text>`;
  return s;
}

// "NOT TO SCALE" di pojok kanan atas gambar, seperti bangun di naskah Cambridge.
function tidakBerskalaSVG(xKanan, yAtas) {
  return `<text x="${xKanan.toFixed(1)}" y="${yAtas.toFixed(1)}" text-anchor="end" font-size="${GAYA.teksKecil}" font-style="italic" fill="${GAYA.hitam}">NOT TO SCALE</text>`;
}

// Dipakai renderDiagramTag pada SEMUA keluaran SVG:
//   1. bingkai abu-abu (rect latar pertama) dihilangkan,
//   2. warna dipetakan ke hitam-putih,
//   3. font sans-serif dipasang di akar <svg>.
function rapikanSVG(svg) {
  if (!svg || svg.indexOf('<svg') < 0) return svg;
  svg = svg.replace(/(<rect [^>]*?fill="#ffffff"[^>]*?)stroke="#d8dce1"/, '$1stroke="none"');
  svg = svg.replace(/#[0-9a-fA-F]{6}\b/g, (h) => PETA_WARNA[h.toLowerCase()] || h);
  if (svg.indexOf('font-family=') < 0 || !/<svg[^>]*font-family=/.test(svg)) {
    svg = svg.replace(/<svg class="ws-diagram-svg"/, `<svg class="ws-diagram-svg" font-family="${GAYA.font}"`);
  }
  return svg;
}

// ---------------------------------------------------------------------
// 1. Grafik Fungsi
// ---------------------------------------------------------------------

function formatTick(v) {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? '0' : String(r);
}

// "f1:2,5" (optionally several, separated by "|") -> { f1: [2, 5] }.
// Shared by "arsir" (shade under a curve between two x values) and
// "domain" (only plot a curve between them).
function parseCurveRange(raw) {
  const out = {};
  String(raw || '').split('|').map((s) => s.trim()).filter(Boolean).forEach((chunk) => {
    const idx = chunk.indexOf(':');
    if (idx === -1) return;
    const key = chunk.slice(0, idx).trim();
    const nums = chunk.slice(idx + 1).split(',').map((n) => parseFloat(n.trim()));
    if (key && isFinite(nums[0]) && isFinite(nums[1])) out[key] = [nums[0], nums[1]];
  });
  return out;
}

// "f1:3" -> { f1: 3 } — the x value a tangent line is drawn at.
function parseCurvePoint(raw) {
  const out = {};
  String(raw || '').split('|').map((s) => s.trim()).filter(Boolean).forEach((chunk) => {
    const idx = chunk.indexOf(':');
    if (idx === -1) return;
    const key = chunk.slice(0, idx).trim();
    const v = parseFloat(chunk.slice(idx + 1));
    if (key && isFinite(v)) out[key] = v;
  });
  return out;
}

// "x=2, y=0" -> [{ axis: 'x', value: 2 }, ...]
function parseAsymptotes(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).map((chunk) => {
    const m = chunk.match(/^([xy])\s*=\s*(-?[\d.]+)$/i);
    return m ? { axis: m[1].toLowerCase(), value: parseFloat(m[2]) } : null;
  }).filter(Boolean);
}

// --- Helper bersama grafik & statistik (dipakai mulai renderFunctionGraphSVG
// sampai renderGraphPaperSVG). SVG tidak bisa mengukur teks sebelum
// digambar, jadi lebar teks dikira-kira dari jumlah hurufnya supaya kanvas
// bisa dipotong pas tanpa memenggal label sumbu.
function lebarTeksKira(teks, ukuran) {
  return String(teks || '').length * (ukuran || GAYA.teks) * 0.56;
}

// Teks dengan "halo" putih di belakang huruf: angka skala dan label kurva
// tetap terbaca walau menimpa grid atau kurva. Ukuran boleh diatur (annotText
// yang lama terkunci 11 px dan hanya untuk anotasi pemakai).
function teksHaloSVG(x, y, teks, o) {
  o = o || {};
  const anchor = o.anchor || 'middle';
  const size = o.size || GAYA.teksKecil;
  const extra = (o.italic ? ' font-style="italic"' : '') + (o.bold ? ' font-weight="700"' : '');
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" fill="${GAYA.hitam}"`
    + ` stroke="${GAYA.putih}" stroke-width="3" paint-order="stroke" text-anchor="${anchor}"${extra}>${escText(teks)}</text>`;
}

// Sumbu gaya A-Level: panah hanya di ujung positif, label "besaran / satuan"
// di SEBELAH KANAN ujung panah x dan DI ATAS ujung panah y. Keduanya di luar
// daerah plot, jadi tidak mungkin tertimpa kurva, batang, atau titik data —
// itulah sebabnya label tidak lagi ditaruh di tengah bawah / diputar 90°.
//   xFrom..xTo : rentang piksel sumbu x (xTo = ujung panah) pada tinggi xAxisY
//   yFrom..yTo : sumbu y dari bawah (yFrom) ke ujung panah (yTo, lebih kecil)
function sumbuALevelSVG(o) {
  let s = '';
  const w = o.strokeWidth || 1.2;
  if (o.xTo != null) s += arrowSVG(o.xFrom, o.xAxisY, o.xTo, o.xAxisY, { headLen: 7, strokeWidth: w });
  if (o.yTo != null) s += arrowSVG(o.yAxisX, o.yFrom, o.yAxisX, o.yTo, { headLen: 7, strokeWidth: w });
  if (o.labelX) s += `<text x="${(o.xTo + 5).toFixed(1)}" y="${(o.xAxisY + 4).toFixed(1)}" font-size="${GAYA.teks}" fill="${GAYA.hitam}">${escText(o.labelX)}</text>`;
  if (o.labelY) s += `<text x="${(o.yAxisX - 8).toFixed(1)}" y="${(o.yTo - 6).toFixed(1)}" font-size="${GAYA.teks}" fill="${GAYA.hitam}">${escText(o.labelY)}</text>`;
  return s;
}

// Tanda skala pendek + angkanya: di bawah sumbu x, di kiri sumbu y.
function tickXSVG(px, axisY, teks) {
  return `<line x1="${px.toFixed(1)}" y1="${axisY.toFixed(1)}" x2="${px.toFixed(1)}" y2="${(axisY + 4).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1"/>`
    + teksHaloSVG(px, axisY + 15, teks);
}
function tickYSVG(axisX, py, teks) {
  return `<line x1="${(axisX - 4).toFixed(1)}" y1="${py.toFixed(1)}" x2="${axisX.toFixed(1)}" y2="${py.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1"/>`
    + teksHaloSVG(axisX - 6, py + 3.5, teks, { anchor: 'end' });
}

// Satu halaman memuat banyak SVG inline yang berbagi ruang id, jadi tiap
// clipPath daerah plot butuh id sendiri.
let grafikClipCounter = 0;

function renderFunctionGraphSVG(cfg) {
  const plotW = 328, plotH = 228;
  const FN_KEYS = ['f1', 'f2', 'f3', 'f4', 'f5'];
  const activeFns = FN_KEYS.map((key, i) => ({ key, i, expr: cfg[key] })).filter((f) => f.expr);
  // Legenda hanya kalau kurvanya lebih dari satu — dengan f1 saja tidak ada
  // yang perlu dibedakan.
  const legendH = activeFns.length > 1 ? 16 * activeFns.length + 10 : 0;
  const xmin = numOrDefault(cfg.xmin, -10), xmax = numOrDefault(cfg.xmax, 10);
  const ymin = numOrDefault(cfg.ymin, -10), ymax = numOrDefault(cfg.ymax, 10);
  const rangeX = (xmax - xmin) || 1, rangeY = (ymax - ymin) || 1;
  const xStep = niceStep(rangeX), yStep = niceStep(rangeY);
  // Tanpa sumbux/sumbuy, naskah A-Level tetap menulis "x" dan "y" di ujung panah.
  const labelX = cfg.sumbux ? labelSumbuALevel(cfg.sumbux) : 'x';
  const labelY = cfg.sumbuy ? labelSumbuALevel(cfg.sumbuy) : 'y';

  // Sumbu di titik asal kalau 0 ada di jangkauan; kalau tidak, di tepi plot.
  const yAxisInside = xmin < 0 && xmax > 0;
  const xAxisInside = ymin < 0 && ymax > 0;
  const yTicks = [], xTicks = [];
  for (let gy = Math.ceil(ymin / yStep) * yStep; gy <= ymax + 1e-9; gy += yStep) yTicks.push(Math.round(gy * 1e6) / 1e6);
  for (let gx = Math.ceil(xmin / xStep) * xStep; gx <= xmax + 1e-9; gx += xStep) xTicks.push(Math.round(gx * 1e6) / 1e6);
  const yTickW = Math.max.apply(null, yTicks.map((v) => lebarTeksKira(formatTick(v), GAYA.teksKecil)).concat([0]));

  // Margin kanvas dihitung dari isinya supaya viewBox pas: angka skala di
  // kiri hanya butuh ruang kalau sumbu y menempel tepi kiri, label sumbu x
  // butuh ruang di kanan ujung panah, label sumbu y di atas ujung panah.
  const padL = yAxisInside ? 12 : yTickW + 16;
  const padR = 12 + lebarTeksKira(labelX) + 10;
  const padT = 28;
  const padB = xAxisInside ? 12 : 26;
  const sx = plotW / rangeX, sy = plotH / rangeY;
  const toPx = (x, y) => [padL + (x - xmin) * sx, padT + plotH - (y - ymin) * sy];
  const xAxisY = xAxisInside ? toPx(0, 0)[1] : padT + plotH;
  const yAxisX = yAxisInside ? toPx(0, 0)[0] : padL;
  const width = Math.max(padL + plotW + padR, yAxisX - 8 + lebarTeksKira(labelY) + 6);
  const height = padT + plotH + padB + legendH;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}" xmlns="http://www.w3.org/2000/svg">`;

  // Grid abu-abu muda tipis, seperti kertas grafik di naskah.
  xTicks.forEach((gx) => {
    const [px] = toPx(gx, 0);
    svg += `<line x1="${px.toFixed(1)}" y1="${padT}" x2="${px.toFixed(1)}" y2="${padT + plotH}" stroke="${GAYA.abuMuda}" stroke-width="0.6"/>`;
  });
  yTicks.forEach((gy) => {
    const [, py] = toPx(0, gy);
    svg += `<line x1="${padL}" y1="${py.toFixed(1)}" x2="${padL + plotW}" y2="${py.toFixed(1)}" stroke="${GAYA.abuMuda}" stroke-width="0.6"/>`;
  });

  // Daerah plot di-clip: kurva yang melampaui ymax (mis. parabola dengan
  // ymax=12) berhenti di tepi, tidak pernah keluar dari bingkai gambar.
  const clipId = 'gfclip' + (grafikClipCounter++);
  svg += `<clipPath id="${clipId}"><rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"/></clipPath>`;
  svg += `<g clip-path="url(#${clipId})">`;

  const domains = parseCurveRange(cfg.domain);
  const shades = parseCurveRange(cfg.arsir);
  const tangents = parseCurvePoint(cfg.singgung);

  // Arsiran di bawah kurva digambar SEBELUM kurva supaya garis kurva tetap
  // tajam di atasnya. Abu-abu rata (bukan pola) supaya angka/label yang
  // menimpanya masih terbaca.
  Object.keys(shades).forEach((key) => {
    const spec = activeFns.find((f) => f.key === key);
    if (!spec) return;
    const fn = compileExpr(spec.expr);
    const [lo, hi] = shades[key];
    const from = Math.max(xmin, Math.min(lo, hi));
    const to = Math.min(xmax, Math.max(lo, hi));
    if (!(to > from)) return;
    const steps = 120;
    let d = 'M' + toPx(from, 0).map((n) => n.toFixed(1)).join(' ') + ' ';
    for (let k = 0; k <= steps; k++) {
      const x = from + (to - from) * k / steps;
      const y = Math.max(ymin, Math.min(ymax, fn(x)));
      if (!isFinite(y)) continue;
      d += 'L' + toPx(x, y).map((n) => n.toFixed(1)).join(' ') + ' ';
    }
    d += 'L' + toPx(to, 0).map((n) => n.toFixed(1)).join(' ') + ' Z';
    svg += `<path d="${d}" fill="${GAYA.hitam}" fill-opacity="0.12" stroke="none"/>`;
  });

  const asymptotes = parseAsymptotes(cfg.asimtot).filter((a) => (a.axis === 'x' ? a.value >= xmin && a.value <= xmax : a.value >= ymin && a.value <= ymax));
  asymptotes.forEach((a) => {
    if (a.axis === 'x') {
      const [px] = toPx(a.value, 0);
      svg += `<line x1="${px.toFixed(1)}" y1="${padT}" x2="${px.toFixed(1)}" y2="${padT + plotH}" stroke="${GAYA.hitam}" stroke-width="1.2" stroke-dasharray="4,4"/>`;
    } else {
      const [, py] = toPx(0, a.value);
      svg += `<line x1="${padL}" y1="${py.toFixed(1)}" x2="${padL + plotW}" y2="${py.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2" stroke-dasharray="4,4"/>`;
    }
  });

  // Kurva ke-i dibedakan pola garis (padat, putus, titik, putus-titik):
  // cara naskah hitam-putih membedakan f1/f2 tanpa warna.
  const compiled = {};
  activeFns.forEach(({ key, expr, i }) => {
    const fn = compileExpr(expr);
    compiled[key] = fn;
    // Domain terbatas: kurva hanya digambar di rentang yang soal definisikan.
    const dom = domains[key];
    const plotFrom = dom ? Math.max(xmin, Math.min(dom[0], dom[1])) : xmin;
    const plotTo = dom ? Math.min(xmax, Math.max(dom[0], dom[1])) : xmax;
    let d = '', have = false, prevPy = null;
    const steps = 240;
    for (let s = 0; s <= steps; s++) {
      const x = plotFrom + (plotTo - plotFrom) * s / steps;
      const y = fn(x);
      // Titik jauh di luar jendela tetap disambung (clipPath yang memotong),
      // tapi loncatan raksasa (asimtot tegak) diputus supaya tidak jadi
      // garis vertikal palsu.
      if (!isFinite(y) || y < ymin - rangeY * 2 || y > ymax + rangeY * 2) {
        have = false;
        continue;
      }
      const [px, py] = toPx(x, y);
      if (have && prevPy !== null && Math.abs(py - prevPy) > plotH * 0.85) have = false;
      d += (have ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1) + ' ';
      have = true;
      prevPy = py;
    }
    svg += `<path d="${d}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"${polaSeri(i)}/>`;
  });

  // Garis singgung (putus-putus) + segitiga gradien yang skema penilaian
  // harapkan: run mendatar dan rise tegak, keduanya diberi angka.
  const tangentLabels = [];
  Object.keys(tangents).forEach((key) => {
    const spec = activeFns.find((f) => f.key === key);
    if (!spec) return;
    const fn = compiled[key];
    const x0 = tangents[key];
    const y0 = fn(x0);
    if (!isFinite(y0)) return;
    const h = rangeX / 1000;
    const slope = (fn(x0 + h) - fn(x0 - h)) / (2 * h);
    if (!isFinite(slope)) return;
    const half = rangeX * 0.28;
    const x1 = x0 - half, x2 = x0 + half;
    const p1 = toPx(x1, y0 + slope * (x1 - x0));
    const p2 = toPx(x2, y0 + slope * (x2 - x0));
    svg += `<line x1="${p1[0].toFixed(1)}" y1="${p1[1].toFixed(1)}" x2="${p2[0].toFixed(1)}" y2="${p2[1].toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.3" stroke-dasharray="7,3"/>`;
    const [cx, cy] = toPx(x0, y0);
    svg += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3" fill="${GAYA.hitam}"/>`;

    const runX = x0 + half * 0.6;
    const runEndY = y0 + slope * (runX - x0);
    const a = toPx(x0, y0), b = toPx(runX, y0), c = toPx(runX, runEndY);
    svg += `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1" stroke-dasharray="2,2"/>`;
    svg += `<line x1="${b[0].toFixed(1)}" y1="${b[1].toFixed(1)}" x2="${c[0].toFixed(1)}" y2="${c[1].toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1" stroke-dasharray="2,2"/>`;
    // Angka run di bawah kaki mendatar, angka rise di samping kaki tegak
    // (sisi yang menjauhi kurva) — ditulis nanti di luar clip supaya utuh,
    // tapi dijepit ke dalam daerah plot.
    // Kaki mendatar yang berimpit dengan sumbu x: angkanya ditaruh di ATAS
    // kaki, karena di bawah sumbu sudah ada barisan angka skala.
    const dekatSumbuX = Math.abs(a[1] - xAxisY) < 20;
    const runLabelY = (slope >= 0) !== dekatSumbuX ? a[1] + 12 : a[1] - 5;
    tangentLabels.push({ x: (a[0] + b[0]) / 2, y: runLabelY, teks: formatTick(runX - x0), anchor: 'middle' });
    tangentLabels.push({ x: b[0] + 6, y: (b[1] + c[1]) / 2 + 3.5, teks: formatTick(Math.abs(runEndY - y0)), anchor: 'start' });
  });
  svg += '</g>';

  // Sumbu berpanah di atas kurva supaya tidak tertutup arsiran.
  svg += sumbuALevelSVG({
    xAxisY, yAxisX, xFrom: padL, xTo: padL + plotW + 10, yFrom: padT + plotH, yTo: padT - 10, labelX, labelY,
  });
  // Angka skala: "O" di titik asal kalau kedua sumbu berpotongan di 0.
  const originShown = (yAxisInside || xmin === 0) && (xAxisInside || ymin === 0);
  xTicks.forEach((gx) => {
    if (Math.abs(gx) < 1e-9 && originShown) return;
    const [px] = toPx(gx, 0);
    svg += tickXSVG(px, xAxisY, formatTick(gx));
  });
  yTicks.forEach((gy) => {
    if (Math.abs(gy) < 1e-9 && originShown) return;
    const [, py] = toPx(0, gy);
    svg += tickYSVG(yAxisX, py, formatTick(gy));
  });
  if (originShown) svg += teksHaloSVG(yAxisX - 5, xAxisY + 13, 'O', { anchor: 'end', italic: true });

  const clampX = (v) => Math.max(padL + 4, Math.min(padL + plotW - 4, v));
  const clampY = (v) => Math.max(padT + 10, Math.min(padT + plotH - 3, v));
  asymptotes.forEach((a) => {
    if (a.axis === 'x') {
      const [px] = toPx(a.value, 0);
      // Label di sisi garis yang tidak dilewati kurva di dekat tepi atas:
      // kurva yang meroket ke asimtot tegak biasanya hanya ada di satu sisi.
      const xUji = a.value + rangeX * 0.04;
      const kurvaKanan = activeFns.some((f) => { const y = compiled[f.key](xUji); return isFinite(y) && toPx(xUji, y)[1] < padT + 24; });
      svg += teksHaloSVG(clampX(px + (kurvaKanan ? -4 : 4)), padT + 12, 'x = ' + formatTick(a.value), { anchor: kurvaKanan ? 'end' : 'start' });
    } else {
      // Asimtot mendatar yang berimpit dengan sumbu x tidak perlu label —
      // sumbunya sendiri sudah y = 0.
      if (Math.abs(a.value) < 1e-9 && (xAxisInside || ymin === 0)) return;
      const [, py] = toPx(0, a.value);
      const xUji = xmax - rangeX * 0.06;
      const kurvaAtas = activeFns.some((f) => { const y = compiled[f.key](xUji); return isFinite(y) && Math.abs(toPx(xUji, y)[1] - (py - 6)) < 12; });
      svg += teksHaloSVG(padL + plotW - 4, clampY(kurvaAtas ? py + 12 : py - 4), 'y = ' + formatTick(a.value), { anchor: 'end' });
    }
  });
  tangentLabels.forEach((t) => { svg += teksHaloSVG(clampX(t.x), clampY(t.y), t.teks, { anchor: t.anchor }); });

  (cfg.titik || []).forEach((p) => {
    const [px, py] = toPx(p.x, p.y);
    svg += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.5" fill="${GAYA.hitam}"/>`;
    if (p.label) svg += teksHaloSVG(px + 5, py - 5, p.label, { anchor: 'start', size: GAYA.teks });
  });

  // Lebih dari satu kurva: nama f1/f2 ditulis di dekat kurvanya, di titik
  // yang masih di dalam jendela dan jauh dari kurva lain / label lain.
  if (activeFns.length > 1) {
    const dipakai = [];
    activeFns.forEach(({ key }) => {
      const fn = compiled[key];
      const dom = domains[key];
      const from = dom ? Math.max(xmin, Math.min(dom[0], dom[1])) : xmin;
      const to = dom ? Math.min(xmax, Math.max(dom[0], dom[1])) : xmax;
      const lain = activeFns.filter((f) => f.key !== key).map((f) => compiled[f.key]);
      const kandidat = [0.84, 0.16, 0.72, 0.28, 0.6, 0.4, 0.5, 0.92, 0.08];
      for (let k = 0; k < kandidat.length; k++) {
        const x = from + (to - from) * kandidat[k];
        const y = fn(x);
        if (!isFinite(y) || y < ymin + rangeY * 0.06 || y > ymax - rangeY * 0.06) continue;
        const [px, py] = toPx(x, y);
        // Jangan menempel sumbu: di situ sudah ada angka skala.
        if (Math.abs(py - xAxisY) < 20 || Math.abs(px - yAxisX) < 24) continue;
        if (dipakai.some((s) => Math.hypot(s[0] - px, s[1] - py) < 32)) continue;
        if (lain.some((g) => { const gy = g(x); return isFinite(gy) && Math.abs(toPx(x, gy)[1] - py) < 16; })) continue;
        dipakai.push([px, py]);
        svg += teksHaloSVG(px + 6, py - 6, key, { anchor: 'start', size: GAYA.teks, italic: true });
        break;
      }
    });
    // Legenda: pola garis -> rumus, karena "f1" saja belum menyebut rumusnya.
    activeFns.forEach(({ expr, i }, row) => {
      const ly = padT + plotH + padB + 12 + row * 16;
      svg += `<line x1="${padL}" y1="${ly - 4}" x2="${padL + 28}" y2="${ly - 4}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"${polaSeri(i)}/>`;
      svg += `<text x="${padL + 34}" y="${ly}" font-size="${GAYA.teks}" fill="${GAYA.hitam}"><tspan font-style="italic">f${i + 1}</tspan> = ${escText(expr)}</text>`;
    });
  }

  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 1b. Program Linear (daerah himpunan penyelesaian)
// ---------------------------------------------------------------------

// "2x+y<=10" -> {a:2, b:1, op:'<=', c:10}. Deliberately simple (only
// handles a linear combination of bare x/y terms on the left, a number on
// the right) since that's the only shape a linear-programming constraint
// ever takes in a worksheet.
function parseLinearIneq(raw) {
  const str = String(raw || '').trim();
  const opMatch = str.match(/(<=|>=|<|>|=)/);
  if (!opMatch) return null;
  const op = opMatch[0];
  const idx = str.indexOf(op);
  const lhs = str.slice(0, idx);
  const rhsNum = parseFloat(str.slice(idx + op.length));
  let a = 0, b = 0;
  const termRe = /([+-]?\s*\d*\.?\d*)\s*([xy])/g;
  let m;
  while ((m = termRe.exec(lhs))) {
    const coefStr = m[1].replace(/\s+/g, '');
    let coef;
    if (coefStr === '' || coefStr === '+') coef = 1;
    else if (coefStr === '-') coef = -1;
    else coef = parseFloat(coefStr);
    if (!isFinite(coef)) coef = 1;
    if (m[2] === 'x') a += coef; else b += coef;
  }
  return { a, b, op, c: isFinite(rhsNum) ? rhsNum : 0, raw: str };
}

// Flips ">="/">" to "<=" (negating all three coefficients) so every
// constraint can be tested the same way: feasible <=> a*x + b*y <= c.
function normalizeIneq(ineq) {
  if (ineq.op === '>=' || ineq.op === '>') return { a: -ineq.a, b: -ineq.b, c: -ineq.c, strict: ineq.op === '>' };
  return { a: ineq.a, b: ineq.b, c: ineq.c, strict: ineq.op === '<' };
}

// Clips the infinite line a*x+b*y=c to the plotted [xmin,xmax]x[ymin,ymax]
// box by intersecting it with all four edges and keeping the two points
// that actually land on the box — the general way to draw "the part of
// this line that's on screen" without knowing its slope in advance.
function clipLineToRect(a, b, c, xmin, xmax, ymin, ymax) {
  const eps = 1e-6;
  const pts = [];
  if (Math.abs(b) > 1e-9) {
    let y = (c - a * xmin) / b;
    if (y >= ymin - eps && y <= ymax + eps) pts.push({ x: xmin, y });
    y = (c - a * xmax) / b;
    if (y >= ymin - eps && y <= ymax + eps) pts.push({ x: xmax, y });
  }
  if (Math.abs(a) > 1e-9) {
    let x = (c - b * ymin) / a;
    if (x >= xmin - eps && x <= xmax + eps) pts.push({ x, y: ymin });
    x = (c - b * ymax) / a;
    if (x >= xmin - eps && x <= xmax + eps) pts.push({ x, y: ymax });
  }
  const uniq = [];
  pts.forEach((p) => { if (!uniq.some((q) => Math.abs(q.x - p.x) < 1e-4 && Math.abs(q.y - p.y) < 1e-4)) uniq.push(p); });
  if (uniq.length < 2) return null;
  let best = null, bestD = -1;
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const d = Math.hypot(uniq[i].x - uniq[j].x, uniq[i].y - uniq[j].y);
      if (d > bestD) { bestD = d; best = [uniq[i], uniq[j]]; }
    }
  }
  return best;
}

function renderLinearProgramSVG(cfg) {
  const rawList = String(cfg.pertidaksamaan || '').split(',').map((s) => s.trim()).filter(Boolean);
  let ineqs = rawList.map(parseLinearIneq).filter(Boolean);
  if (!ineqs.length) ineqs = [parseLinearIneq('x>=0'), parseLinearIneq('y>=0')];
  const norm = ineqs.map(normalizeIneq);

  const plotW = 320, plotH = 240;
  // Program linear hidup di kuadran I, jadi jendela bawaannya di situ, bukan
  // ±10 seperti grafik fungsi umum.
  const xmin = numOrDefault(cfg.xmin, 0), xmax = numOrDefault(cfg.xmax, 10);
  const ymin = numOrDefault(cfg.ymin, 0), ymax = numOrDefault(cfg.ymax, 10);
  const xStep = niceStep(xmax - xmin), yStep = niceStep(ymax - ymin);
  const yTicks = [], xTicks = [];
  for (let gy = Math.ceil(ymin / yStep) * yStep; gy <= ymax + 1e-9; gy += yStep) yTicks.push(Math.round(gy * 1e6) / 1e6);
  for (let gx = Math.ceil(xmin / xStep) * xStep; gx <= xmax + 1e-9; gx += xStep) xTicks.push(Math.round(gx * 1e6) / 1e6);
  const yTickW = Math.max.apply(null, yTicks.map((v) => lebarTeksKira(formatTick(v), GAYA.teksKecil)).concat([0]));
  // Margin dari isinya: angka skala di kiri, label "x" di kanan panah, "y"
  // di atas panah, koordinat titik pojok bisa menjulur sedikit ke kanan.
  const padL = yTickW + 16, padR = 60, padT = 26, padB = 26;
  const sx = plotW / (xmax - xmin || 1);
  const sy = plotH / (ymax - ymin || 1);
  const toPx = (x, y) => [padL + (x - xmin) * sx, padT + plotH - (y - ymin) * sy];
  // sistem=tidak (alias legenda=tidak): daftar pertidaksamaan dan nomor garis disembunyikan, untuk soal
  // "tentukan sistem pertidaksamaan dari gambar" — daftar itu jawabannya.
  const tanpaSistem = /^(tidak|false|0)$/i.test(String(cfg.sistem != null ? cfg.sistem : (cfg.legenda != null ? cfg.legenda : '')));
  const legendH = tanpaSistem ? 0 : 16 * rawList.length + 8;
  const width = padL + plotW + padR;
  const height = padT + plotH + padB + legendH;
  const xAxisY = padT + plotH, yAxisX = padL;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width.toFixed(0)} ${height}" xmlns="http://www.w3.org/2000/svg">`;

  xTicks.forEach((gx) => {
    const [px] = toPx(gx, 0);
    svg += `<line x1="${px.toFixed(1)}" y1="${padT}" x2="${px.toFixed(1)}" y2="${xAxisY}" stroke="${GAYA.abuMuda}" stroke-width="0.6"/>`;
  });
  yTicks.forEach((gy) => {
    const [, py] = toPx(0, gy);
    svg += `<line x1="${padL}" y1="${py.toFixed(1)}" x2="${padL + plotW}" y2="${py.toFixed(1)}" stroke="${GAYA.abuMuda}" stroke-width="0.6"/>`;
  });

  // Titik pojok daerah penyelesaian: tiap pasang garis batas dipotongkan,
  // calon disimpan hanya bila memenuhi semua kendala lain — cara baku
  // memulihkan sudut poligon cembung dari setengah-bidangnya tanpa pustaka
  // pemotong poligon.
  const feasiblePts = [];
  for (let i = 0; i < norm.length; i++) {
    for (let j = i + 1; j < norm.length; j++) {
      const det = norm[i].a * norm[j].b - norm[j].a * norm[i].b;
      if (Math.abs(det) < 1e-9) continue;
      const x = (norm[i].c * norm[j].b - norm[j].c * norm[i].b) / det;
      const y = (norm[i].a * norm[j].c - norm[j].a * norm[i].c) / det;
      if (x < xmin - 1e-6 || x > xmax + 1e-6 || y < ymin - 1e-6 || y > ymax + 1e-6) continue;
      if (norm.every((k) => k.a * x + k.b * y <= k.c + 1e-6)) feasiblePts.push({ x, y });
    }
  }
  const vertices = [];
  feasiblePts.forEach((p) => {
    if (!vertices.some((q) => Math.abs(q.x - p.x) < 1e-3 && Math.abs(q.y - p.y) < 1e-3)) vertices.push(p);
  });
  if (vertices.length >= 3) {
    const cx0 = vertices.reduce((s, p) => s + p.x, 0) / vertices.length;
    const cy0 = vertices.reduce((s, p) => s + p.y, 0) / vertices.length;
    vertices.sort((p, q) => Math.atan2(p.y - cy0, p.x - cx0) - Math.atan2(q.y - cy0, q.x - cx0));
    // Arsiran miring abu-abu, seperti daerah penyelesaian di naskah ujian.
    const patternId = 'lpHatch' + (grafikClipCounter++);
    svg += `<defs><pattern id="${patternId}" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="7" stroke="${GAYA.abu}" stroke-width="1.2"/></pattern></defs>`;
    const pts = vertices.map((p) => toPx(p.x, p.y).map((v) => v.toFixed(1)).join(',')).join(' ');
    svg += `<polygon points="${pts}" fill="url(#${patternId})" stroke="none"/>`;
  }

  norm.forEach((c, i) => {
    const seg = clipLineToRect(c.a, c.b, c.c, xmin, xmax, ymin, ymax);
    if (!seg) return;
    const [p1, p2] = seg;
    const [px1, py1] = toPx(p1.x, p1.y);
    const [px2, py2] = toPx(p2.x, p2.y);
    // Pertidaksamaan tegas (<, >) digambar putus-putus: garis batasnya
    // tidak termasuk daerah penyelesaian.
    const dashAttr = c.strict ? ` stroke-dasharray="${GAYA.putus}"` : '';
    svg += `<line x1="${px1.toFixed(1)}" y1="${py1.toFixed(1)}" x2="${px2.toFixed(1)}" y2="${py2.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"${dashAttr}/>`;
    // Nomor garis sedikit ke dalam dari ujung ruas dan digeser tegak lurus
    // garis, ke sisi yang masih di dalam plot — jadi tidak menimpa garisnya
    // sendiri, sumbu, atau angka skala (garis x=0 / y=0 berimpit sumbu).
    const len = Math.hypot(px2 - px1, py2 - py1) || 1;
    const dx = (px2 - px1) / len, dy = (py2 - py1) / len;
    let lx = px2 - dx * 14 - dy * 10, ly = py2 - dy * 14 + dx * 10;
    if (lx < padL + 6 || lx > padL + plotW - 6 || ly < padT + 6 || ly > xAxisY - 6) {
      lx = px2 - dx * 14 + dy * 10; ly = py2 - dy * 14 - dx * 10;
    }
    if (!tanpaSistem) svg += teksHaloSVG(lx, ly + 3.5, `(${i + 1})`);
  });

  svg += sumbuALevelSVG({ xAxisY, yAxisX, xFrom: padL, xTo: padL + plotW + 10, yFrom: xAxisY, yTo: padT - 10, labelX: 'x', labelY: 'y' });
  const originShown = xmin === 0 && ymin === 0;
  xTicks.forEach((gx) => { if (!(originShown && Math.abs(gx) < 1e-9)) svg += tickXSVG(toPx(gx, 0)[0], xAxisY, formatTick(gx)); });
  yTicks.forEach((gy) => { if (!(originShown && Math.abs(gy) < 1e-9)) svg += tickYSVG(yAxisX, toPx(0, gy)[1], formatTick(gy)); });
  if (originShown) svg += teksHaloSVG(yAxisX - 5, xAxisY + 13, 'O', { anchor: 'end', italic: true });

  if (vertices.length && cfg.titikpojok !== 'tidak') {
    vertices.forEach((p) => {
      const [px, py] = toPx(p.x, p.y);
      svg += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.5" fill="${GAYA.hitam}"/>`;
      svg += teksHaloSVG(px + 6, py - 6, `(${formatTick(p.x)}, ${formatTick(p.y)})`, { anchor: 'start' });
    });
  }

  if (!tanpaSistem) rawList.forEach((r, i) => {
    svg += `<text x="${padL}" y="${(xAxisY + padB + 10 + i * 16).toFixed(1)}" font-size="${GAYA.teksKecil}" fill="${GAYA.hitam}">(${i + 1}) ${escText(r)}</text>`;
  });

  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 2. Bangun Geometri
// ---------------------------------------------------------------------

const GEOMETRY_PRESETS = {
  'segitiga-sembarang': {
    build: (p) => {
      const a = numOrDefault(p.a, 5), b = numOrDefault(p.b, 6), c = numOrDefault(p.c, 7);
      const x = (c * c - b * b + a * a) / (2 * a || 1);
      const y2 = c * c - x * x;
      const y = y2 > 0 ? Math.sqrt(y2) : 0.001;
      return {
        points: [{ name: 'A', x, y }, { name: 'B', x: 0, y: 0 }, { name: 'C', x: a, y: 0 }],
        segments: [
          { from: 'B', to: 'C', label: `a = ${a}` },
          { from: 'C', to: 'A', label: `b = ${b}` },
          { from: 'A', to: 'B', label: `c = ${c}` },
        ],
      };
    },
  },
  'segitiga-siku': {
    build: (p) => {
      const alas = numOrDefault(p.alas, 6), tinggi = numOrDefault(p.tinggi, 4);
      return {
        points: [{ name: 'A', x: 0, y: 0 }, { name: 'B', x: alas, y: 0 }, { name: 'C', x: 0, y: tinggi }],
        segments: [
          { from: 'A', to: 'B', label: `${alas}` },
          { from: 'A', to: 'C', label: `${tinggi}` },
          { from: 'B', to: 'C', label: '' },
        ],
      };
    },
  },
  // Segitiga untuk soal luas SD (Luas = alas x tinggi / 2): alas selalu
  // mendatar di bawah, tinggi digambar sebagai garis putus-putus tegak lurus
  // dari puncak C ke alas (atau perpanjangannya) dengan tanda siku di kaki
  // garis tinggi H. "geser" (posisi x puncak, diukur dari ujung kiri alas)
  // yang menentukan bentuknya: 0..alas -> kaki tinggi jatuh DI DALAM alas
  // (0/alas = siku-siku, tengah = sama kaki/lancip); di luar rentang itu ->
  // segitiga tumpul, kaki tinggi jatuh DI LUAR alas, jadi alasnya digambar
  // diperpanjang putus-putus sampai ke kaki garis tinggi (persis cara buku
  // SD menggambar "tinggi di luar segitiga").
  'segitiga-tinggi': {
    build: (p) => {
      const alas = numOrDefault(p.alas, 8), tinggi = numOrDefault(p.tinggi, 5);
      const geser = numOrDefault(p.geser, alas / 2);
      const bantu = [];
      if (geser < 0) bantu.push({ from: 'A', to: 'H', label: '' });
      else if (geser > alas) bantu.push({ from: 'B', to: 'H', label: '' });
      const arah = geser < alas / 2 ? 'B' : 'A';
      bantu.push({ from: 'C', to: 'H', arah, label: `${tinggi}` });
      return {
        points: [
          { name: 'A', x: 0, y: 0 }, { name: 'B', x: alas, y: 0 }, { name: 'C', x: geser, y: tinggi },
          { name: 'H', x: geser, y: 0, hidden: true },
        ],
        polygons: [['A', 'B', 'C']],
        segments: [
          { from: 'A', to: 'B', label: `${alas}` },
          { from: 'B', to: 'C', label: '' },
          { from: 'C', to: 'A', label: '' },
        ],
        bantu,
      };
    },
  },
  persegi: {
    build: (p) => {
      const s = numOrDefault(p.sisi, 5);
      return {
        points: [{ name: 'A', x: 0, y: 0 }, { name: 'B', x: s, y: 0 }, { name: 'C', x: s, y: s }, { name: 'D', x: 0, y: s }],
        segments: [
          { from: 'A', to: 'B', label: `${s}` }, { from: 'B', to: 'C', label: `${s}` },
          { from: 'C', to: 'D', label: `${s}` }, { from: 'D', to: 'A', label: `${s}` },
        ],
      };
    },
  },
  'persegi-panjang': {
    build: (p) => {
      const pj = numOrDefault(p.panjang, 8), lb = numOrDefault(p.lebar, 5);
      return {
        points: [{ name: 'A', x: 0, y: 0 }, { name: 'B', x: pj, y: 0 }, { name: 'C', x: pj, y: lb }, { name: 'D', x: 0, y: lb }],
        segments: [
          { from: 'A', to: 'B', label: `${pj}` }, { from: 'B', to: 'C', label: `${lb}` },
          { from: 'C', to: 'D', label: `${pj}` }, { from: 'D', to: 'A', label: `${lb}` },
        ],
      };
    },
  },
  trapesium: {
    build: (p) => {
      const atas = numOrDefault(p.atas, 4), bawah = numOrDefault(p.bawah, 8), tinggi = numOrDefault(p.tinggi, 5);
      const offset = (bawah - atas) / 2;
      return {
        points: [
          { name: 'A', x: 0, y: 0 }, { name: 'B', x: bawah, y: 0 },
          { name: 'C', x: bawah - offset, y: tinggi }, { name: 'D', x: offset, y: tinggi },
          // Kaki garis tinggi dari D tegak lurus ke AB: titik bantu, tidak
          // ikut poligon. Tanpa ini "tinggi" cuma dipakai membentuk gambar
          // tapi tidak pernah kelihatan angkanya — soal sisi miring/luas yang
          // butuh tinggi jadi tidak bisa dijawab dari gambarnya saja.
          { name: 'H', x: offset, y: 0, hidden: true },
        ],
        // Poligon dikunci ke 4 titik asli: tanpa ini titik bantu H ikut
        // masuk daftar titik jadi bangun 5 sisi (bawaan tanpa "polygons"
        // eksplisit memakai SEMUA titik berurutan).
        polygons: [['A', 'B', 'C', 'D']],
        segments: [
          { from: 'A', to: 'B', label: `${bawah}` }, { from: 'B', to: 'C', label: '' },
          { from: 'C', to: 'D', label: `${atas}` }, { from: 'D', to: 'A', label: '' },
        ],
        bantu: [{ from: 'D', to: 'H', arah: 'B', label: `${tinggi}` }],
      };
    },
  },
  // Trapesium SIKU (bukan simetris seperti "trapesium" di atas): sisi kiri
  // tegak lurus alas, jadi sudut sikunya otomatis kelihatan lewat deteksi
  // sudut-siku bawaan renderGeometrySVG (dua sisi tegak lurus yang bertemu
  // di satu titik) — tidak perlu garis bantu terpisah untuk tingginya,
  // karena di sini tinggi memang salah satu sisi asli (kiri), bukan garis
  // bantu dari tengah seperti versi simetris.
  'trapesium-siku': {
    build: (p) => {
      const atas = numOrDefault(p.atas, 4), bawah = numOrDefault(p.bawah, 8), tinggi = numOrDefault(p.tinggi, 5);
      return {
        points: [
          { name: 'A', x: 0, y: 0 }, { name: 'B', x: bawah, y: 0 },
          { name: 'C', x: atas, y: tinggi }, { name: 'D', x: 0, y: tinggi },
        ],
        polygons: [['A', 'B', 'C', 'D']],
        segments: [
          { from: 'A', to: 'B', label: `${bawah}` }, { from: 'B', to: 'C', label: p.miring != null ? String(p.miring).trim() : '' },
          { from: 'C', to: 'D', label: `${atas}` }, { from: 'D', to: 'A', label: `${tinggi}` },
        ],
      };
    },
  },
  // Jajar genjang: alas mendatar di bawah, sisi atas digeser "geser" satuan
  // ke kanan (sejajar, sama panjang dengan alas). Tinggi selalu digambar
  // sebagai garis bantu putus-putus (seperti trapesium) karena hampir semua
  // soal luas jajar genjang memberikan tinggi, bukan sisi miringnya —
  // sisinya (AD/BC) cuma dilabeli kalau "sisi" diisi eksplisit.
  jajargenjang: {
    build: (p) => {
      const alas = numOrDefault(p.alas, 8), tinggi = numOrDefault(p.tinggi, 4);
      const geser = numOrDefault(p.geser, alas * 0.3);
      const sisi = p.sisi != null ? String(p.sisi).trim() : '';
      const arah = geser < alas / 2 ? 'B' : 'A';
      return {
        points: [
          { name: 'A', x: 0, y: 0 }, { name: 'B', x: alas, y: 0 },
          { name: 'C', x: alas + geser, y: tinggi }, { name: 'D', x: geser, y: tinggi },
          { name: 'H', x: geser, y: 0, hidden: true },
        ],
        polygons: [['A', 'B', 'C', 'D']],
        segments: [
          { from: 'A', to: 'B', label: `${alas}` }, { from: 'B', to: 'C', label: sisi },
          { from: 'C', to: 'D', label: '' }, { from: 'D', to: 'A', label: sisi },
        ],
        bantu: [{ from: 'D', to: 'H', arah, label: `${tinggi}` }],
      };
    },
  },
  // Segiempat yang dipecah diagonalnya jadi DUA segitiga siku-siku berbagi
  // diagonal sebagai sisi miring bersama (lingkaran Thales): sudut siku di B
  // (antara kaki1a & kaki1b) dan di D (antara kaki2 & sisi yang dicari) —
  // bukan di A/C, titik diagonalnya sendiri. Soal khasnya: hitung diagonal
  // dulu dari segitiga ABC, lalu pakai lagi di segitiga ACD untuk sisi
  // "dicari". Diagonalnya digambar putus-putus, panjangnya sengaja TIDAK
  // ditulis — itu justru langkah yang harus dihitung sendiri oleh siswa.
  'segiempat-diagonal': {
    build: (p) => {
      const kaki1a = numOrDefault(p.kaki1a, 6), kaki1b = numOrDefault(p.kaki1b, 7), kaki2 = numOrDefault(p.kaki2, 9);
      const dicari = String(p.dicari || 'a').trim();
      const L = Math.hypot(kaki1a, kaki1b) || 1;
      const kaki2b = Math.sqrt(Math.max(0, L * L - kaki2 * kaki2)) || 1;   // dipakai membentuk gambar saja
      const Bx = (kaki1a * kaki1a) / L, By = (kaki1a * kaki1b) / L;
      const Dx = L - (kaki2 * kaki2) / L, Dy = -(kaki2 * kaki2b) / L;
      return {
        points: [
          { name: 'A', x: 0, y: 0 }, { name: 'B', x: Bx, y: By },
          { name: 'C', x: L, y: 0 }, { name: 'D', x: Dx, y: Dy },
        ],
        polygons: [['A', 'B', 'C', 'D']],
        segments: [
          { from: 'A', to: 'B', label: `${kaki1a}` }, { from: 'B', to: 'C', label: `${kaki1b}` },
          { from: 'C', to: 'D', label: `${kaki2}` }, { from: 'D', to: 'A', label: dicari },
        ],
        bantu: [{ from: 'A', to: 'C', label: '' }],
      };
    },
  },
  lingkaran: {
    build: (p) => {
      const r = numOrDefault(p.jari, 4);
      return { points: [{ name: 'O', x: 0, y: 0 }], circles: [{ center: 'O', radius: r, label: `r = ${r}` }] };
    },
  },
  'setengah-lingkaran': {
    // No true arc primitive in this points/segments/circles model, so the
    // curve is approximated with a fan of straight segments — invisible at
    // worksheet print sizes, and it lets a semicircle be just another
    // "polygons" loop, combinable with any other preset via "gabungan".
    build: (p) => {
      const r = numOrDefault(p.jari, 4);
      const steps = 36;
      const points = [
        { name: 'A', x: -r, y: 0 },
        { name: 'B', x: r, y: 0 },
      ];
      const arcNames = [];
      for (let i = 1; i < steps; i++) {
        const t = Math.PI * (1 - i / steps);
        const name = 'arc' + i;
        points.push({ name, x: r * Math.cos(t), y: r * Math.sin(t), hidden: true });
        arcNames.push(name);
      }
      // Urutan loop harus A -> busur (dari A lewat puncak) -> B -> kembali ke
      // A lewat diameter. Urutan lama (A, B, busur...) membuat poligon
      // menarik dua tali busur silang tepat di atas diameter.
      return {
        points,
        polygons: [['A', ...arcNames, 'B']],
        segments: [{ from: 'A', to: 'B', label: `d = ${2 * r}` }],
      };
    },
  },
};

// Combines several GEOMETRY_PRESETS shapes, each placed at its own (x,y)
// offset, into one shape with multiple independent polygon loops — used by
// bentuk=gabungan for composite figures like a rectangle topped with a
// semicircle. Sub-shape syntax: "nama:key=val,key=val|nama2:key=val,...".
function buildGabungan(bagianRaw) {
  const parts = String(bagianRaw || '').split('|').map((s) => s.trim()).filter(Boolean);
  const points = [], polygons = [], segments = [], circles = [], bantu = [];
  parts.forEach((partStr, idx) => {
    const colonIdx = partStr.indexOf(':');
    const shapeName = (colonIdx > -1 ? partStr.slice(0, colonIdx) : partStr).trim();
    const paramsRaw = colonIdx > -1 ? partStr.slice(colonIdx + 1) : '';
    const params = {};
    paramsRaw.split(',').forEach((kv) => {
      const eq = kv.indexOf('=');
      if (eq > -1) params[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
    });
    const preset = GEOMETRY_PRESETS[shapeName];
    if (!preset) return;
    const shape = preset.build(params);
    const ox = numOrDefault(params.x, 0), oy = numOrDefault(params.y, 0);
    const prefix = 'p' + idx + '_';
    const nameMap = {};
    (shape.points || []).forEach((pt) => {
      const newName = prefix + pt.name;
      nameMap[pt.name] = newName;
      // Vertex letters (A, B, C...) are per sub-shape and collide/confuse
      // once several parts share one figure, so composite points never draw
      // their own dot+label — only the segment dimension labels (already
      // preserved below) carry meaning on a combined figure.
      points.push({ name: newName, x: pt.x + ox, y: pt.y + oy, hidden: true });
    });
    (shape.polygons || (shape.points.length >= 3 ? [shape.points.map((pt) => pt.name)] : [])).forEach((loop) => {
      polygons.push(loop.map((n) => nameMap[n]));
    });
    (shape.segments || []).forEach((seg) => {
      segments.push({ from: nameMap[seg.from], to: nameMap[seg.to], label: seg.label });
    });
    (shape.circles || []).forEach((c) => {
      circles.push({ center: nameMap[c.center], radius: c.radius, label: c.label });
    });
    (shape.bantu || []).forEach((h) => {
      bantu.push({ from: nameMap[h.from], to: nameMap[h.to], arah: h.arah ? nameMap[h.arah] : undefined, label: h.label });
    });
  });
  return { points, polygons, segments, circles, bantu };
}

// Kotak batas gambar. Setiap elemen yang digambar melaporkan luasnya lewat
// titik()/teks(), lalu bungkusGambarSVG() memotong kanvas pas ke isi. Tanpa
// ini bangun kecil duduk di tengah kanvas 360x280 yang sebagian besar kosong,
// dan huruf titik sudut di tepi bisa terpotong.
function kotakBatas() {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  b.titik = (x, y, r) => {
    r = r || 0;
    b.x0 = Math.min(b.x0, x - r); b.y0 = Math.min(b.y0, y - r);
    b.x1 = Math.max(b.x1, x + r); b.y1 = Math.max(b.y1, y + r);
  };
  // Lebar teks ditaksir 0.62 x ukuran font per karakter (Helvetica); y = baseline.
  b.teks = (x, y, teks, size, anchor) => {
    size = size || GAYA.teks;
    const w = String(teks).length * size * 0.62;
    const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
    b.titik(x0, y - size * 0.8); b.titik(x0 + w, y + size * 0.25);
  };
  return b;
}

// Membungkus isi gambar menjadi <svg> yang viewBox-nya pas dengan kotak batas.
// viewBox tetap "0 0 W H" (isi digeser lewat <g transform>) karena
// applyAnnotations menaruh anotasi dalam persen kanvas dan mengharapkan
// titik asal di (0,0). "NOT TO SCALE" ditulis di atas isi, rata kanan,
// seperti naskah Cambridge, sebelum kotak batas dikunci.
function bungkusGambarSVG(isi, b, tidakBerskala) {
  if (tidakBerskala) {
    const x = b.x1, y = b.y0 - 6;
    isi += tidakBerskalaSVG(x, y);
    b.teks(x, y, 'NOT TO SCALE', GAYA.teksKecil, 'end');
  }
  const m = 6;
  const W = Math.ceil(b.x1 - b.x0 + 2 * m), H = Math.ceil(b.y1 - b.y0 + 2 * m);
  return `<svg class="ws-diagram-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`
    + `<g transform="translate(${(m - b.x0).toFixed(1)},${(m - b.y0).toFixed(1)})">${isi}</g></svg>`;
}

// Letak teks di luar bangun searah normal (nx,ny) sejauh `jarak`. Jangkar
// teks mengikuti arah — ke kanan "start", ke kiri "end", ke atas/bawah
// "middle" — supaya jarak teks ke garis sama dari sisi mana pun dan huruf
// tidak pernah duduk di atas garis.
function letakTeksLuar(x, y, nx, ny, jarak, size) {
  size = size || GAYA.teks;
  const px = x + nx * jarak, py = y + ny * jarak;
  let anchor = 'middle';
  if (nx > 0.35) anchor = 'start'; else if (nx < -0.35) anchor = 'end';
  return { x: px, y: py + size * 0.35 + ny * size * 0.35, anchor };
}

// halo = garis tepi putih di bawah huruf (paint-order) supaya label yang
// terpaksa dekat garis bantu tetap terbaca.
function teksGeoSVG(pos, teks, size, italic, halo) {
  return `<text x="${pos.x.toFixed(1)}" y="${pos.y.toFixed(1)}" font-size="${size}"${italic ? ' font-style="italic"' : ''} text-anchor="${pos.anchor}" fill="${GAYA.hitam}"${halo ? ` stroke="${GAYA.putih}" stroke-width="3" paint-order="stroke"` : ''}>${escText(teks)}</text>`;
}

// Tanda sisi sama panjang: n garis kecil tegak lurus di tengah sisi.
function tickSisiSVG(x1, y1, x2, y2, n) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, k = 4.5;
  let s = '';
  for (let i = 0; i < n; i++) {
    const t = (i - (n - 1) / 2) * 4;
    const cx = mx + ux * t, cy = my + uy * t;
    s += `<line x1="${(cx - nx * k).toFixed(1)}" y1="${(cy - ny * k).toFixed(1)}" x2="${(cx + nx * k).toFixed(1)}" y2="${(cy + ny * k).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  }
  return s;
}

// Tanda sisi sejajar: n mata panah ">" di tengah sisi, arah (ux,uy).
function panahSejajarSVG(x1, y1, x2, y2, n) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, k = 5;
  let s = '';
  for (let i = 0; i < n; i++) {
    const t = (i - (n - 1) / 2) * 5 + k / 2;
    const tx = mx + ux * t, ty = my + uy * t;
    const bx = tx - ux * k, by = ty - uy * k;
    s += `<path d="M${(bx + nx * k).toFixed(1)} ${(by + ny * k).toFixed(1)} L${tx.toFixed(1)} ${ty.toFixed(1)} L${(bx - nx * k).toFixed(1)} ${(by - ny * k).toFixed(1)}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  }
  return s;
}

function renderGeometrySVG(cfg) {
  const shape = cfg.bentuk === 'gabungan'
    ? buildGabungan(cfg.bagian)
    : (GEOMETRY_PRESETS[cfg.bentuk] || GEOMETRY_PRESETS['segitiga-sembarang']).build(cfg);
  // Bangun dipaskan ke area ~250x200 px; kanvas akhirnya dipotong pas oleh
  // bungkusGambarSVG, jadi ukuran ini hanya menentukan skala huruf relatif
  // terhadap bangun (sekitar 10-11 pt saat dicetak selebar 260 pt).
  const areaW = 250, areaH = 200;
  const xs = shape.points.map((p) => p.x), ys = shape.points.map((p) => p.y);
  (shape.circles || []).forEach((c) => {
    const center = shape.points.find((p) => p.name === c.center);
    xs.push(center.x - c.radius, center.x + c.radius);
    ys.push(center.y - c.radius, center.y + c.radius);
  });
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1e-6), spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min(areaW / spanX, areaH / spanY);
  const toPx = (x, y) => [(x - minX) * scale, areaH - (y - minY) * scale];

  const b = kotakBatas();
  let isi = '';
  const pxMap = {}, ptByName = {};
  shape.points.forEach((p) => { pxMap[p.name] = toPx(p.x, p.y); ptByName[p.name] = p; });

  const polygons = shape.polygons || (shape.points.length >= 3 ? [shape.points.map((p) => p.name)] : []);
  const centroidOf = (loop) => {
    const c = [0, 0];
    loop.forEach((n) => { c[0] += pxMap[n][0]; c[1] += pxMap[n][1]; });
    return [c[0] / loop.length, c[1] / loop.length];
  };
  const loopOf = (a, bName) => polygons.find((loop) => loop.indexOf(a) > -1 && loop.indexOf(bName) > -1) || null;
  const unit = (x, y) => { const d = Math.hypot(x, y) || 1; return [x / d, y / d]; };
  const sama = (u, v) => Math.abs(u - v) < 1e-6 * Math.max(1, Math.abs(u));

  // Segmen yang sama persis dipakai dua bagian gabungan (mis. sisi atas
  // persegi panjang = diameter setengah lingkaran) adalah garis dalam:
  // label ukurannya tidak ditulis supaya tidak ada dua angka bertumpuk.
  const kunciSeg = (a, bName) => [a, bName].map((n) => pxMap[n].map((v) => v.toFixed(2)).join(',')).sort().join('|');
  const hitungSeg = {};
  polygons.forEach((loop) => loop.forEach((n, i) => {
    const k = kunciSeg(n, loop[(i + 1) % loop.length]);
    hitungSeg[k] = (hitungSeg[k] || 0) + 1;
  }));

  polygons.forEach((loop) => {
    const pts = loop.map((name) => pxMap[name].map((n) => n.toFixed(1)).join(',')).join(' ');
    isi += `<polygon points="${pts}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}" stroke-linejoin="round"/>`;
    loop.forEach((n) => b.titik(pxMap[n][0], pxMap[n][1], 1));

    // Sisi "nyata" = kedua ujungnya titik bernama (bukan titik bantu busur).
    const sisi = [];
    loop.forEach((n, i) => {
      const m = loop[(i + 1) % loop.length];
      if (ptByName[n].hidden || ptByName[m].hidden) return;
      const [x1, y1] = pxMap[n], [x2, y2] = pxMap[m];
      sisi.push({ x1, y1, x2, y2, len: Math.hypot(x2 - x1, y2 - y1), u: unit(x2 - x1, y2 - y1) });
    });
    const sudutSiku = [];
    loop.forEach((n, i) => {
      if (ptByName[n].hidden) return;
      const p = pxMap[loop[(i - 1 + loop.length) % loop.length]], q = pxMap[loop[(i + 1) % loop.length]], v = pxMap[n];
      const u1 = unit(p[0] - v[0], p[1] - v[1]), u2 = unit(q[0] - v[0], q[1] - v[1]);
      if (Math.abs(u1[0] * u2[0] + u1[1] * u2[1]) < 1e-6) sudutSiku.push([v, p, q]);
    });
    // Persegi/persegi panjang (semua sudut siku) sudah cukup terbaca dari
    // labelnya: tanda tick/panah/siku hanya menambah kesibukan gambar. Tanda
    // dipakai untuk segitiga sama kaki, trapesium (kaki sama + sisi sejajar), dsb.
    const semuaSiku = sisi.length >= 4 && sudutSiku.length === sisi.length;
    if (!semuaSiku) {
      sudutSiku.forEach(([v, p, q]) => { isi += rightAngleSVG(v[0], v[1], p[0], p[1], q[0], q[1], 9); });
      let grup = 0;
      const tickDari = new Map();
      sisi.forEach((s) => {
        if (tickDari.has(s)) return;
        const kembar = sisi.filter((t) => t !== s && sama(t.len, s.len));
        if (!kembar.length) return;
        grup++;
        [s].concat(kembar).forEach((t) => tickDari.set(t, grup));
      });
      tickDari.forEach((n, s) => { isi += tickSisiSVG(s.x1, s.y1, s.x2, s.y2, n); });
      let grupSejajar = 0;
      const panahDari = new Map();
      sisi.forEach((s) => {
        if (panahDari.has(s)) return;
        const sejajar = sisi.filter((t) => t !== s && Math.abs(s.u[0] * t.u[1] - s.u[1] * t.u[0]) < 1e-6);
        if (!sejajar.length) return;
        grupSejajar++;
        panahDari.set(s, grupSejajar);
        sejajar.forEach((t) => panahDari.set(t, grupSejajar));
      });
      panahDari.forEach((n, s) => {
        // Kedua panah dibuat searah (dot > 0) supaya terbaca sebagai sepasang.
        const acuan = [...panahDari.keys()].find((t) => panahDari.get(t) === n);
        const searah = s.u[0] * acuan.u[0] + s.u[1] * acuan.u[1] >= 0;
        isi += searah ? panahSejajarSVG(s.x1, s.y1, s.x2, s.y2, n) : panahSejajarSVG(s.x2, s.y2, s.x1, s.y1, n);
      });
    }
  });

  // Kalau soal sudah menempel anotasi "ukuran" (garis ukur + tulisan sendiri,
  // dipakai supaya keterangan persis meniru naskah asal — satuan, huruf
  // variabel seperti "c" untuk sisi yang dicari, dsb.), label bawaan bangun
  // (cuma angka polos) dilewati: dua-duanya selalu jatuh di titik tengah sisi
  // yang sama, jadi keterangan dari soal ketiban angka polos "ukuran aslinya".
  // Anotasi datang dari cfg yang sama (dipakai ulang oleh renderDiagramTag).
  const pakaiKeteranganSendiri = !!cfg.ukuran;

  (shape.circles || []).forEach((c) => {
    const center = pxMap[c.center];
    const R = c.radius * scale;
    isi += `<circle cx="${center[0].toFixed(1)}" cy="${center[1].toFixed(1)}" r="${R.toFixed(1)}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    b.titik(center[0], center[1], R + 1);
    // Jari-jari digambar sebagai ruas O ke lingkaran dengan labelnya di
    // atas ruas — bukan angka mengambang di tengah — seperti naskah ujian.
    isi += `<line x1="${center[0].toFixed(1)}" y1="${center[1].toFixed(1)}" x2="${(center[0] + R).toFixed(1)}" y2="${center[1].toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garisBantu}"/>`;
    isi += `<circle cx="${center[0].toFixed(1)}" cy="${center[1].toFixed(1)}" r="2.2" fill="${GAYA.hitam}"/>`;
    if (c.label && !pakaiKeteranganSendiri) {
      const pos = letakTeksLuar(center[0] + R / 2, center[1], 0, -1, 5);
      isi += teksGeoSVG(pos, c.label, GAYA.teks);
      b.teks(pos.x, pos.y, c.label, GAYA.teks, pos.anchor);
    }
  });

  (shape.segments || []).forEach((seg) => {
    if (!seg.label || pakaiKeteranganSendiri) return;
    if ((hitungSeg[kunciSeg(seg.from, seg.to)] || 0) > 1) return;
    const p1 = pxMap[seg.from], p2 = pxMap[seg.to];
    const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
    let [nx, ny] = unit(p2[1] - p1[1], p1[0] - p2[0]);
    // Normal dipilih yang menjauhi pusat loop pemilik sisi: label ukuran
    // selalu di luar bangun, apa pun arah putar daftar titiknya.
    const loop = loopOf(seg.from, seg.to);
    const c = loop ? centroidOf(loop) : [areaW / 2, areaH / 2];
    if ((mx - c[0]) * nx + (my - c[1]) * ny < 0) { nx = -nx; ny = -ny; }
    const pos = letakTeksLuar(mx, my, nx, ny, 9);
    isi += teksGeoSVG(pos, seg.label, GAYA.teks);
    b.teks(pos.x, pos.y, seg.label, GAYA.teks, pos.anchor);
  });

  // Garis bantu putus-putus (mis. tinggi trapesium dari titik puncak tegak
  // lurus ke alas): angka yang dipakai membentuk gambar tapi bukan sisi
  // bangun itu sendiri, jadi tidak boleh diam-diam hilang dari gambar —
  // tanpa ini siswa tidak punya cara mendapatkan angkanya untuk menjawab.
  (shape.bantu || []).forEach((h) => {
    if (pakaiKeteranganSendiri) return;
    const p1 = pxMap[h.from], p2 = pxMap[h.to];
    isi += `<line x1="${p1[0].toFixed(1)}" y1="${p1[1].toFixed(1)}" x2="${p2[0].toFixed(1)}" y2="${p2[1].toFixed(1)}" stroke="${GAYA.abu}" stroke-width="${GAYA.garisBantu}" stroke-dasharray="${GAYA.putus}"/>`;
    if (h.arah && pxMap[h.arah]) isi += rightAngleSVG(p2[0], p2[1], p1[0], p1[1], pxMap[h.arah][0], pxMap[h.arah][1], 7);
    // Garis bantu tanpa label (mis. diagonal bantu segiempat-diagonal): cuma
    // garisnya yang perlu tergambar, angkanya justru bagian yang dicari
    // sendiri oleh siswa lewat dua kali Pythagoras — jangan ditulis di sini.
    if (!h.label) return;
    const [nx, ny] = unit(p2[1] - p1[1], p1[0] - p2[0]);
    const pos = letakTeksLuar((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, nx, ny, 9);
    isi += teksGeoSVG(pos, h.label, GAYA.teks, false, true);
    b.teks(pos.x, pos.y, h.label, GAYA.teks, pos.anchor);
  });

  shape.points.forEach((p) => {
    if (p.hidden) return;
    const [px, py] = pxMap[p.name];
    // Huruf titik sudut diletakkan pada garis bagi sudut LUAR (menjauhi kedua
    // sisi yang bertemu di situ) supaya tidak menimpa garis; titik lepas
    // (pusat lingkaran) diletakkan di kiri bawah.
    let dir = [-0.7, 0.7];
    const loop = polygons.find((l) => l.indexOf(p.name) > -1);
    if (loop) {
      const i = loop.indexOf(p.name);
      const q = pxMap[loop[(i - 1 + loop.length) % loop.length]], r = pxMap[loop[(i + 1) % loop.length]];
      const u1 = unit(q[0] - px, q[1] - py), u2 = unit(r[0] - px, r[1] - py);
      const sx = -(u1[0] + u2[0]), sy = -(u1[1] + u2[1]);
      if (Math.hypot(sx, sy) > 1e-3) dir = unit(sx, sy);
      else { const c = centroidOf(loop); dir = unit(px - c[0], py - c[1]); }
    }
    const pos = letakTeksLuar(px, py, dir[0], dir[1], 8, 12.5);
    isi += teksGeoSVG(pos, p.name, 12.5, true);
    b.teks(pos.x, pos.y, p.name, 12.5, pos.anchor);
  });

  const adaUkuran = pakaiKeteranganSendiri
    || (shape.segments || []).some((s) => s.label) || (shape.circles || []).some((c) => c.label);
  return bungkusGambarSVG(isi, b, adaUkuran);
}

// ---------------------------------------------------------------------
// 2b. Piktogram
// ---------------------------------------------------------------------

function iconStar(cx, cy, s) {
  const outer = s / 2, inner = outer * 0.382;
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push((cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1));
  }
  return `<polygon points="${pts.join(' ')}" fill="none" stroke="#000000" stroke-width="1.3"/>`;
}
function iconCircle(cx, cy, s) {
  return `<circle cx="${cx}" cy="${cy}" r="${(s / 2).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.3"/>`;
}
function iconSquare(cx, cy, s) {
  const h = s / 2;
  return `<rect x="${(cx - h).toFixed(1)}" y="${(cy - h).toFixed(1)}" width="${s}" height="${s}" fill="none" stroke="#000000" stroke-width="1.3"/>`;
}
function iconTriangle(cx, cy, s) {
  const h = s / 2;
  return `<polygon points="${cx},${(cy - h).toFixed(1)} ${(cx - h).toFixed(1)},${(cy + h).toFixed(1)} ${(cx + h).toFixed(1)},${(cy + h).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.3"/>`;
}
function iconHeart(cx, cy, s) {
  const w = s, h = s, x0 = cx - w / 2, y0 = cy - h / 2;
  const d = `M${cx},${(y0 + h * 0.3).toFixed(1)} C${cx},${y0.toFixed(1)} ${x0.toFixed(1)},${y0.toFixed(1)} ${x0.toFixed(1)},${(y0 + h * 0.3).toFixed(1)} C${x0.toFixed(1)},${(y0 + h * 0.6).toFixed(1)} ${cx},${(y0 + h * 0.8).toFixed(1)} ${cx},${(y0 + h).toFixed(1)} C${cx},${(y0 + h * 0.8).toFixed(1)} ${(x0 + w).toFixed(1)},${(y0 + h * 0.6).toFixed(1)} ${(x0 + w).toFixed(1)},${(y0 + h * 0.3).toFixed(1)} C${(x0 + w).toFixed(1)},${y0.toFixed(1)} ${cx},${y0.toFixed(1)} ${cx},${(y0 + h * 0.3).toFixed(1)} Z`;
  return `<path d="${d}" fill="none" stroke="#000000" stroke-width="1.3"/>`;
}
function iconApple(cx, cy, s) {
  const r = s * 0.42, bodyCy = cy + s * 0.08;
  let svg = `<circle cx="${cx.toFixed(1)}" cy="${bodyCy.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.3"/>`;
  svg += `<line x1="${cx.toFixed(1)}" y1="${(bodyCy - r).toFixed(1)}" x2="${(cx + s * 0.05).toFixed(1)}" y2="${(bodyCy - r - s * 0.22).toFixed(1)}" stroke="#000000" stroke-width="1.3"/>`;
  svg += `<ellipse cx="${(cx + s * 0.18).toFixed(1)}" cy="${(bodyCy - r - s * 0.14).toFixed(1)}" rx="${(s * 0.12).toFixed(1)}" ry="${(s * 0.06).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.1" transform="rotate(-30 ${(cx + s * 0.18).toFixed(1)} ${(bodyCy - r - s * 0.14).toFixed(1)})"/>`;
  return svg;
}
function iconPerson(cx, cy, s) {
  const headR = s * 0.14, headCy = cy - s * 0.32, shoulderY = headCy + headR + 2, hipY = cy + s * 0.15;
  let svg = `<circle cx="${cx.toFixed(1)}" cy="${headCy.toFixed(1)}" r="${headR.toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.3"/>`;
  svg += `<line x1="${cx.toFixed(1)}" y1="${shoulderY.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${hipY.toFixed(1)}" stroke="#000000" stroke-width="1.3"/>`;
  svg += `<line x1="${cx.toFixed(1)}" y1="${(shoulderY + 3).toFixed(1)}" x2="${(cx - s * 0.22).toFixed(1)}" y2="${(shoulderY + s * 0.18).toFixed(1)}" stroke="#000000" stroke-width="1.3"/>`;
  svg += `<line x1="${cx.toFixed(1)}" y1="${(shoulderY + 3).toFixed(1)}" x2="${(cx + s * 0.22).toFixed(1)}" y2="${(shoulderY + s * 0.18).toFixed(1)}" stroke="#000000" stroke-width="1.3"/>`;
  svg += `<line x1="${cx.toFixed(1)}" y1="${hipY.toFixed(1)}" x2="${(cx - s * 0.18).toFixed(1)}" y2="${(cy + s * 0.42).toFixed(1)}" stroke="#000000" stroke-width="1.3"/>`;
  svg += `<line x1="${cx.toFixed(1)}" y1="${hipY.toFixed(1)}" x2="${(cx + s * 0.18).toFixed(1)}" y2="${(cy + s * 0.42).toFixed(1)}" stroke="#000000" stroke-width="1.3"/>`;
  return svg;
}
function iconBook(cx, cy, s) {
  const w = s * 0.8, h = s * 0.6, x0 = cx - w / 2, y0 = cy - h / 2;
  let svg = `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.3"/>`;
  svg += `<line x1="${cx.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${(y0 + h).toFixed(1)}" stroke="#000000" stroke-width="1.1"/>`;
  return svg;
}

function iconBotol(cx, cy, s) {
  // Botol tampak depan: leher sempit, bahu melebar, badan lurus — dipakai soal
  // "dua botol sebangun" (kapasitas/volume), bukan piktogram, tapi bentuknya
  // dipakai ulang di renderSebangunSVG karena sudah ada di sini.
  const bodyW = s * 0.62, neckW = s * 0.24, neckH = s * 0.2, bahuH = s * 0.14;
  const atas = cy - s / 2, leherBawah = atas + neckH, bahuBawah = leherBawah + bahuH, bawah = cy + s / 2;
  const nx0 = cx - neckW / 2, nx1 = cx + neckW / 2, x0 = cx - bodyW / 2, x1 = cx + bodyW / 2;
  const d = `M${nx0.toFixed(1)} ${atas.toFixed(1)} L${nx1.toFixed(1)} ${atas.toFixed(1)} L${nx1.toFixed(1)} ${leherBawah.toFixed(1)}`
    + ` L${x1.toFixed(1)} ${bahuBawah.toFixed(1)} L${x1.toFixed(1)} ${bawah.toFixed(1)} L${x0.toFixed(1)} ${bawah.toFixed(1)}`
    + ` L${x0.toFixed(1)} ${bahuBawah.toFixed(1)} L${nx0.toFixed(1)} ${leherBawah.toFixed(1)} Z`;
  return `<path d="${d}" fill="none" stroke="#000000" stroke-width="1.3"/>`;
}

const ICON_DRAWERS = {
  bintang: iconStar, lingkaran: iconCircle, kotak: iconSquare, segitiga: iconTriangle,
  hati: iconHeart, apel: iconApple, buah: iconApple, orang: iconPerson, buku: iconBook,
  botol: iconBotol,
};

// ---------------------------------------------------------------------
// 2a-1. Bangun sebangun (dua bentuk sama, ukuran beda) — faktor skala
// ---------------------------------------------------------------------
// Soal "dua bangun sebangun, luas/volume diketahui, cari tinggi/luas yang
// lain" sering memakai bentuk tidak baku (hati, botol) yang bentuk persisnya
// tidak penting secara matematis — makanya dipinjam dari ikon piktogram yang
// sudah ada, bukan preset "bangun" baru. Yang penting tinggi & luas/volumenya
// tertulis, dan ukuran gambarnya kira-kira sebanding.
function renderSebangunSVG(cfg) {
  const gambar = ICON_DRAWERS[cfg.bentuk] || ICON_DRAWERS.hati;
  const tinggiA = String(cfg.tinggiA ?? '9').trim();
  const tinggiB = String(cfg.tinggiB ?? 'x').trim();
  const nA = parseFloat(tinggiA), nB = parseFloat(tinggiB);
  // Ukuran GAMBAR sebanding dengan tinggi asli: kalau kedua tinggi memang
  // angka, yang tingginya lebih besar digambar lebih besar (bukan selalu A).
  // Kalau salah satunya huruf (nilai yang dicari, mis. "x"), pakai rasio
  // tetap yang wajar supaya bangun kedua tetap kelihatan beda ukuran.
  let sA, sB;
  if (isFinite(nA) && isFinite(nB) && nA > 0 && nB > 0) {
    const rasio = Math.max(0.28, Math.min(3.5, nB / nA));
    if (rasio >= 1) { sB = 100; sA = Math.max(38, 100 / rasio); }
    else { sA = 100; sB = Math.max(38, 100 * rasio); }
  } else {
    sA = 100; sB = 72;
  }

  const b = kotakBatas();
  let isi = '';
  const jarakPanah = 20, celah = 40;
  let cursor = jarakPanah;

  const satu = (s, tinggiTeks, labelUkuran) => {
    const ax = cursor;
    const cx = ax + jarakPanah + s / 2, cy = 0;
    isi += gambar(cx, cy, s);
    b.titik(cx - s / 2, cy - s / 2); b.titik(cx + s / 2, cy + s / 2);
    // Panah tinggi di kiri bangun, dua ujung berpanah seperti garis ukur teknik.
    isi += arrowSVG(ax, cy - s / 2, ax, cy + s / 2, { headLen: 6 });
    isi += arrowSVG(ax, cy + s / 2, ax, cy - s / 2, { headLen: 6 });
    const posT = letakTeksLuar(ax, cy, -1, 0, 6);
    isi += teksGeoSVG(posT, tinggiTeks, GAYA.teks);
    b.teks(posT.x, posT.y, tinggiTeks, GAYA.teks, posT.anchor);
    // Label luas/volume di tengah bangun (mis. "36 cm²" atau "1.35 l").
    if (labelUkuran) {
      isi += `<text x="${cx.toFixed(1)}" y="${(cy + s * 0.12).toFixed(1)}" font-size="${GAYA.teks}" text-anchor="middle" fill="${GAYA.hitam}">${escText(labelUkuran)}</text>`;
      b.teks(cx, cy + s * 0.12, labelUkuran, GAYA.teks, 'middle');
    }
    cursor = cx + s / 2 + celah;
  };
  satu(sA, tinggiA, cfg.labelA || '');
  satu(sB, tinggiB, cfg.labelB || '');

  return bungkusGambarSVG(isi, b, true);
}

// Sektor lingkaran (juring) untuk soal panjang busur/luas juring — pusat O
// di atas, dua jari-jari turun simetris ke kiri-kanan, busur asli (bukan
// poligon pendekatan) menghubungkan ujungnya. jari & sudut dipakai untuk
// MENGGAMBAR (angka wajar dipakai kalau yang diberikan bukan angka bersih,
// mis. "r" yang dicari) sekaligus sebagai TEKS label kalau memang angka —
// pola yang sama seperti tinggiA/tinggiB di sebangun.
function renderSectorSVG(cfg) {
  const rGambar = numOrDefault(cfg.jari, 6);
  const labelJari = String(cfg.jari ?? rGambar).trim();
  const sudutGambar = Math.min(300, Math.max(20, numOrDefault(cfg.sudut, 90)));
  const labelSudut = String(cfg.sudut ?? sudutGambar).trim();
  const labelBusur = cfg.busur != null ? String(cfg.busur).trim() : '';

  const R = 95;
  const setengah = (sudutGambar / 2) * Math.PI / 180;
  const O = [0, 0];
  const Pr = [R * Math.sin(setengah), R * Math.cos(setengah)];
  const Pl = [-R * Math.sin(setengah), R * Math.cos(setengah)];
  const large = sudutGambar > 180 ? 1 : 0;

  const b = kotakBatas();
  let isi = '';
  isi += `<path d="M${O[0].toFixed(1)} ${O[1].toFixed(1)} L${Pr[0].toFixed(1)} ${Pr[1].toFixed(1)} A${R} ${R} 0 ${large} 1 ${Pl[0].toFixed(1)} ${Pl[1].toFixed(1)} Z" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  b.titik(O[0], O[1]); b.titik(Pr[0], Pr[1]); b.titik(Pl[0], Pl[1]);
  // Busur dipaskan batasnya lewat titik puncaknya juga (titik terjauh dari O
  // ke arah bawah), supaya pemotongan kanvas tidak memotong busur yang
  // menggembung melewati garis lurus Pl-Pr saat sudut > 180°.
  b.titik(0, R);

  // Tanda sudut: busur kecil dekat O + label di tengahnya.
  const rTanda = 20;
  const Ar = [rTanda * Math.sin(setengah), rTanda * Math.cos(setengah)];
  const Al = [-rTanda * Math.sin(setengah), rTanda * Math.cos(setengah)];
  isi += `<path d="M${Ar[0].toFixed(1)} ${Ar[1].toFixed(1)} A${rTanda} ${rTanda} 0 ${large} 1 ${Al[0].toFixed(1)} ${Al[1].toFixed(1)}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garisBantu}"/>`;
  const posSudut = { x: 0, y: rTanda * 0.8 + 11, anchor: 'middle' };
  isi += teksGeoSVG(posSudut, labelSudut, GAYA.teks);
  b.teks(posSudut.x, posSudut.y, labelSudut, GAYA.teks, 'middle');

  // Titik pusat O berlabel.
  isi += `<circle cx="0" cy="0" r="2.2" fill="${GAYA.hitam}"/>`;
  const posO = letakTeksLuar(0, 0, -0.6, -0.9, 10);
  isi += teksGeoSVG(posO, 'O', GAYA.teks, true);
  b.teks(posO.x, posO.y, 'O', GAYA.teks, posO.anchor);

  // Label jari-jari di sisi kanan (O ke Pr), tengah ruas, menjauhi juring.
  const midR = [(O[0] + Pr[0]) / 2, (O[1] + Pr[1]) / 2];
  const dNx = Pr[1] - O[1], dNy = O[0] - Pr[0], dNlen = Math.hypot(dNx, dNy) || 1;
  const nxR = dNx / dNlen, nyR = dNy / dNlen;
  const posJari = letakTeksLuar(midR[0], midR[1], nxR, nyR, 9);
  isi += teksGeoSVG(posJari, labelJari, GAYA.teks);
  b.teks(posJari.x, posJari.y, labelJari, GAYA.teks, posJari.anchor);

  // Label panjang busur di tengah lengkungan luar (karena simetris, tengah
  // busur selalu tepat lurus di bawah O), menjauhi O.
  if (labelBusur) {
    const posBusur = letakTeksLuar(0, R, 0, 1, 9);
    isi += teksGeoSVG(posBusur, labelBusur, GAYA.teks);
    b.teks(posBusur.x, posBusur.y, labelBusur, GAYA.teks, posBusur.anchor);
  }

  return bungkusGambarSVG(isi, b, true);
}

// Bangun datar (trapesium atau persegi panjang) dengan GIGITAN setengah
// lingkaran di sisi atas atau bawah — soal "luas yang diarsir = luas bangun
// - luas setengah lingkaran". Ditulis sebagai fungsi tersendiri (bukan lewat
// GEOMETRY_PRESETS/renderGeometrySVG yang cuma tahu poligon lurus terpisah)
// karena gigitannya harus jadi SATU garis tepi menyambung lewat busur asli
// (SVG arc), bukan dua bentuk bertumpuk — dipakai lewat bentuk=potong-lingkaran
// di tag [[bangun: ...]], bukan tag tersendiri, supaya AI tidak perlu belajar
// jenis tag baru untuk ini.
function renderCutoutSVG(cfg) {
  const dasar = String(cfg.dasar || 'trapesium').toLowerCase();
  const jariPotongV = numOrDefault(cfg.jariPotong, 3.5);
  const sisiPotong = String(cfg.sisiPotong || 'atas').toLowerCase() === 'bawah' ? 'bawah' : 'atas';

  let bawahV, atasV, tinggiV, persegiPanjang;
  if (dasar === 'persegi-panjang') {
    bawahV = numOrDefault(cfg.panjang, 10);
    atasV = bawahV;
    tinggiV = numOrDefault(cfg.lebar, 6);
    persegiPanjang = true;
  } else {
    bawahV = numOrDefault(cfg.bawah, 18);
    atasV = numOrDefault(cfg.atas, bawahV * 0.4);
    tinggiV = numOrDefault(cfg.tinggi, 6);
    persegiPanjang = false;
  }

  const scale = Math.min(220 / bawahV, 32);
  const bawah = bawahV * scale, atas = atasV * scale, tinggi = tinggiV * scale;
  // Diameter potongan tidak boleh melebihi sisi tempat ia dipotong, kalau
  // tidak lengkungnya menembus ujung bangun dan menyilang sisi miringnya
  // (angka yang diberikan AI/guru kadang tidak konsisten secara geometris,
  // ini jaring pengaman visualnya).
  const batasSisi = (sisiPotong === 'atas' ? atas : bawah) / 2 - 2;
  // ...dan juga tidak boleh melebihi tinggi bangun, kalau tidak lengkungnya
  // menembus keluar dari sisi SEBERANGNYA.
  const batasTinggi = tinggi - 6;
  const rPotong = Math.max(4, Math.min(jariPotongV * scale, batasSisi, batasTinggi));
  const offset = (bawah - atas) / 2;

  // Titik sudut (y ke bawah, sisi "atas" model = y=0, "bawah" = y=tinggi).
  const A = [0, tinggi], B = [bawah, tinggi], C = [bawah - offset, 0], D = [offset, 0];

  const b = kotakBatas();
  let isi = '';
  let pathD, rLabelPos, rLabelN;
  if (sisiPotong === 'atas') {
    const midX = (D[0] + C[0]) / 2;
    const kanan = [midX + rPotong, 0], kiri = [midX - rPotong, 0];
    // sweep=1 (searah jarum jam di koordinat y-ke-bawah): dari titik kanan
    // lewat bawah (menggembung MASUK ke bangun) ke titik kiri.
    pathD = `M${A[0].toFixed(1)} ${A[1].toFixed(1)} L${B[0].toFixed(1)} ${B[1].toFixed(1)} L${C[0].toFixed(1)} ${C[1].toFixed(1)}`
      + ` L${kanan[0].toFixed(1)} ${kanan[1].toFixed(1)} A${rPotong.toFixed(1)} ${rPotong.toFixed(1)} 0 0 1 ${kiri[0].toFixed(1)} ${kiri[1].toFixed(1)}`
      + ` L${D[0].toFixed(1)} ${D[1].toFixed(1)} Z`;
    rLabelPos = [midX, rPotong]; rLabelN = [0, 1];
  } else {
    const midX = bawah / 2;
    const kanan = [midX + rPotong, tinggi], kiri = [midX - rPotong, tinggi];
    // sweep=0: dari titik kanan lewat atas (menggembung MASUK ke bangun) ke titik kiri.
    pathD = `M${D[0].toFixed(1)} ${D[1].toFixed(1)} L${C[0].toFixed(1)} ${C[1].toFixed(1)} L${B[0].toFixed(1)} ${B[1].toFixed(1)}`
      + ` L${kanan[0].toFixed(1)} ${kanan[1].toFixed(1)} A${rPotong.toFixed(1)} ${rPotong.toFixed(1)} 0 0 0 ${kiri[0].toFixed(1)} ${kiri[1].toFixed(1)}`
      + ` L${A[0].toFixed(1)} ${A[1].toFixed(1)} Z`;
    rLabelPos = [midX, tinggi - rPotong]; rLabelN = [0, -1];
  }
  isi += `<path d="${pathD}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  [A, B, C, D].forEach(([x, y]) => b.titik(x, y));
  b.titik(rLabelPos[0], rLabelPos[1] + rLabelN[1] * 14);

  // Label sisi yang TIDAK kena potongan (bawah kalau potongannya di atas,
  // dan sebaliknya) — sisi yang kena potongan sengaja tidak dilabeli karena
  // bentangnya sendiri terputus oleh busur, persis gaya naskah Cambridge.
  const labelBawah = String(cfg.bawah ?? (persegiPanjang ? cfg.panjang : bawahV)).trim();
  const labelAtas = String(cfg.atas ?? atasV).trim();
  if (sisiPotong === 'bawah') {
    const pos = letakTeksLuar((D[0] + C[0]) / 2, 0, 0, -1, 9);
    isi += teksGeoSVG(pos, persegiPanjang ? labelBawah : labelAtas, GAYA.teks);
    b.teks(pos.x, pos.y, persegiPanjang ? labelBawah : labelAtas, GAYA.teks, pos.anchor);
  } else {
    const pos = letakTeksLuar((A[0] + B[0]) / 2, tinggi, 0, 1, 9);
    isi += teksGeoSVG(pos, labelBawah, GAYA.teks);
    b.teks(pos.x, pos.y, labelBawah, GAYA.teks, pos.anchor);
  }

  // Tinggi: persegi panjang punya sisi tegak asli (A-D) jadi dilabeli
  // langsung; trapesium sejati butuh garis bantu putus-putus karena sisi
  // miringnya bukan tinggi sebenarnya.
  if (persegiPanjang) {
    const pos = letakTeksLuar(0, tinggi / 2, -1, 0, 9);
    isi += teksGeoSVG(pos, `${tinggiV}`, GAYA.teks);
    b.teks(pos.x, pos.y, `${tinggiV}`, GAYA.teks, pos.anchor);
  } else {
    const H = [offset, tinggi];
    isi += `<line x1="${D[0].toFixed(1)}" y1="${D[1].toFixed(1)}" x2="${H[0].toFixed(1)}" y2="${H[1].toFixed(1)}" stroke="${GAYA.abu}" stroke-width="${GAYA.garisBantu}" stroke-dasharray="${GAYA.putus}"/>`;
    isi += rightAngleSVG(H[0], H[1], D[0], D[1], A[0], A[1], 7);
    const pos = letakTeksLuar((D[0] + H[0]) / 2, (D[1] + H[1]) / 2, -1, 0, 9);
    isi += teksGeoSVG(pos, `${tinggiV}`, GAYA.teks);
    b.teks(pos.x, pos.y, `${tinggiV}`, GAYA.teks, pos.anchor);
  }

  // Label jari-jari potongan, di titik terdalam busur, menjauhi bangun.
  const posR = letakTeksLuar(rLabelPos[0], rLabelPos[1], rLabelN[0], rLabelN[1], 9);
  isi += teksGeoSVG(posR, `${jariPotongV}`, GAYA.teks);
  b.teks(posR.x, posR.y, `${jariPotongV}`, GAYA.teks, posR.anchor);

  return bungkusGambarSVG(isi, b, true);
}

let pictogramClipCounter = 0;

function renderPictogramSVG(cfg) {
  const drawer = ICON_DRAWERS[cfg.simbol] || ICON_DRAWERS.bintang;
  const skala = numOrDefault(cfg.skala, 1) || 1;
  const labels = String(cfg.label || '').split(',').map((s) => s.trim()).filter(Boolean);
  const data = String(cfg.data || '').split(',').map((s) => parseFloat(s.trim()) || 0);
  const satuan = cfg.satuan || '';

  const rowH = 32, iconSize = 18, iconGap = 6, labelW = 92, pad = 14;
  const maxIcons = Math.max(...data.map((v) => Math.ceil(v / skala)), 1);
  const width = Math.min(560, labelW + pad * 2 + maxIcons * (iconSize + iconGap) + 50);
  const height = pad * 2 + labels.length * rowH + 28;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;

  labels.forEach((lb, i) => {
    const v = data[i] || 0;
    const y = pad + i * rowH + rowH / 2;
    svg += `<text x="${pad}" y="${(y + 4).toFixed(1)}" font-size="10.5" fill="#000000">${escText(lb)}</text>`;
    const full = Math.floor(v / skala + 1e-9);
    const remainder = v / skala - full;
    let x = pad + labelW;
    for (let k = 0; k < full; k++) {
      svg += drawer(x + iconSize / 2, y, iconSize);
      x += iconSize + iconGap;
    }
    if (remainder >= 0.5 - 1e-9 && remainder > 0.01) {
      const clipId = 'pic' + pictogramClipCounter++;
      svg += `<clipPath id="${clipId}"><rect x="${x.toFixed(1)}" y="${(y - iconSize / 2).toFixed(1)}" width="${(iconSize / 2).toFixed(1)}" height="${iconSize}"/></clipPath>`;
      svg += `<g clip-path="url(#${clipId})">${drawer(x + iconSize / 2, y, iconSize)}</g>`;
      x += iconSize + iconGap;
    }
    svg += `<text x="${(x + 4).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="10" fill="#333333">(${v})</text>`;
  });

  const legendY = pad + labels.length * rowH + 16;
  svg += drawer(pad + 8, legendY, 15);
  svg += `<text x="${pad + 22}" y="${(legendY + 4).toFixed(1)}" font-size="9.5" fill="#000000">= ${skala}${satuan ? ' ' + escText(satuan) : ''}</text>`;

  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 2c. Bangun Ruang (3D, proyeksi oblique/kavalier)
// ---------------------------------------------------------------------

const OBLIQUE_ANGLE = Math.PI / 6;
const OBLIQUE_SCALE = 0.5;
// Rusuk kedalaman menjauh ke kanan-ATAS (y model ke atas): muka depan, kanan,
// dan atas benda terlihat — sudut pandang baku bangun ruang di naskah ujian,
// dan pasangan yang benar untuk rusuk-rusuk tersembunyi di SOLID_PRESETS
// (titik belakang-kiri-bawah D beserta ketiga rusuknya). Dulu menjauh ke
// kanan-bawah, seolah benda dilihat dari bawah, padahal rusuk putus-putusnya
// dipilih untuk pandangan dari atas.
function obliquePt(x, y, depth) {
  return [x + depth * OBLIQUE_SCALE * Math.cos(OBLIQUE_ANGLE), y + depth * OBLIQUE_SCALE * Math.sin(OBLIQUE_ANGLE)];
}

// Tiap preset mengembalikan gambar dalam koordinat model (y ke atas):
//   edges    : rusuk; dashed = tersembunyi (putus-putus abu), tipis = garis
//              bantu (tinggi, jari-jari) yang bukan rusuk benda
//   ellipses : belah = separuh depan padat, separuh belakang putus-putus
//   siku     : tanda sudut siku di v antara arah a dan b
//   labels   : ukuran, n = arah normal (menjauhi benda) untuk meletakkan teks
//   vertices : huruf titik sudut, n = arah letak huruf
// Penamaan mengikuti naskah Cambridge: alas ABCD, tutup EFGH (E di atas A),
// puncak limas/kerucut V, pusat alas O.
const SOLID_PRESETS = {
  kubus: (p) => {
    const s = numOrDefault(p.sisi, 5);
    const A = [0, 0], B = [s, 0], C = obliquePt(s, 0, s), D = obliquePt(0, 0, s);
    const E = [0, s], F = [s, s], G = obliquePt(s, s, s), H = obliquePt(0, s, s);
    return {
      edges: [
        { a: A, b: B }, { a: B, b: C }, { a: C, b: D, dashed: true }, { a: D, b: A, dashed: true },
        { a: E, b: F }, { a: F, b: G }, { a: G, b: H }, { a: H, b: E },
        { a: A, b: E }, { a: B, b: F }, { a: C, b: G }, { a: D, b: H, dashed: true },
      ],
      labels: [
        { pos: [s / 2, 0], text: `s = ${s}`, n: [0, -1] },
      ],
      vertices: [
        { pos: A, name: 'A', n: [-0.7, -0.7] }, { pos: B, name: 'B', n: [0.7, -0.7] },
        { pos: C, name: 'C', n: [1, -0.2] }, { pos: D, name: 'D', n: [-1, 0.3] },
        { pos: E, name: 'E', n: [-0.8, 0.6] }, { pos: F, name: 'F', n: [1, -0.4] },
        { pos: G, name: 'G', n: [0.7, 0.7] }, { pos: H, name: 'H', n: [-0.3, 1] },
      ],
    };
  },
  balok: (p) => {
    const pj = numOrDefault(p.panjang, 8), lb = numOrDefault(p.lebar, 5), t = numOrDefault(p.tinggi, 4);
    const A = [0, 0], B = [pj, 0], C = obliquePt(pj, 0, lb), D = obliquePt(0, 0, lb);
    const E = [0, t], F = [pj, t], G = obliquePt(pj, t, lb), H = obliquePt(0, t, lb);
    return {
      edges: [
        { a: A, b: B }, { a: B, b: C }, { a: C, b: D, dashed: true }, { a: D, b: A, dashed: true },
        { a: E, b: F }, { a: F, b: G }, { a: G, b: H }, { a: H, b: E },
        { a: A, b: E }, { a: B, b: F }, { a: C, b: G }, { a: D, b: H, dashed: true },
      ],
      labels: [
        { pos: [pj / 2, 0], text: `p = ${pj}`, n: [0, -1] },
        { pos: [pj, t / 2], text: `t = ${t}`, n: [1, 0] },
        { pos: [(B[0] + C[0]) / 2, (B[1] + C[1]) / 2], text: `l = ${lb}`, n: [0.7, -0.7] },
      ],
      vertices: [
        { pos: A, name: 'A', n: [-0.7, -0.7] }, { pos: B, name: 'B', n: [0.7, -0.7] },
        { pos: C, name: 'C', n: [1, -0.2] }, { pos: D, name: 'D', n: [-1, 0.3] },
        { pos: E, name: 'E', n: [-0.8, 0.6] }, { pos: F, name: 'F', n: [1, -0.4] },
        { pos: G, name: 'G', n: [0.7, 0.7] }, { pos: H, name: 'H', n: [-0.3, 1] },
      ],
    };
  },
  // Balok berundak (dua kotak bersusun, yang atas lebih sempit, rata kiri) —
  // soal "dua bangun ruang sebangun berundak, volume diberikan sebagai
  // angka, cari tinggi/volume yang lain". Proporsi lebar/kedalaman tetap
  // (NOT TO SCALE) — cuma tinggi total yang dipakai menskalakan gambar dan
  // ditulis sebagai label; volume/keterangan lain ditulis lewat `label`
  // karena bukan hasil hitungan dari gambarnya, melainkan angka soal sendiri.
  berundak: (p) => {
    const tinggi = numOrDefault(p.tinggi, 10);
    const labelTinggi = String(p.labelTinggi ?? p.tinggi ?? tinggi).trim();
    const keterangan = String(p.label || '').trim();
    const Wb = 8, Ws = 3.6, Dp = 4;
    const h1 = tinggi * 0.55, h2 = tinggi * 0.45;
    const A = [0, 0], B = [Wb, 0], C = obliquePt(Wb, 0, Dp), Dd = obliquePt(0, 0, Dp);
    const F = [Wb, h1], G = obliquePt(Wb, h1, Dp);
    const F2 = [Ws, h1], G2 = obliquePt(Ws, h1, Dp);
    const F3 = [Ws, h1 + h2], G3 = obliquePt(Ws, h1 + h2, Dp);
    const E3 = [0, h1 + h2], H3 = obliquePt(0, h1 + h2, Dp);
    return {
      edges: [
        { a: A, b: B }, { a: B, b: F }, { a: B, b: C }, { a: F, b: G }, { a: G, b: C },
        { a: F, b: F2 }, { a: G, b: G2 }, { a: F2, b: G2 },
        { a: F2, b: F3 }, { a: F3, b: G3 }, { a: G2, b: G3 },
        { a: F3, b: E3 }, { a: G3, b: H3 }, { a: H3, b: E3 },
        { a: E3, b: A },
        { a: C, b: Dd, dashed: true }, { a: Dd, b: A, dashed: true }, { a: Dd, b: H3, dashed: true },
      ],
      labels: [
        { pos: [0, (h1 + h2) / 2], text: labelTinggi, n: [-1, 0] },
        ...(keterangan ? [{ pos: [Wb * 0.55, h1 * 0.45], text: keterangan, n: [0, -1] }] : []),
      ],
    };
  },
  tabung: (p) => {
    const r = numOrDefault(p.jari, 4), tAsli = numOrDefault(p.tinggi, 8), ry = r * 0.35;
    // Tinggi yang DIGAMBAR dibatasi relatif terhadap alasnya (gambar memang
    // "NOT TO SCALE"): tabung 4 x 40 yang digambar sebangun jadi batang
    // setipis jarum, tak ada tempat untuk huruf dan elips alasnya.
    const t = Math.min(tAsli, 2.6 * r);
    return {
      ellipses: [{ cx: r, cy: t, rx: r, ry }, { cx: r, cy: 0, rx: r, ry, belah: true }],
      edges: [
        { a: [0, 0], b: [0, t] }, { a: [2 * r, 0], b: [2 * r, t] },
        { a: [r, t], b: [2 * r, t], tipis: true },
      ],
      dots: [[r, t]],
      labels: [
        { pos: [2 * r, t / 2], text: `t = ${tAsli}`, n: [1, 0] },
        // Di bawah garis jari-jari, di dalam muka tutup: di atasnya bertabrakan
        // dengan tepi elips yang pipih.
        { pos: [r * 1.5, t], text: `r = ${r}`, n: [0, -1] },
      ],
      vertices: [{ pos: [r, t], name: 'O', n: [-0.7, -0.7] }],
    };
  },
  // Pipa (tabung berlubang) dilihat dari atas-depan: ujung terbuka di ATAS
  // berupa cincin (elips luar penuh + elips dalam penuh = lubangnya), badan
  // dengan dua rusuk tegak, dan alas bawah hanya setengah depan (setengah
  // belakangnya tersembunyi). R dan r ditarik pada jari-jari di muka cincin.
  pipa: (p) => {
    const rLuar = numOrDefault(p.jariLuar, 5), rDalam = numOrDefault(p.jariDalam, 3);
    const tAsli = numOrDefault(p.tinggi, 12), ry = rLuar * 0.35, ryDalam = rDalam * 0.35;
    const t = Math.min(tAsli, 2.6 * rLuar);
    return {
      ellipses: [
        { cx: rLuar, cy: t, rx: rLuar, ry },
        { cx: rLuar, cy: t, rx: rDalam, ry: ryDalam },
        { cx: rLuar, cy: 0, rx: rLuar, ry, belah: true },
      ],
      edges: [
        { a: [0, 0], b: [0, t] }, { a: [2 * rLuar, 0], b: [2 * rLuar, t] },
        { a: [rLuar, t], b: [2 * rLuar, t], tipis: true },                 // jari-jari luar R (ke kanan)
        { a: [rLuar, t], b: [rLuar - rDalam, t], tipis: true },            // jari-jari lubang r (ke kiri)
        { a: [rLuar - rDalam, t], b: [-rLuar * 0.12, t + rLuar * 0.62], tipis: true }, // penghubung miring ke label r di luar badan
      ],
      dots: [[rLuar, t]],
      labels: [
        { pos: [2 * rLuar, t / 2], text: `t = ${tAsli}`, n: [1, 0] },
        { pos: [2 * rLuar, t], text: `R = ${rLuar}`, n: [1, 0] },
        { pos: [-rLuar * 0.12, t + rLuar * 0.62], text: `r = ${rDalam}`, n: [-1, 0.2] },
      ],
    };
  },
  kerucut: (p) => {
    const r = numOrDefault(p.jari, 4), tAsli = numOrDefault(p.tinggi, 8), ry = r * 0.35;
    const t = Math.min(tAsli, 2.6 * r); // lihat catatan di tabung
    const V = [r, t], O = [r, 0];
    return {
      ellipses: [{ cx: r, cy: 0, rx: r, ry, belah: true }],
      edges: [
        { a: V, b: [0, 0] }, { a: V, b: [2 * r, 0] },
        { a: V, b: O, dashed: true }, { a: O, b: [2 * r, 0], tipis: true },
      ],
      siku: [{ v: O, a: V, b: [2 * r, 0] }],
      dots: [O],
      labels: [
        // Rendah (30% tinggi): makin ke bawah makin lebar jarak ke sisi miring.
        { pos: [r, t * 0.3], text: `t = ${tAsli}`, n: [-1, 0] },
        { pos: [r * 1.5, 0], text: `r = ${r}`, n: [0, -1] },
      ],
      vertices: [{ pos: V, name: 'V', n: [0, 1] }, { pos: O, name: 'O', n: [-0.7, -0.7] }],
    };
  },
  bola: (p) => {
    const r = numOrDefault(p.jari, 4);
    return {
      ellipses: [{ cx: 0, cy: 0, rx: r, ry: r }, { cx: 0, cy: 0, rx: r, ry: r * 0.32, belah: true }],
      edges: [{ a: [0, 0], b: [r, 0], tipis: true }],
      dots: [[0, 0]],
      labels: [{ pos: [r / 2, 0], text: `r = ${r}`, n: [0, 1] }],
      vertices: [{ pos: [0, 0], name: 'O', n: [-0.7, -0.7] }],
    };
  },
  'limas-segiempat': (p) => {
    const s = numOrDefault(p.alas, 6), tAsli = numOrDefault(p.tinggi, 8);
    const t = Math.min(tAsli, 1.6 * s); // lihat catatan di tabung
    const depth = s * 0.6;
    const A = [0, 0], B = [s, 0];
    const C = obliquePt(s, 0, depth), D = obliquePt(0, 0, depth);
    const O = [(A[0] + B[0] + C[0] + D[0]) / 4, (A[1] + B[1] + C[1] + D[1]) / 4];
    const V = [O[0], O[1] + t];
    return {
      edges: [
        { a: A, b: B }, { a: B, b: C }, { a: C, b: D, dashed: true }, { a: D, b: A, dashed: true },
        { a: A, b: V }, { a: B, b: V }, { a: C, b: V }, { a: D, b: V, dashed: true },
        { a: V, b: O, dashed: true },
      ],
      dots: [O],
      labels: [
        { pos: [s / 2, 0], text: `s = ${s}`, n: [0, -1] },
        // Rendah (22% tinggi) dan di kiri: menjauhi rusuk VB/VC yang padat;
        // yang terdekat tinggal VD putus-putus, dan halo putih menjaga keterbacaan.
        { pos: [O[0], O[1] + t * 0.22], text: `t = ${tAsli}`, n: [-1, 0] },
      ],
      vertices: [
        { pos: A, name: 'A', n: [-0.7, -0.7] }, { pos: B, name: 'B', n: [0.7, -0.7] },
        { pos: C, name: 'C', n: [1, -0.2] }, { pos: D, name: 'D', n: [-1, 0.2] },
        { pos: V, name: 'V', n: [0, 1] }, { pos: O, name: 'O', n: [-1, -0.5] },
      ],
    };
  },
  'prisma-segitiga': (p) => {
    const alas = numOrDefault(p.alas, 6), tinggi = numOrDefault(p.tinggi, 5), panjang = numOrDefault(p.panjang, 8);
    const A = [0, 0], B = [alas, 0], C = [alas / 2, tinggi], M = [alas / 2, 0];
    const D = obliquePt(0, 0, panjang), E = obliquePt(alas, 0, panjang), F = obliquePt(alas / 2, tinggi, panjang);
    return {
      edges: [
        { a: A, b: B }, { a: B, b: C }, { a: C, b: A },
        { a: D, b: E, dashed: true }, { a: E, b: F }, { a: F, b: D, dashed: true },
        { a: A, b: D, dashed: true }, { a: B, b: E }, { a: C, b: F },
        { a: C, b: M, dashed: true },
      ],
      siku: [{ v: M, a: C, b: B }],
      labels: [
        { pos: [alas / 2, 0], text: `alas = ${alas}`, n: [0, -1] },
        { pos: [alas / 2, tinggi / 2], text: `t = ${tinggi}`, n: [-1, 0] },
        { pos: [(B[0] + E[0]) / 2, (B[1] + E[1]) / 2], text: `p = ${panjang}`, n: [0.7, -0.7] },
      ],
      vertices: [
        { pos: A, name: 'A', n: [-0.7, -0.7] }, { pos: B, name: 'B', n: [0.7, -0.7] },
        { pos: C, name: 'C', n: [-0.5, 0.85] }, { pos: D, name: 'D', n: [-1, 0.2] },
        { pos: E, name: 'E', n: [1, -0.2] }, { pos: F, name: 'F', n: [0.5, 0.85] },
      ],
    };
  },
};

// PATCH EXACTSEARCH (hilang bila wsm/ disinkronkan ulang lewat perbarui-mesin.sh):
// Kolom tabel dipisah koma, tapi koma juga sah muncul DI DALAM rumus — misalnya
// "header=$x$,$y$,$(x\text{, }y)$" yang seharusnya 3 kolom. Memecah mentah
// membuatnya jadi 4 kolom dengan potongan LaTeX terbelah, dan yang tercetak
// adalah "$(x\text{" lalu "}y)$" di kolom berbeda. Jadi koma di antara sepasang
// tanda dolar tidak dihitung sebagai pemisah.
function pisahKolom(teks) {
  const keluar = [];
  let kini = '', dalamRumus = false;
  for (let i = 0; i < teks.length; i++) {
    const c = teks[i];
    if (c === '$' && teks[i - 1] !== '\\') dalamRumus = !dalamRumus;
    if (c === ',' && !dalamRumus) { keluar.push(kini); kini = ''; continue; }
    kini += c;
  }
  keluar.push(kini);
  return keluar.map((x) => x.trim()).filter(Boolean);
}

function renderSolidSVG(cfg) {
  const preset = SOLID_PRESETS[cfg.bentuk] || SOLID_PRESETS.kubus;
  const shape = preset(cfg);
  const edges = shape.edges || [];
  const ellipses = shape.ellipses || [];
  const areaW = 250, areaH = 200;

  const xs = [], ys = [];
  edges.forEach((e) => { xs.push(e.a[0], e.b[0]); ys.push(e.a[1], e.b[1]); });
  ellipses.forEach((el) => { xs.push(el.cx - el.rx, el.cx + el.rx); ys.push(el.cy - el.ry, el.cy + el.ry); });
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1e-6), spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min(areaW / spanX, areaH / spanY);
  const toPx = (x, y) => [(x - minX) * scale, areaH - (y - minY) * scale];

  const b = kotakBatas();
  let isi = '';
  // Rusuk terlihat: hitam padat. Rusuk tersembunyi: putus-putus abu-abu —
  // konvensi proyeksi bangun ruang di naskah ujian, supaya bagian belakang
  // benda tetap terbaca tanpa mengganggu bagian depan.
  const garisRusuk = (x1, y1, x2, y2, dashed, tipis) => {
    const warna = dashed ? GAYA.abu : GAYA.hitam;
    const tebal = dashed || tipis ? GAYA.garisBantu + 0.2 : GAYA.garis;
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${warna}" stroke-width="${tebal}"${dashed ? ` stroke-dasharray="${GAYA.putus}"` : ''}/>`;
  };

  ellipses.forEach((el) => {
    const [cx, cy] = toPx(el.cx, el.cy);
    const rx = el.rx * scale, ry = el.ry * scale;
    // Kotak batas elips yang sebenarnya; lingkaran berjari-jari max(rx,ry) membuat
    // elips pipih (alas tabung) memberi ruang kosong besar di atas dan bawah gambar.
    b.titik(cx - rx - 1, cy - ry - 1); b.titik(cx + rx + 1, cy + ry + 1);
    if (!el.belah) {
      isi += `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
      return;
    }
    // Alas tabung/kerucut dan khatulistiwa bola: separuh depan (bawah di
    // layar) terlihat -> padat; separuh belakang tertutup benda -> putus-putus.
    const kiri = `${(cx - rx).toFixed(1)} ${cy.toFixed(1)}`, kanan = `${(cx + rx).toFixed(1)} ${cy.toFixed(1)}`;
    isi += `<path d="M${kiri} A${rx.toFixed(1)} ${ry.toFixed(1)} 0 0 0 ${kanan}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    isi += `<path d="M${kiri} A${rx.toFixed(1)} ${ry.toFixed(1)} 0 0 1 ${kanan}" fill="none" stroke="${GAYA.abu}" stroke-width="${GAYA.garisBantu + 0.2}" stroke-dasharray="${GAYA.putus}"/>`;
  });
  edges.forEach((e) => {
    const [x1, y1] = toPx(e.a[0], e.a[1]), [x2, y2] = toPx(e.b[0], e.b[1]);
    b.titik(x1, y1, 1); b.titik(x2, y2, 1);
    isi += garisRusuk(x1, y1, x2, y2, e.dashed, e.tipis);
  });
  (shape.siku || []).forEach((s) => {
    const v = toPx(s.v[0], s.v[1]), a = toPx(s.a[0], s.a[1]), c = toPx(s.b[0], s.b[1]);
    isi += rightAngleSVG(v[0], v[1], a[0], a[1], c[0], c[1], 8);
  });
  (shape.dots || []).forEach((d) => {
    const [x, y] = toPx(d[0], d[1]);
    isi += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.2" fill="${GAYA.hitam}"/>`;
  });
  // n di preset memakai y ke atas; di layar y ke bawah, jadi ny dibalik.
  (shape.labels || []).forEach((l) => {
    const [x, y] = toPx(l.pos[0], l.pos[1]);
    const pos = letakTeksLuar(x, y, l.n[0], -l.n[1], 8);
    isi += teksGeoSVG(pos, l.text, GAYA.teks, false, true);
    b.teks(pos.x, pos.y, l.text, GAYA.teks, pos.anchor);
  });
  (shape.vertices || []).forEach((v) => {
    const [x, y] = toPx(v.pos[0], v.pos[1]);
    const pos = letakTeksLuar(x, y, v.n[0], -v.n[1], 7, 12.5);
    isi += teksGeoSVG(pos, v.name, 12.5, true);
    b.teks(pos.x, pos.y, v.name, 12.5, pos.anchor);
  });

  return bungkusGambarSVG(isi, b, (shape.labels || []).length > 0);
}

// ---------------------------------------------------------------------
// 2d. Diagram Sudut (polygon dengan busur sudut, garis sejajar + transversal)
// ---------------------------------------------------------------------

function parseLabelMap(raw) {
  const map = {};
  String(raw || '').split(',').forEach((pair) => {
    const idx = pair.indexOf(':');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) map[k] = v;
  });
  return map;
}

function renderPolygonAngleSVG(cfg) {
  const n = Math.max(3, Math.round(numOrDefault(cfg.sisi, 4)));
  const labelMap = parseLabelMap(cfg.label);
  const adaLabel = Object.keys(labelMap).length > 0;
  const R = 95;
  const letters = 'ABCDEFGHIJ';
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pts.push({ name: letters[i] || 'P' + i, x: R * Math.cos(a), y: R * Math.sin(a) });
  }

  const b = kotakBatas();
  let isi = '';
  const poly = pts.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
  isi += `<polygon points="${poly}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}" stroke-linejoin="round"/>`;
  pts.forEach((p) => b.titik(p.x, p.y, 1));

  // Busur sudut hanya di sudut yang diberi nilai/huruf (seperti naskah ujian:
  // busur = sudut yang dibicarakan). Tanpa label sama sekali, semua sudut
  // diberi busur supaya diagram tetap berguna sebagai gambar rujukan.
  pts.forEach((p, i) => {
    const val = labelMap[p.name];
    if (adaLabel && !val) return;
    const prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
    const teks = val ? `${val}°` : '';
    isi += angleArcSVG(p.x, p.y, prev.x, prev.y, next.x, next.y, 18, teks);
    if (teks) {
      // Taksiran letak label (di garis bagi sudut, jarak 31) untuk kotak batas.
      const a1 = Math.atan2(prev.y - p.y, prev.x - p.x), a2 = Math.atan2(next.y - p.y, next.x - p.x);
      let d = a2 - a1; while (d <= -Math.PI) d += 2 * Math.PI; while (d > Math.PI) d -= 2 * Math.PI;
      const mid = a1 + d / 2;
      b.teks(p.x + 31 * Math.cos(mid), p.y + 31 * Math.sin(mid) + 3.5, teks, 11, 'middle');
    }
  });

  pts.forEach((p) => {
    const len = Math.hypot(p.x, p.y) || 1;
    const pos = letakTeksLuar(p.x, p.y, p.x / len, p.y / len, 7, 12.5);
    isi += teksGeoSVG(pos, p.name, 12.5, true);
    b.teks(pos.x, pos.y, p.name, 12.5, pos.anchor);
  });

  return bungkusGambarSVG(isi, b, adaLabel);
}

function renderParallelLinesSVG(cfg) {
  const y1 = 0, y2 = 90, x0 = 0, x1 = 300;
  const midX1 = 110, midX2 = 190;
  const labelMap = parseLabelMap(cfg.label);
  const adaLabel = Object.keys(labelMap).length > 0;

  const b = kotakBatas();
  let isi = '';
  const garis = (ax, ay, bx, by) => `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  isi += garis(x0, y1, x1, y1) + garis(x0, y2, x1, y2);
  b.titik(x0, y1); b.titik(x1, y2);
  // Sepasang mata panah tunggal ">" = kedua garis sejajar (konvensi Cambridge).
  [y1, y2].forEach((y) => { isi += panahSejajarSVG(x1 - 60, y, x1 - 40, y, 1); });

  const dx = midX2 - midX1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len, ext = 42;
  const tx1 = midX1 - ux * ext, ty1 = y1 - uy * ext, tx2 = midX2 + ux * ext, ty2 = y2 + uy * ext;
  isi += garis(tx1, ty1, tx2, ty2);
  b.titik(tx1, ty1); b.titik(tx2, ty2);

  // Delapan daerah sudut: 1-4 di perpotongan atas, 5-8 di bawah, urut searah
  // jarum jam dari kiri-atas. Tiap daerah dibatasi dua sinar dari titik
  // potong: kiri/kanan sepanjang garis sejajar, atas/bawah sepanjang transversal.
  const L = [-1, 0], Rr = [1, 0], U = [-ux, -uy], D = [ux, uy];
  const daerah = {
    1: [midX1, y1, L, U], 2: [midX1, y1, U, Rr], 3: [midX1, y1, Rr, D], 4: [midX1, y1, D, L],
    5: [midX2, y2, L, U], 6: [midX2, y2, U, Rr], 7: [midX2, y2, Rr, D], 8: [midX2, y2, D, L],
  };
  Object.keys(daerah).forEach((k) => {
    const [vx, vy, ra, rb] = daerah[k];
    const val = labelMap[k];
    // Ada label: busur + nilai hanya di daerah yang dilabeli. Tanpa label:
    // nomor daerah 1-8 saja (gambar rujukan) supaya soal bisa menyebut
    // "sudut 3" tanpa busur yang mengesankan semua sudut ditanyakan.
    if (adaLabel && !val) return;
    const teks = val ? `${val}°` : String(k);
    const a1 = Math.atan2(ra[1], ra[0]);
    let d = Math.atan2(rb[1], rb[0]) - a1; while (d <= -Math.PI) d += 2 * Math.PI; while (d > Math.PI) d -= 2 * Math.PI;
    const mid = a1 + d / 2;
    if (val) {
      isi += angleArcSVG(vx, vy, vx + ra[0] * 30, vy + ra[1] * 30, vx + rb[0] * 30, vy + rb[1] * 30, 16, teks);
      b.teks(vx + 29 * Math.cos(mid), vy + 29 * Math.sin(mid) + 3.5, teks, 11, 'middle');
    } else {
      const lx = vx + 22 * Math.cos(mid), ly = vy + 22 * Math.sin(mid) + 3.5;
      isi += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="${GAYA.teksKecil}" text-anchor="middle" fill="${GAYA.hitam}">${teks}</text>`;
      b.teks(lx, ly, teks, GAYA.teksKecil, 'middle');
    }
  });

  return bungkusGambarSVG(isi, b, adaLabel);
}

// ---------------------------------------------------------------------
// Kimia partikel: model partikel dalam kotak, diagram molekul berarsir,
// tabel periodik (gaya naskah Cambridge/IGCSE)
// ---------------------------------------------------------------------

// Jenis atom a-e dibedakan lewat ISIAN, bukan warna (tetap terbaca saat
// difotokopi hitam-putih): a putih, b abu-abu, c hitam, d garis tegak, e titik.
// Pola isian dimuat hanya bila dipakai atom di gambar itu.
function defsAtom(badan) {
  const g = badan.indexOf('wsAtomGaris') > -1, t = badan.indexOf('wsAtomTitik') > -1;
  if (!g && !t) return '';
  return '<defs>'
    + (g ? `<pattern id="wsAtomGaris" width="3.2" height="3.2" patternUnits="userSpaceOnUse"><rect width="3.2" height="3.2" fill="#ffffff"/><line x1="1.6" y1="0" x2="1.6" y2="3.2" stroke="#000000" stroke-width="1.4"/></pattern>` : '')
    + (t ? `<pattern id="wsAtomTitik" width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#ffffff"/><circle cx="2.5" cy="2.5" r="1.1" fill="#000000"/></pattern>` : '')
    + '</defs>';
}
const ISIAN_ATOM = { a: '#ffffff', b: '#c4c4c4', c: '#111111', d: 'url(#wsAtomGaris)', e: 'url(#wsAtomTitik)' };

function atomBulatSVG(x, y, r, jenis) {
  const isi = ISIAN_ATOM[jenis] || ISIAN_ATOM.a;
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${isi}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
}

// Pengacak deterministik: gambar yang sama untuk teks yang sama, di layar maupun cetak.
function acakTetap(seed) {
  let h = 2166136261;
  String(seed).split('').forEach((c) => { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); });
  return function () {
    h += 0x6D2B79F5; let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// "aa:3,ab:2,a:4" -> [{ huruf:'aa', n:3 }, ...]
function parseIsiPartikel(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).map((tok) => {
    const bits = tok.split(':');
    return { huruf: (bits[0] || '').toLowerCase().replace(/[^a-e]/g, ''), n: Math.max(1, Math.min(40, parseInt(bits[1], 10) || 1)) };
  }).filter((m) => m.huruf);
}

// Posisi atom satu molekul (pusat di 0,0), jarak antar atom d = 2r (bersentuhan).
// Tiga huruf: kalau huruf pertama = ketiga, linear dengan huruf tengah di pusat
// (bab = CO2); selain itu huruf pertama di pusat dan dua lainnya menekuk (abb = air).
function susunMolekul(huruf, r) {
  const d = 2 * r, n = huruf.length;
  if (n === 1) return [{ j: huruf[0], x: 0, y: 0 }];
  if (n === 2) return [{ j: huruf[0], x: -r, y: 0 }, { j: huruf[1], x: r, y: 0 }];
  if (n === 3 && huruf[0] === huruf[2]) return [{ j: huruf[0], x: -d, y: 0 }, { j: huruf[1], x: 0, y: 0 }, { j: huruf[2], x: d, y: 0 }];
  if (n === 3) {
    const a = (52 * Math.PI) / 180;
    return [{ j: huruf[0], x: -d * 0.35, y: 0 }, { j: huruf[1], x: d * Math.cos(a) - d * 0.35, y: -d * Math.sin(a) }, { j: huruf[2], x: d * Math.cos(a) - d * 0.35, y: d * Math.sin(a) }];
  }
  const out = [{ j: huruf[0], x: 0, y: 0 }];
  for (let i = 1; i < n; i++) { const a = (2 * Math.PI * (i - 1)) / (n - 1); out.push({ j: huruf[i], x: d * Math.cos(a), y: d * Math.sin(a) }); }
  return out;
}

// Model partikel dalam kotak: gas/cairan (molekul tersebar), padatan (kisi rapat
// di dasar kotak), atau kotak kosong untuk digambar murid. bentuk=huruf menggambar
// molekul sebagai rumus garis (C—O, O—C—O) dengan unsur=a:C,b:O.
function kotakPartikel(cfg) {
  const ukuran = String(cfg.kotak || '150x120').split(/[x×]/).map((v) => parseFloat(v));
  const W = ukuran[0] > 30 ? ukuran[0] : 150, H = ukuran[1] > 30 ? ukuran[1] : 120;
  const isi = parseIsiPartikel(cfg.isi);
  const padat = String(cfg.padat || '').split(':');
  const polaPadat = (padat[0] || '').toLowerCase().replace(/[^a-e]/g, '');
  const hurufMode = /^huruf|stick|rumus/i.test(String(cfg.bentuk || ''));
  const unsur = parseLabelMap(cfg.unsur);
  const pakai = {};
  const b = kotakBatas();
  let badan = '';

  badan += `<rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
  b.titik(0, 0); b.titik(W, H);

  if (polaPadat) {
    const baris = Math.max(1, Math.min(12, parseInt(padat[1], 10) || 4)), r = 9.5;
    const kolom = Math.floor((W - 6) / (2 * r));
    const x0 = (W - kolom * 2 * r) / 2 + r;
    for (let br = 0; br < baris; br++) {
      const y = H - 4 - r - br * r * Math.sqrt(3);
      const geser = br % 2 ? r : 0;
      for (let k = 0; k < kolom; k++) {
        const x = x0 + k * 2 * r + geser;
        if (x + r > W - 2) continue;
        const j = polaPadat[(k + br) % polaPadat.length];
        pakai[j] = true;
        badan += atomBulatSVG(x, y, r, j);
      }
    }
  } else if (cfg.cair) {
    // Cairan: partikel RAPAT (bersentuhan) tetapi TIDAK teratur, hanya mengisi bagian bawah kotak,
    // dengan beberapa celah kecil dan susunan yang berubah-ubah (beda dari kisi padat).
    // cair=a (isi otomatis seluas ~55% kotak) atau cair=a:12,b:6 / cair=abb:8 (jumlah tertentu).
    const mentah = String(cfg.cair);
    const acak = acakTetap('cair' + mentah);
    const rSel = 9.5;
    const kol = Math.max(2, Math.floor((W - 8) / (2.15 * rSel)));
    let daftar = [];
    if (/:/.test(mentah)) parseIsiPartikel(mentah).forEach((m) => { for (let i = 0; i < m.n; i++) daftar.push(m.huruf); });
    else {
      const jenisCair = mentah.toLowerCase().replace(/[^a-e]/g, '') || 'a';
      const barisOtomatis = Math.max(2, Math.round((0.55 * H) / (1.78 * rSel)));
      const n = Math.round(kol * barisOtomatis * 0.92);
      for (let i = 0; i < n; i++) daftar.push(jenisCair[i % jenisCair.length]);
    }
    for (let i = daftar.length - 1; i > 0; i--) { const j = Math.floor(acak() * (i + 1)); const t = daftar[i]; daftar[i] = daftar[j]; daftar[j] = t; }
    const banyakAtom = daftar.some((hrf) => hrf.length > 1);
    // Penumpukan acak: tiap partikel dijatuhkan di x acak dan berhenti saat menyentuh dasar atau
    // partikel lain (dari 5 percobaan dipilih yang paling rendah). Hasilnya rapat dan bersentuhan,
    // tetapi tanpa baris dan tanpa pola, seperti cairan; tidak ada yang tumpang tindih.
    const rc = rSel * 0.95, lantai = H - 3 - rc, ada = [];
    daftar.forEach((huruf) => {
      let terbaik = null;
      for (let p = 0; p < 5; p++) {
        const x = rc + 3 + acak() * (W - 2 * rc - 6);
        let y = lantai;
        ada.forEach((e) => { const dx = Math.abs(x - e.x); if (dx < 2 * rc) y = Math.min(y, e.y - Math.sqrt(4 * rc * rc - dx * dx)); });
        if (!terbaik || y > terbaik.y) terbaik = { x, y };
      }
      if (terbaik.y < rc + 3) return;                                         // kotak penuh
      ada.push(terbaik);
      if (huruf.length === 1) { pakai[huruf] = true; badan += atomBulatSVG(terbaik.x, terbaik.y, rc, huruf); return; }
      const sudut = acak() * Math.PI * 2, c = Math.cos(sudut), sn = Math.sin(sudut);
      susunMolekul(huruf, rSel * (banyakAtom ? 0.42 : 0.5)).forEach((a) => { pakai[a.j] = true; badan += atomBulatSVG(terbaik.x + a.x * c - a.y * sn, terbaik.y + a.x * sn + a.y * c, rSel * 0.42, a.j); });
    });
  } else if (isi.length) {
    const daftar = [];
    isi.forEach((m) => { for (let i = 0; i < m.n; i++) daftar.push(m.huruf); });
    const acak = acakTetap(String(cfg.isi));
    // urutan sel diacak supaya jenis berbeda bercampur, bukan berkelompok
    const n = daftar.length, kolom = Math.max(1, Math.ceil(Math.sqrt((n * W) / H))), baris = Math.ceil(n / kolom);
    const cw = W / kolom, ch = H / baris;
    const sel = []; for (let i = 0; i < kolom * baris; i++) sel.push(i);
    for (let i = sel.length - 1; i > 0; i--) { const j = Math.floor(acak() * (i + 1)); const t = sel[i]; sel[i] = sel[j]; sel[j] = t; }
    const r = Math.max(5, Math.min(9.5, 0.27 * Math.min(cw, ch)));
    daftar.forEach((huruf, i) => {
      const s = sel[i], cx = (s % kolom + 0.5) * cw + (acak() - 0.5) * cw * 0.22, cy = (Math.floor(s / kolom) + 0.5) * ch + (acak() - 0.5) * ch * 0.22;
      const sudut = acak() * Math.PI * 2, c = Math.cos(sudut), sn = Math.sin(sudut);
      const atom = susunMolekul(huruf, hurufMode ? 8.5 : r).map((a) => ({ j: a.j, x: cx + a.x * c - a.y * sn, y: cy + a.x * sn + a.y * c }));
      if (hurufMode) {
        for (let u = 1; u < atom.length; u++) {
          const p = hurufMode && atom.length === 3 && huruf[0] !== huruf[2] ? atom[0] : atom[u - 1], q = atom[u];
          const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1, g = 6.5;
          badan += `<line x1="${(p.x + dx / L * g).toFixed(1)}" y1="${(p.y + dy / L * g).toFixed(1)}" x2="${(q.x - dx / L * g).toFixed(1)}" y2="${(q.y - dy / L * g).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.1"/>`;
        }
        atom.forEach((a) => { pakai[a.j] = true; badan += `<text x="${a.x.toFixed(1)}" y="${(a.y + 4).toFixed(1)}" text-anchor="middle" font-size="12" fill="${GAYA.hitam}">${escText(unsur[a.j] || a.j.toUpperCase())}</text>`; });
      } else {
        atom.forEach((a) => { pakai[a.j] = true; badan += atomBulatSVG(a.x, a.y, r, a.j); });
      }
    });
  }

  if (cfg.label) {
    badan += `<text x="${W / 2}" y="${H + 17}" text-anchor="middle" font-size="${GAYA.teks}" font-weight="700" fill="${GAYA.hitam}">${escText(cfg.label)}</text>`;
    b.titik(W / 2, H + 22);
  }
  return { badan, W, H, pakai, b, hurufMode };
}

// Satu atau banyak kotak. panel=isi=bb:4 // padat=cb:5 // (kosong) menggambar
// kotak berkisi (kolom=3), otomatis berlabel A, B, C...; legenda=ya menampilkan
// contoh tiap jenis atom di atasnya.
function renderPartikelSVG(cfg) {
  const panelRaw = cfg.panel != null ? String(cfg.panel).split('//').map((x) => x.trim()) : null;
  const b = kotakBatas();
  let badan = '';
  const pakaiSemua = {};
  let hurufMode = false;
  if (!panelRaw) {
    const k = kotakPartikel(cfg);
    badan += k.badan; Object.assign(pakaiSemua, k.pakai); hurufMode = k.hurufMode;
    b.titik(k.b.x0, k.b.y0); b.titik(k.b.x1, k.b.y1);
    var lebarTotal = k.W;
  } else {
    const kol = Math.max(1, Math.min(6, parseInt(cfg.kolom, 10) || 3)), gap = 16;
    const dasar = Object.assign({}, cfg); delete dasar.panel; delete dasar.isi; delete dasar.padat; delete dasar.cair; delete dasar.label; delete dasar.legenda;
    const huruf = String(cfg.huruf || 'ya').toLowerCase() !== 'tidak';
    let W0 = 0, H0 = 0;
    const panels = panelRaw.map((spec, idx) => {
      const eq = spec.indexOf('=');
      const sub = Object.assign({}, dasar);
      if (eq > 0) sub[spec.slice(0, eq).trim()] = spec.slice(eq + 1).trim();
      if (huruf) sub.label = String.fromCharCode(65 + idx);
      return kotakPartikel(sub);
    });
    panels.forEach((k) => { W0 = Math.max(W0, k.W); H0 = Math.max(H0, k.H); });
    panels.forEach((k, idx) => {
      const ox = (idx % kol) * (W0 + gap), oy = Math.floor(idx / kol) * (H0 + 30 + gap);
      badan += `<g transform="translate(${ox},${oy})">${k.badan}</g>`;
      b.titik(ox + k.b.x0, oy + k.b.y0); b.titik(ox + k.b.x1, oy + k.b.y1);
      Object.assign(pakaiSemua, k.pakai); hurufMode = hurufMode || k.hurufMode;
    });
    var lebarTotal = Math.min(kol, panels.length) * W0 + (Math.min(kol, panels.length) - 1) * gap;
  }
  if (/^(ya|true|1)$/i.test(String(cfg.legenda || '')) && !hurufMode) {
    const jenis = Object.keys(pakaiSemua).sort();
    const x0 = lebarTotal / 2 - ((jenis.length - 1) * 26) / 2;
    jenis.forEach((j, i) => { badan += atomBulatSVG(x0 + i * 26, -14, 8, j); });
    b.titik(0, -24);
  }
  return bungkusGambarSVG(defsAtom(badan) + badan, b, false);
}

// Diagram molekul gaya buku (lingkaran saling tumpang tindih, tiap unsur berarsir
// beda, huruf unsur di luar atom, nama di bawah): rumus=H2O atau NH3,NO.
const MOLEKUL_PRESET = {
  NO: [['N', -18, 0], ['O', 18, 0]],
  H2O: [['H', -27, 0], ['O', 0, 0], ['H', 27, 0]],
  NH3: [['N', 0, 0], ['H', -27, 6], ['H', 27, 6], ['H', 0, 28]],
  N2H4: [['N', -17, 0], ['N', 17, 0], ['H', -32, -22], ['H', -32, 22], ['H', 32, -22], ['H', 32, 22]],
  NO2: [['N', 16, 0], ['O', -6, -25], ['O', -6, 25]],
  CO2: [['O', -36, 0], ['C', 0, 0], ['O', 36, 0]],
  CO: [['C', -18, 0], ['O', 18, 0]],
  CH4: [['C', 0, 0], ['H', -27, 0], ['H', 27, 0], ['H', 0, -27], ['H', 0, 27]],
  CCl4: [['C', 0, 0], ['Cl', -34, 0], ['Cl', 34, 0], ['Cl', 0, -34], ['Cl', 0, 34]],
  HCl: [['Cl', -14, 0], ['H', 20, 0]],
  H2: [['H', -11, 0], ['H', 11, 0]],
  O2: [['O', -18, 0], ['O', 18, 0]],
  N2: [['N', -18, 0], ['N', 18, 0]],
  SO2: [['O', -25, -22], ['S', 0, 0], ['O', 25, -22]],
  H2S: [['H', -27, 0], ['S', 0, 0], ['H', 27, 0]],
  H2O2: [['O', -17, 6], ['O', 17, 6], ['H', -33, -15], ['H', 33, -15]],
  O3: [['O', -22, 14], ['O', 0, -8], ['O', 22, 14]],
  SO3: [['S', 0, 0], ['O', 0, -34], ['O', -30, 18], ['O', 30, 18]],
  C2H2: [['H', -50, 0], ['C', -18, 0], ['C', 18, 0], ['H', 50, 0]],
  N2O: [['N', -36, 0], ['N', 0, 0], ['O', 36, 0]],
  PH3: [['P', 0, 0], ['H', -27, 6], ['H', 27, 6], ['H', 0, 28]],
  HF: [['F', -12, 0], ['H', 20, 0]],
  HBr: [['Br', -14, 0], ['H', 22, 0]],
  F2: [['F', -18, 0], ['F', 18, 0]],
  Cl2: [['Cl', -20, 0], ['Cl', 20, 0]],
  Br2: [['Br', -20, 0], ['Br', 20, 0]],
};
const JARI_UNSUR = { H: 11, Cl: 20, Br: 22, F: 15, P: 20 };
const ARSIR_UNSUR = { H: 'd', N: 'e', O: 'a', C: 'c', Cl: 'b', S: 'b' };

function renderDiagramMolekulSVG(cfg) {
  const rumus = String(cfg.rumus || 'H2O').split(',').map((s) => s.trim().replace(/[₀-₉]/g, (c) => String(c.charCodeAt(0) - 8320))).filter(Boolean);
  const arsir = Object.assign({}, ARSIR_UNSUR, parseLabelMap(cfg.arsir));
  const tampilHuruf = String(cfg.label || 'ya').toLowerCase() !== 'tidak';
  const b = kotakBatas();
  let badan = '', xKiri = 0;
  const sub = (f) => f.replace(/(\d+)/g, (d) => d.split('').map((c) => SUBSKRIP[c]).join(''));
  const judul = cfg.judul != null ? String(cfg.judul).split(',').map((s) => s.trim()) : null;

  rumus.forEach((f, idx) => {
    const atom = MOLEKUL_PRESET[f.toUpperCase()] || MOLEKUL_PRESET[f];
    if (!atom) throw new Error('rumus "' + f + '" belum tersedia di diagrammolekul (ada: ' + Object.keys(MOLEKUL_PRESET).join(', ') + ')');
    const pusat = atom.reduce((s, a) => [s[0] + a[1] / atom.length, s[1] + a[2] / atom.length], [0, 0]);
    const minX = Math.min(...atom.map((a) => a[1] - (JARI_UNSUR[a[0]] || 18))), maxX = Math.max(...atom.map((a) => a[1] + (JARI_UNSUR[a[0]] || 18)));
    const lebar = maxX - minX + 56, ox = xKiri + 28 - minX, oy = 44;
    // atom besar dulu, atom kecil (H) di atasnya
    atom.slice().sort((p, q) => (JARI_UNSUR[q[0]] || 18) - (JARI_UNSUR[p[0]] || 18)).forEach((a) => {
      const r = JARI_UNSUR[a[0]] || 18;
      badan += atomBulatSVG(ox + a[1], oy + a[2], r, arsir[a[0]] || 'b');
      b.titik(ox + a[1] - r, oy + a[2] - r); b.titik(ox + a[1] + r, oy + a[2] + r);
    });
    if (tampilHuruf) atom.forEach((a) => {
      const r = JARI_UNSUR[a[0]] || 18;
      let dx = a[1] - pusat[0], dy = a[2] - pusat[1], L = Math.hypot(dx, dy);
      if (L < 4) { dx = 0; dy = 1; L = 1; }
      const pos = letakTeksLuar(ox + a[1], oy + a[2], dx / L, dy / L, r + 8, 11);
      badan += teksGeoSVG(pos, a[0], 11, true, true);
      b.teks(pos.x, pos.y, a[0], 11, pos.anchor);
    });
    const nama = judul ? judul[idx] : null;
    if (nama) {
      badan += `<text x="${(xKiri + lebar / 2).toFixed(1)}" y="${(oy + 52).toFixed(1)}" text-anchor="middle" font-size="${GAYA.teks}" font-weight="700" fill="${GAYA.hitam}">${escText(sub(nama))}</text>`;
      b.teks(xKiri + lebar / 2, oy + 52, sub(nama), GAYA.teks, 'middle');
    }
    xKiri += lebar;
  });
  if (/^(ya|true|1)$/i.test(String(cfg.kotak || ''))) {
    const w = Math.max(xKiri + 10, 120), h = 110;
    badan = `<rect x="0" y="0" width="${w}" height="${h}" fill="none" stroke="${GAYA.hitam}" stroke-width="1.4"/>` + `<g transform="translate(${((w - xKiri) / 2).toFixed(1)},${(h / 2 - 44).toFixed(1)})">${badan}</g>`;
    b.titik(0, 0); b.titik(w, h);
  }
  return bungkusGambarSVG(defsAtom(badan) + badan, b, false);
}

const DATA_UNSUR = 'H hydrogen 1;He helium 4;Li lithium 7;Be beryllium 9;B boron 11;C carbon 12;N nitrogen 14;O oxygen 16;F fluorine 19;Ne neon 20;'
  + 'Na sodium 23;Mg magnesium 24;Al aluminium 27;Si silicon 28;P phosphorus 31;S sulfur 32;Cl chlorine 35.5;Ar argon 40;K potassium 39;Ca calcium 40;'
  + 'Sc scandium 45;Ti titanium 48;V vanadium 51;Cr chromium 52;Mn manganese 55;Fe iron 56;Co cobalt 59;Ni nickel 59;Cu copper 64;Zn zinc 65;'
  + 'Ga gallium 70;Ge germanium 73;As arsenic 75;Se selenium 79;Br bromine 80;Kr krypton 84;Rb rubidium 85;Sr strontium 88;Y yttrium 89;Zr zirconium 91;'
  + 'Nb niobium 93;Mo molybdenum 96;Tc technetium -;Ru ruthenium 101;Rh rhodium 103;Pd palladium 106;Ag silver 108;Cd cadmium 112;In indium 115;Sn tin 119;'
  + 'Sb antimony 122;Te tellurium 128;I iodine 127;Xe xenon 131;Cs caesium 133;Ba barium 137;La lanthanum 139;Ce cerium 140;Pr praseodymium 141;Nd neodymium 144;'
  + 'Pm promethium -;Sm samarium 150;Eu europium 152;Gd gadolinium 157;Tb terbium 159;Dy dysprosium 163;Ho holmium 165;Er erbium 167;Tm thulium 169;Yb ytterbium 173;'
  + 'Lu lutetium 175;Hf hafnium 178;Ta tantalum 181;W tungsten 184;Re rhenium 186;Os osmium 190;Ir iridium 192;Pt platinum 195;Au gold 197;Hg mercury 201;'
  + 'Tl thallium 204;Pb lead 207;Bi bismuth 209;Po polonium -;At astatine -;Rn radon -;Fr francium -;Ra radium -;Ac actinium -;Th thorium 232;'
  + 'Pa protactinium 231;U uranium 238;Np neptunium -;Pu plutonium -;Am americium -;Cm curium -;Bk berkelium -;Cf californium -;Es einsteinium -;Fm fermium -;'
  + 'Md mendelevium -;No nobelium -;Lr lawrencium -;Rf rutherfordium -;Db dubnium -;Sg seaborgium -;Bh bohrium -;Hs hassium -;Mt meitnerium -;Ds darmstadtium -;'
  + 'Rg roentgenium -;Cn copernicium -;Nh nihonium -;Fl flerovium -;Mc moscovium -;Lv livermorium -;Ts tennessine -;Og oganesson -';

// Tabel periodik 18 kolom: golongan I-VIII di atas, lantanoid/aktinoid terpisah di
// bawah. sorot=Na,Cl menggelapkan kotak unsur tertentu; nama=tidak / massa=tidak
// menyembunyikan teks kecilnya.
function renderPeriodicTableSVG(cfg) {
  const unsur = DATA_UNSUR.split(';').map((s, i) => { const [sim, nama, massa] = s.split(' '); return { z: i + 1, sim, nama, massa }; });
  const per = {}; unsur.forEach((u) => { per[u.sim] = u; });
  const sorot = String(cfg.sorot || '').split(',').map((s) => s.trim()).filter(Boolean);
  const tampilNama = String(cfg.nama || 'ya').toLowerCase() !== 'tidak', tampilMassa = String(cfg.massa || 'ya').toLowerCase() !== 'tidak';
  const baris = [
    ['H', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'He'],
    ['Li', 'Be', null, null, null, null, null, null, null, null, null, null, 'B', 'C', 'N', 'O', 'F', 'Ne'],
    ['Na', 'Mg', null, null, null, null, null, null, null, null, null, null, 'Al', 'Si', 'P', 'S', 'Cl', 'Ar'],
    'K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr'.split(' '),
    'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe'.split(' '),
    ['Cs', 'Ba', '57–71'].concat('Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn'.split(' ')),
    ['Fr', 'Ra', '89–103'].concat('Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ')),
  ];
  const lantanoid = 'La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu'.split(' '), aktinoid = 'Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr'.split(' ');
  const cw = 31, ch = 38, x0 = 6, yGol = 14, y0 = 24, ykelompok = y0 + 7 * ch + 14;
  let badan = '';
  const sel = (x, y, u) => {
    let s = `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" fill="${sorot.indexOf(u.sim) > -1 ? '#d4d4d4' : '#ffffff'}" stroke="${GAYA.hitam}" stroke-width="0.7"/>`;
    s += `<text x="${x + 2}" y="${y + 7.5}" font-size="5.6" fill="${GAYA.hitam}">${u.z}</text>`;
    s += `<text x="${x + cw / 2}" y="${y + 19}" text-anchor="middle" font-size="12.5" fill="${GAYA.hitam}">${escText(u.sim)}</text>`;
    if (tampilNama) s += `<text x="${x + cw / 2}" y="${y + 27}" text-anchor="middle" font-size="${u.nama.length > 9 ? 4.3 : 5}" fill="${GAYA.hitam}">${escText(u.nama)}</text>`;
    if (tampilMassa) s += `<text x="${x + cw / 2}" y="${y + 34}" text-anchor="middle" font-size="5.8" fill="${GAYA.hitam}">${escText(u.massa)}</text>`;
    return s;
  };
  ['I', 'II', '', '', '', '', '', '', '', '', '', '', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'].forEach((g, i) => {
    if (g) badan += `<text x="${x0 + i * cw + cw / 2}" y="${yGol}" text-anchor="middle" font-size="9" font-weight="700" fill="${GAYA.hitam}">${g}</text>`;
  });
  baris.forEach((r, ri) => r.forEach((s, ci) => {
    if (!s) return;
    const x = x0 + ci * cw, y = y0 + ri * ch;
    if (per[s]) badan += sel(x, y, per[s]);
    else badan += `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" fill="#ffffff" stroke="${GAYA.hitam}" stroke-width="0.7"/><text x="${x + cw / 2}" y="${y + 17}" text-anchor="middle" font-size="6.2" fill="${GAYA.hitam}">${s}</text><text x="${x + cw / 2}" y="${y + 27}" text-anchor="middle" font-size="5" fill="${GAYA.hitam}">${s[0] === '5' ? 'lanthanoids' : 'actinoids'}</text>`;
  }));
  [lantanoid, aktinoid].forEach((r, ri) => r.forEach((s, ci) => { badan += sel(x0 + (ci + 3) * cw, ykelompok + ri * ch, per[s]); }));
  badan += `<text x="${x0 + 2 * cw}" y="${ykelompok + ch / 2 + 4}" text-anchor="end" font-size="8.5" font-weight="700" fill="${GAYA.hitam}">lanthanoids</text>`;
  badan += `<text x="${x0 + 2 * cw}" y="${ykelompok + ch * 1.5 + 4}" text-anchor="end" font-size="8.5" font-weight="700" fill="${GAYA.hitam}">actinoids</text>`;
  if (String(cfg.kunci || 'ya').toLowerCase() !== 'tidak') {
    badan += `<rect x="${x0 + 3 * cw}" y="${y0 + 2}" width="${4.2 * cw}" height="${2.1 * ch}" fill="none" stroke="${GAYA.hitam}" stroke-width="0.8"/>`
      + `<text x="${x0 + 3 * cw + 6}" y="${y0 + 12}" font-size="8" font-weight="700" fill="${GAYA.hitam}">Key</text>`
      + `<text x="${x0 + 5.1 * cw}" y="${y0 + 26}" text-anchor="middle" font-size="5.4" fill="${GAYA.hitam}">atomic number</text>`
      + `<text x="${x0 + 5.1 * cw}" y="${y0 + 42}" text-anchor="middle" font-size="14" font-weight="700" fill="${GAYA.hitam}">atomic symbol</text>`
      + `<text x="${x0 + 5.1 * cw}" y="${y0 + 52}" text-anchor="middle" font-size="5.4" fill="${GAYA.hitam}">name</text>`
      + `<text x="${x0 + 5.1 * cw}" y="${y0 + 60}" text-anchor="middle" font-size="5.4" fill="${GAYA.hitam}">relative atomic mass</text>`;
  }
  const W = x0 * 2 + 18 * cw, H = ykelompok + 2 * ch + 8;
  return `<svg class="ws-diagram-svg" style="max-width:100%" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${badan}</svg>`;
}

// ---------------------------------------------------------------------
// Alat ukur: jangka sorong (nonius) dan mikrometer sekrup
// ---------------------------------------------------------------------

// Angka dari teks bersatuan: "24,35 mm" -> 24.35; "2,435 cm" -> 24.35 (mm).
function angkaMm(t, def) {
  const x = String(t == null ? '' : t).trim();
  const v = parseFloat(x.replace(',', '.'));
  if (!isFinite(v)) return def;
  return /cm/i.test(x) ? v * 10 : v;
}

// Pembagian bacaan jangka sorong R (mm) dengan ketelitian ket (mm): skala utama
// M (mm penuh), N pembagian nonius, dan garis nonius ke-n yang berimpit.
function bacaanJangka(R, ket) {
  const N = Math.max(2, Math.round(1 / ket));
  const bulat = Math.round(R / ket) * ket;
  const utama = Math.floor(bulat + 1e-9);
  const n = Math.round((bulat - utama) / ket);
  return { utama, N, n, nilai: utama + n * ket };
}

// Bacaan mikrometer sekrup R (mm), ketelitian 0,01 mm: skala utama S (kelipatan
// 0,5 mm) dan garis selubung T (0-49) yang sejajar garis acuan.
function bacaanMikrometer(R) {
  const bulat = Math.round(R * 100) / 100;
  const S = Math.floor(bulat * 2 + 1e-9) / 2;
  const T = Math.round((bulat - S) * 100);
  return T >= 50 ? { S: S + 0.5, T: T - 50, nilai: bulat } : { S, T, nilai: bulat };
}

function renderAlatUkurSVG(cfg) {
  const alat = String(cfg.alat || 'jangka').toLowerCase();
  const mikro = /mikro|screw|sekrup/.test(alat);
  const b = kotakBatas();
  let isi = '';
  const garis = (x1, y1, x2, y2, t) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${t || 0.9}"/>`;
  const teks = (x, y, t, size, anchor) => { isi += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor || 'middle'}" font-size="${size || 10}" fill="${GAYA.hitam}">${escText(t)}</text>`; b.teks(x, y, String(t), size || 10, anchor || 'middle'); };

  if (!mikro) {
    const ket = Math.min(0.5, Math.max(0.01, angkaMm(cfg.ketelitian, 0.1)));
    const R = Math.max(0, angkaMm(cfg.nilai, 24.3));
    const { utama: M, N, n } = bacaanJangka(R, ket);
    const Rv = M + n * ket;
    // jendela skala utama: mulai di kelipatan 5 mm sebelum bacaan, cukup lebar untuk seluruh nonius
    const ms = Math.max(0, Math.floor((M - 4) / 5) * 5), akhir = Math.max(M + N + 3, ms + 22);
    const s = Math.min(10, 400 / (akhir - ms)), X0 = 14, Yc = 54;
    const X = (mm) => X0 + (mm - ms) * s;
    // batang skala utama (di atas garis) dan badan nonius (di bawah)
    isi += `<rect x="${X(ms) - 8}" y="${Yc - 40}" width="${(akhir - ms) * s + 16}" height="40" fill="#ffffff" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    b.titik(X(ms) - 8, Yc - 46); b.titik(X(akhir) + 8, Yc + 46);
    for (let mm = ms; mm <= akhir; mm++) {
      const p = mm % 10 === 0 ? 14 : mm % 5 === 0 ? 10 : 6;
      isi += garis(X(mm), Yc, X(mm), Yc - p, mm % 10 === 0 ? 1.1 : 0.8);
      if (mm % 10 === 0) teks(X(mm), Yc - 19, mm / 10, 10);
    }
    const xv0 = X(Rv), panjangV = (N - 1) * s;
    isi += `<rect x="${(xv0 - 8).toFixed(1)}" y="${Yc}" width="${(panjangV + 16).toFixed(1)}" height="40" fill="#ffffff" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    const labelTiap = N <= 10 ? 1 : N <= 20 ? 2 : 5;      // nomor 0..10 tiap sepersepuluh mm
    for (let k = 0; k <= N; k++) {
      const x = xv0 + k * (N - 1) / N * s;
      const p = k % labelTiap === 0 ? 11 : 7;
      isi += garis(x, Yc, x, Yc + p, k % labelTiap === 0 ? 1.1 : 0.8);
      if (k % labelTiap === 0) teks(x, Yc + 23, (k / labelTiap) * (labelTiap === 1 ? 1 : 1), 9);
    }
    // ujung kanan: nonius dengan N pembagian memakai N+1 garis; label terakhir = 10
    return bungkusGambarSVG(isi, b, false);
  }

  // Mikrometer sekrup
  const R = Math.max(0, Math.min(25, angkaMm(cfg.nilai, 5.38)));
  const { S, T } = bacaanMikrometer(R);
  const s = 15, Yc = 56, ms = Math.max(0, Math.floor(S) - 12), X0 = 10;
  const X = (mm) => X0 + (mm - ms) * s;
  const xTepi = X(S);
  isi += `<rect x="${X0 - 4}" y="${Yc - 32}" width="${(xTepi - X0 + 4).toFixed(1)}" height="56" fill="#ffffff" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
  isi += garis(X0 - 4, Yc, xTepi, Yc, 1.2);
  b.titik(X0 - 4, Yc - 40); b.titik(xTepi + 112, Yc + 56);
  for (let h = ms * 2; h <= S * 2; h++) {                  // h = jumlah setengah mm
    const mm = h / 2, x = X(mm);
    if (h % 2 === 0) { isi += garis(x, Yc, x, Yc - (mm % 5 === 0 ? 17 : 11), 0.9); if (mm % 5 === 0) teks(x, Yc - 21, mm, 9.5); }
    else isi += garis(x, Yc, x, Yc + 11, 0.9);
  }
  // selubung (thimble): garis acuan sejajar garis skala ke-T; 50 garis, 4,6 px per garis
  const d = 4.6;
  isi += `<path d="M${xTepi.toFixed(1)} ${Yc - 46} L${(xTepi + 112).toFixed(1)} ${Yc - 46} L${(xTepi + 112).toFixed(1)} ${Yc + 46} L${xTepi.toFixed(1)} ${Yc + 46} L${(xTepi - 4).toFixed(1)} ${Yc + 38} L${(xTepi - 4).toFixed(1)} ${Yc - 38} Z" fill="#ffffff" stroke="${GAYA.hitam}" stroke-width="1.3" stroke-linejoin="round"/>`;
  for (let i = T - 9; i <= T + 9; i++) {
    const y = Yc + (i - T) * d;
    if (y < Yc - 42 || y > Yc + 42) continue;
    const idx = ((i % 50) + 50) % 50, besar = idx % 5 === 0;
    isi += garis(xTepi, y, xTepi + (besar ? 14 : 8), y, besar ? 1.1 : 0.8);
    if (besar) teks(xTepi + 24, y + 3.5, idx, 9, 'start');
  }
  return bungkusGambarSVG(isi, b, false);
}

// ---------------------------------------------------------------------
// Fluida statis dan dinamis: hidrolik, bejana berhubungan, manometer,
// kontinuitas, venturi, tangki bocor (Torricelli), benda terapung/tergantung
// ---------------------------------------------------------------------

// "cm2" -> "cm²", "kg/m3" -> "kg/m³", "m/s2" -> "m/s²" untuk label bersatuan.
function pangkatSatuan(t) {
  return String(t).replace(/\b(mm|cm|m|km)2\b/g, '$1²').replace(/\b(mm|cm|m|km)3\b/g, '$1³').replace(/(\/s)2\b/g, '$1²').replace(/\/(m|cm)3\b/g, '/$1³').replace(/\/(m|cm)2\b/g, '/$1²');
}

function renderFluidaSVG(cfg) {
  let jenis = String(cfg.jenis || 'hidrolik').toLowerCase();
  if ((jenis === 'bejana' || jenis === 'u') && String(cfg.cairan2 || '').toLowerCase() === 'tidak' && (cfg.titik || cfg.bentuk)) jenis = 'wadah';
  const C1 = '#e2e2e2', C2 = '#b9b9b9';
  const b = kotakBatas();
  let isi = '';
  const g = (x1, y1, x2, y2, t, dash, warna) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${warna || GAYA.hitam}" stroke-width="${t || GAYA.garis}"${dash ? ` stroke-dasharray="${GAYA.putus}"` : ''}/>`;
  const poly = (d, fill) => `<path d="${d}" fill="${fill || 'none'}" stroke="${fill ? 'none' : GAYA.hitam}" stroke-width="${GAYA.garis}" stroke-linejoin="round"/>`;
  const T = (x, y, t, anchor, size, italic) => {
    const teks = pangkatSatuan(t);
    isi += teksGeoSVG({ x, y, anchor: anchor || 'middle' }, teks, size || GAYA.teks, !!italic, true);
    b.teks(x, y, teks, size || GAYA.teks, anchor || 'middle');
  };
  const dim = (x1, y1, x2, y2) => arrowSVG(x1, y1, x2, y2, { headLen: 5, strokeWidth: 1 }) + arrowSVG(x2, y2, x1, y1, { headLen: 5, strokeWidth: 1 });
  // "A1 = 10 cm2" kalau nilainya diberikan, "A1" saja kalau tidak (besaran yang dicari / tanpa angka).
  // Besaran yang dicari cukup ditulis hurufnya (h2=x -> "x", F2=F2 -> "F2"); nilai bersatuan -> "h1 = 10 cm".
  const lab = (sim, nilai) => {
    const v = nilai == null ? '' : String(nilai).trim();
    if (!v || v.toLowerCase() === sim.toLowerCase()) return sim;
    return /^[A-Za-z]$/.test(v) ? v : `${sim} = ${v}`;
  };
  const angka = (v, def) => { const n = numOrDefault(v, NaN); return isFinite(n) && n > 0 ? n : def; };
  const nama1 = String(cfg.cairan1 || cfg.cairan || 'air'), nama2 = String(cfg.cairan2 || 'minyak');

  if (jenis === 'hidrolik') {
    const xL0 = 12, xL1 = 52, xR0 = 104, xR1 = 196, ytop = 44, ysurf = 74, ybot = 142, ych = 112;
    isi += poly(`M${xL0},${ysurf} H${xL1} V${ych} H${xR0} V${ysurf} H${xR1} V${ybot} H${xL0} Z`, C1);
    isi += poly(`M${xL0},${ytop} V${ybot} H${xR1} V${ytop}`) + poly(`M${xL1},${ytop} V${ych} H${xR0} V${ytop}`);
    b.titik(xL0, ytop - 4); b.titik(xR1, ybot + 4);
    const pis = (x0, x1) => `<rect x="${x0 + 1}" y="${ysurf - 9}" width="${x1 - x0 - 2}" height="9" fill="#ffffff" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    isi += pis(xL0, xL1) + pis(xR0, xR1);
    const xl = (xL0 + xL1) / 2, xr = (xR0 + xR1) / 2;
    isi += arrowSVG(xl, 16, xl, ysurf - 12, { headLen: 8, strokeWidth: 1.8 });
    T(xl + 8, 24, lab('F1', cfg.F1), 'start', GAYA.teks, true);
    isi += `<rect x="${xr - 30}" y="${ysurf - 36}" width="60" height="27" fill="#ffffff" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    T(xr, ysurf - 19, cfg.beban ? String(cfg.beban) : 'beban', 'middle', GAYA.teksKecil);
    isi += arrowSVG(xR1 - 9, ysurf - 12, xR1 - 9, 16, { headLen: 8, strokeWidth: 1.8 });
    T(xR1 - 3, 24, lab('F2', cfg.F2), 'start', GAYA.teks, true);
    b.titik(xl, 8); b.titik(xR1 + 70, 8);
    // luas (A), atau jari-jari (r) / diameter (d) bila soal memberikan itu, bukan luas
    const penampang = (n) => (cfg['r' + n] != null ? lab('r' + n, cfg['r' + n]) : cfg['d' + n] != null ? lab('d' + n, cfg['d' + n]) : lab('A' + n, cfg['A' + n]));
    T(xl, ybot + 18, penampang(1), 'middle', GAYA.teks, true);
    T(xr, ybot + 18, penampang(2), 'middle', GAYA.teks, true);
    T((xL1 + xR0) / 2, ych - 10, nama1, 'middle', GAYA.teksKecil);
  } else if (jenis === 'bejana' || jenis === 'pipau' || jenis === 'u') {
    if (String(cfg.cairan2 || '').toLowerCase() === 'tidak') {
      // satu cairan, tiga bejana berbeda bentuk (tabung sempit, corong, tabung lebar) yang berbagi
      // dinding dan dasar: permukaan sama tinggi walau bentuk dan penampangnya berbeda
      const yl = 74, yc = 130, ydas = 150, ya = 24;
      const xL2 = 66 - 22 * (yc - yl) / (yc - ya), xR2 = 96 + 24 * (yc - yl) / (yc - ya);
      isi += poly(`M14,${yl} H40 V${yc} H66 L${xL2.toFixed(1)},${yl} H${xR2.toFixed(1)} L96,${yc} H132 V${yl} H176 V${ydas} H14 Z`, C1);
      isi += poly(`M14,${ya} V${ydas} H176 V${ya}`) + g(40, ya, 40, yc) + g(40, yc, 66, yc) + g(66, yc, 44, ya) + g(96, yc, 120, ya) + g(96, yc, 132, yc) + g(132, yc, 132, ya);
      isi += poly(`M40,${ya} H44 L66,${yc} H40 Z`, '#555555') + poly(`M120,${ya} H132 V${yc} H96 Z`, '#555555');   // sekat antar-bejana: dinding padat
      isi += g(0, yl, 196, yl, 1, true, GAYA.hitam);
      T(81, yl + 30, nama1, 'middle', GAYA.teks);
      b.titik(0, ya - 10); b.titik(200, ydas + 8);
      if (cfg.h) { isi += dim(188, yl, 188, ydas); T(194, (yl + ydas) / 2 + 4, lab('h', cfg.h), 'start', GAYA.teks, true); b.titik(250, 0); }
    } else {
      const xl0 = 24, xl1 = 62, xr0 = 100, xr1 = 138, ytop = 20, ybot = 158, ych = 126, yref = 104;
      const h1 = angka(cfg.h1, NaN), h2 = angka(cfg.h2, NaN);
      let p1 = 56, p2 = 78;                                             // tinggi gambar (px)
      if (isFinite(h1) && isFinite(h2)) { const k = 78 / Math.max(h1, h2); p1 = h1 * k; p2 = h2 * k; }
      const yL = yref - p1, yR = yref - p2;
      isi += poly(`M${xl0},${yL} H${xl1} V${ych} H${xr0} V${yref} H${xr1} V${ybot} H${xl0} Z`, C1);
      isi += poly(`M${xr0},${yR} H${xr1} V${yref} H${xr0} Z`, C2);
      isi += poly(`M${xl0},${ytop} V${ybot} H${xr1} V${ytop}`) + poly(`M${xl1},${ytop} V${ych} H${xr0} V${ytop}`);
      b.titik(xl0 - 70, ytop - 6); b.titik(xr1 + 80, ybot + 24);
      isi += g(xl0 - 8, yref, xr1 + 8, yref, 1, true, GAYA.hitam);
      isi += dim(xl0 - 16, yref, xl0 - 16, yL);
      T(xl0 - 22, (yref + yL) / 2 + 4, lab('h1', cfg.h1), 'end', GAYA.teks, true);
      isi += dim(xr1 + 16, yref, xr1 + 16, yR);
      T(xr1 + 22, (yref + yR) / 2 + 4, lab('h2', cfg.h2), 'start', GAYA.teks, true);
      T((xl0 + xl1) / 2, Math.min(yL + 18, ych - 6), nama1, 'middle', GAYA.teksKecil);
      T((xr0 + xr1) / 2, yR + 16, nama2, 'middle', GAYA.teksKecil);
      if (cfg.rho1 || cfg.rho2) {
        T((xl0 + xl1) / 2, ybot + 18, cfg.rho1 ? lab('ρ1', cfg.rho1) : 'ρ1', 'middle', GAYA.teksKecil);
        T((xr0 + xr1) / 2, ybot + 18, cfg.rho2 ? lab('ρ2', cfg.rho2) : 'ρ2', 'middle', GAYA.teksKecil);
      }
    }
  } else if (jenis === 'wadah' || jenis === 'tekananhidrostatis' || jenis === 'hidrostatis') {
    // Satu wadah berisi satu cairan: bentuk (tak-beraturan / lurus / melebar / menyempit), tinggi
    // permukaan h dari dasar, dan titik berketinggian (titik=A:10 cm,B:25 cm) untuk soal tekanan hidrostatis.
    const bentuk = String(cfg.bentuk || 'tak-beraturan').toLowerCase();
    const PROFIL = {
      lurus: [[0, 48], [1, 48]],
      melebar: [[0, 28], [1, 62]],
      menyempit: [[0, 60], [1, 30]],
      'tak-beraturan': [[0, 56], [0.22, 54], [0.45, 30], [0.62, 30], [0.82, 50], [1, 54]],
    };
    const prof = PROFIL[bentuk] || PROFIL['tak-beraturan'];
    const hw = (f) => { for (let i = 1; i < prof.length; i++) if (f <= prof[i][0] + 1e-9) { const [f0, w0] = prof[i - 1], [f1, w1] = prof[i]; return w0 + ((f - f0) / (f1 - f0)) * (w1 - w0); } return prof[prof.length - 1][1]; };
    const cx = 120, yb = 196, Hc = 176, ytop = yb - Hc;
    const hAir = angka(cfg.h, NaN);
    const titik = String(cfg.titik || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.indexOf(':'); return { nama: (i < 0 ? x : x.slice(0, i)).trim(), nilai: i < 0 ? '' : x.slice(i + 1).trim() }; });
    const lf = 0.84, yAir = yb - lf * Hc, skala = isFinite(hAir) ? (lf * Hc) / hAir : null;
    const xw = (f, sisi) => cx + sisi * hw(f);
    const fy = (y) => (yb - y) / Hc;
    // cairan
    const bp = prof.map((q) => q[0]).filter((f) => f < lf);
    let pathAir = `M${xw(lf, -1).toFixed(1)},${yAir.toFixed(1)}`;
    bp.slice().reverse().forEach((f) => { pathAir += ` L${xw(f, -1).toFixed(1)},${(yb - f * Hc).toFixed(1)}`; });
    bp.forEach((f) => { pathAir += ` L${xw(f, 1).toFixed(1)},${(yb - f * Hc).toFixed(1)}`; });
    pathAir += ` L${xw(lf, 1).toFixed(1)},${yAir.toFixed(1)} Z`;
    isi += poly(pathAir.replace(/^M[^L]*L/, (m) => m), C1);
    // dinding: kiri dari atas ke dasar, lantai, kanan ke atas
    let dinding = `M${xw(1, -1).toFixed(1)},${ytop}`;
    prof.slice().reverse().forEach((q) => { dinding += ` L${xw(q[0], -1).toFixed(1)},${(yb - q[0] * Hc).toFixed(1)}`; });
    prof.forEach((q) => { dinding += ` L${xw(q[0], 1).toFixed(1)},${(yb - q[0] * Hc).toFixed(1)}`; });
    isi += poly(dinding);
    const hwMax = Math.max(...prof.map((q) => q[1]));
    isi += g(cx - hwMax - 12, yAir, cx + hwMax + 12, yAir, 1, true, GAYA.hitam);
    b.titik(cx - hwMax - 80, ytop - 6); b.titik(cx + hwMax + 80 + 30 * Math.max(0, titik.length - 1), yb + 22);
    // tinggi permukaan dari dasar (kiri)
    const xdl = cx - hwMax - 26;
    isi += g(xdl - 4, yb, cx - hwMax + 6, yb, 1, true, GAYA.hitam) + dim(xdl, yb, xdl, yAir);
    T(xdl - 6, (yb + yAir) / 2 + 4, lab('h', cfg.h), 'end', GAYA.teks, true);
    // titik berketinggian (kanan): titik di dalam cairan + panah tinggi dari dasar
    titik.forEach((q, i) => {
      const e = angka(q.nilai, NaN);
      const yP = isFinite(e) && skala ? yb - e * skala : yb - (0.25 + 0.2 * i) * lf * Hc;
      const xp = cx + (i % 2 ? 10 : -10);
      isi += `<circle cx="${xp.toFixed(1)}" cy="${yP.toFixed(1)}" r="2.8" fill="${GAYA.hitam}"/>`;
      T(xp + (i % 2 ? 7 : -7), yP - 5, q.nama, i % 2 ? 'start' : 'end', GAYA.teks, true);
      const xdr = cx + hwMax + 24 + 34 * i;
      isi += g(xp + 4, yP, xdr, yP, 1, true, GAYA.hitam) + g(cx + hwMax, yb, xdr + 4, yb, 1, true, GAYA.hitam) + dim(xdr, yb, xdr, yP);
      T(xdr + 6, (yb + yP) / 2 + 4, q.nilai || ('h' + q.nama), 'start', GAYA.teks, true);
    });
    T(cx, yb - 12, nama1, 'middle', GAYA.teks);
    if (cfg.rho) T(cx, yb + 18, lab('ρ', cfg.rho), 'middle', GAYA.teksKecil);
  } else if (jenis === 'manometer') {
    const xt0 = 4, xt1 = 56, xl0 = 100, xl1 = 124, xr0 = 152, xr1 = 176, ybot = 150, ych = 120, ypa = 60, ypb = 76;
    const gasLebih = String(cfg.gas || 'lebih').toLowerCase() !== 'kurang';
    const yTinggi = 66, yRendah = 110;
    const yL = gasLebih ? yRendah : yTinggi, yR = gasLebih ? yTinggi : yRendah;
    isi += `<rect x="${xt0}" y="40" width="${xt1 - xt0}" height="56" fill="#ffffff" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    T((xt0 + xt1) / 2, 72, cfg.gasnama || 'gas', 'middle', GAYA.teks);
    isi += poly(`M${xl0},${yL} H${xl1} V${ych} H${xr0} V${yR} H${xr1} V${ybot} H${xl0} Z`, C2);
    // pipa dari tangki ke lengan kiri (tertutup di atas), lengan kanan terbuka ke udara
    isi += g(xt1, ypa, xl1, ypa) + g(xt1, ypb, xl0, ypb);
    isi += poly(`M${xl0},${ypb} V${ybot} H${xr1} V20`) + poly(`M${xl1},${ypa} V${ych} H${xr0} V20`);
    isi += arrowSVG((xr0 + xr1) / 2, 0, (xr0 + xr1) / 2, 24, { headLen: 7, strokeWidth: 1.4 });
    T(xr1 + 8, 12, lab('P0', cfg.P0 && cfg.P0 !== 'ya' ? cfg.P0 : ''), 'start', GAYA.teks, true);
    const xd = xr1 + 26;
    isi += g(xl1, yRendah, xd + 4, yRendah, 1, true, GAYA.hitam) + g(xr1, yTinggi, xd + 4, yTinggi, 1, true, GAYA.hitam);
    isi += dim(xd, yTinggi, xd, yRendah);
    T(xd + 8, (yTinggi + yRendah) / 2 + 4, lab('h', cfg.h), 'start', GAYA.teks, true);
    T((xl0 + xr1) / 2, ybot + 18, cfg.cairan || 'raksa', 'middle', GAYA.teksKecil);
    b.titik(xt0, 0); b.titik(xd + 60, ybot + 24);
  } else if (jenis === 'kontinuitas') {
    const x0 = 14, xa = 96, xb = 140, x1 = 262, s1 = 38, s2 = 19;
    const h1 = angka(cfg.h1, NaN), h2 = angka(cfg.h2, NaN), adaTinggi = isFinite(h1) && isFinite(h2);
    const k = adaTinggi ? 56 / Math.max(h1, h2) : 0, ref = 176;
    const yc1 = adaTinggi ? ref - 56 - h1 * k + 4 : 96, yc2 = adaTinggi ? ref - 56 - h2 * k + 4 : 96;
    const atas = (x) => (x <= xa ? yc1 - s1 : x >= xb ? yc2 - s2 : yc1 - s1 + ((x - xa) / (xb - xa)) * ((yc2 - s2) - (yc1 - s1)));
    const bawah = (x) => (x <= xa ? yc1 + s1 : x >= xb ? yc2 + s2 : yc1 + s1 + ((x - xa) / (xb - xa)) * ((yc2 + s2) - (yc1 + s1)));
    isi += poly(`M${x0},${yc1 - s1} H${xa} L${xb},${yc2 - s2} H${x1} V${yc2 + s2} H${xb} L${xa},${yc1 + s1} H${x0} Z`, C1);
    isi += poly(`M${x0},${yc1 - s1} H${xa} L${xb},${yc2 - s2} H${x1}`) + poly(`M${x0},${yc1 + s1} H${xa} L${xb},${yc2 + s2} H${x1}`);
    b.titik(x0 - 4, 10); b.titik(x1 + 4, ref + 14);
    const xs1 = 52, xs2 = 206;
    isi += g(xs1, atas(xs1), xs1, bawah(xs1), 1, true, GAYA.hitam) + g(xs2, atas(xs2), xs2, bawah(xs2), 1, true, GAYA.hitam);
    T(xs1, atas(xs1) - 6, lab('A1', cfg.A1), 'middle', GAYA.teks, true);
    T(xs2, atas(xs2) - 6, lab('A2', cfg.A2), 'middle', GAYA.teks, true);
    isi += arrowSVG(xs1 - 24, yc1, xs1 + 30, yc1, { headLen: 7, strokeWidth: 1.6 });
    T(xs1 + 3, yc1 + 15, lab('v1', cfg.v1), 'middle', GAYA.teks, true);
    isi += arrowSVG(xs2 - 30, yc2, xs2 + 40, yc2, { headLen: 7, strokeWidth: 1.6 });
    T(xs2 + 6, yc2 + 15, lab('v2', cfg.v2), 'middle', GAYA.teks, true);
    if (cfg.P1 || cfg.P2) {
      if (cfg.P1) T(xs1 - 26, atas(xs1) - 22, lab('P1', cfg.P1), 'middle', GAYA.teksKecil);
      if (cfg.P2) T(xs2 + 10, atas(xs2) - 22, lab('P2', cfg.P2), 'middle', GAYA.teksKecil);
    }
    if (adaTinggi) {
      isi += g(x0 - 8, ref, x1 + 22, ref, 1, true, GAYA.hitam);
      isi += dim(x0 - 2, ref, x0 - 2, yc1); T(x0 - 8, (ref + yc1) / 2 + 4, lab('h1', cfg.h1), 'end', GAYA.teks, true); b.titik(x0 - 70, ref);
      isi += dim(x1 + 12, ref, x1 + 12, yc2); T(x1 + 18, (ref + yc2) / 2 + 4, lab('h2', cfg.h2), 'start', GAYA.teks, true);
      b.titik(x1 + 60, ref);
    }
  } else if (jenis === 'venturi') {
    const x0 = 10, xa = 74, xb = 116, xc = 176, xd = 218, x1 = 282, sw = 30, st = 14, yc = 120;
    isi += poly(`M${x0},${yc - sw} H${xa} L${xb},${yc - st} H${xc} L${xd},${yc - sw} H${x1} V${yc + sw} H${xd} L${xc},${yc + st} H${xb} L${xa},${yc + sw} H${x0} Z`, C1);
    isi += poly(`M${x0},${yc - sw} H${xa} L${xb},${yc - st} H${xc} L${xd},${yc - sw} H${x1}`) + poly(`M${x0},${yc + sw} H${xa} L${xb},${yc + st} H${xb} H${xc} L${xd},${yc + sw} H${x1}`);
    const tub = (xm, yTop, ySambung) => {
      const w = 9;
      return `<path d="M${xm - w},${ySambung} V${yTop} M${xm + w},${ySambung} V${yTop}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    };
    const xm1 = 44, xm2 = 146, yS1 = yc - sw, yS2 = yc - st, yN1 = 38, yN2 = 74;
    isi += `<rect x="${xm1 - 8}" y="${yN1}" width="16" height="${yS1 - yN1 + 1}" fill="${C1}"/><rect x="${xm2 - 8}" y="${yN2}" width="16" height="${yS2 - yN2 + 1}" fill="${C1}"/>`;
    isi += tub(xm1, 14, yS1) + tub(xm2, 14, yS2);
    isi += g(xm1 - 9, yN1, xm1 + 9, yN1, 1.2) + g(xm2 - 9, yN2, xm2 + 9, yN2, 1.2);
    isi += g(xm2 + 10, yN1, xm2 + 34, yN1, 1, true, GAYA.hitam);
    isi += dim(xm2 + 28, yN1, xm2 + 28, yN2);
    T(xm2 + 36, (yN1 + yN2) / 2 + 4, lab('h', cfg.h), 'start', GAYA.teks, true);
    isi += arrowSVG(x0 + 4, yc, x0 + 40, yc, { headLen: 7, strokeWidth: 1.6 });
    T(x0 + 22, yc + 16, lab('v1', cfg.v1), 'middle', GAYA.teks, true);
    isi += arrowSVG(xb + 6, yc, xc - 6, yc, { headLen: 7, strokeWidth: 1.6 });
    T((xb + xc) / 2, yc + st + 16, lab('v2', cfg.v2), 'middle', GAYA.teks, true);
    T(xm1, yc + sw + 18, lab('A1', cfg.A1), 'middle', GAYA.teks, true);
    T(xm2, yc + st + 34, lab('A2', cfg.A2), 'middle', GAYA.teks, true);
    b.titik(x0 - 4, 8); b.titik(x1 + 4, yc + sw + 26);
  } else if (jenis === 'tangki' || jenis === 'torricelli') {
    const h1 = angka(cfg.h1, NaN), h2 = angka(cfg.h2, NaN);
    let p1 = 66, p2 = 70;
    if (isFinite(h1) && isFinite(h2)) { const k = 140 / (h1 + h2); p1 = h1 * k; p2 = h2 * k; }
    const tanah = 190, yLubang = tanah - p2, yAir = yLubang - p1, xk = 30, xw = 120, jatuh = 2 * Math.sqrt(p1 * p2);
    isi += `<rect x="${xk}" y="${yAir}" width="${xw - xk}" height="${tanah - yAir}" fill="${C1}"/>`;
    isi += g(xk, yAir - 14, xk, tanah) + g(xw, yAir - 14, xw, yLubang - 3) + g(xw, yLubang + 3, xw, tanah) + g(xk, tanah, xw, tanah);
    isi += g(xk - 2, yAir, xw + 2, yAir, 1, true, GAYA.abu);
    let jet = `M${xw},${yLubang}`;
    for (let i = 1; i <= 24; i++) { const dx = (jatuh * i) / 24; jet += ` L${(xw + dx).toFixed(1)},${(yLubang + p2 * Math.pow(dx / jatuh, 2)).toFixed(1)}`; }
    isi += `<path d="${jet}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    isi += g(xk - 40, tanah, xw + jatuh + 36, tanah, 2) + arsirTumpuanSVG(xk - 40, tanah, xw + jatuh + 36, tanah, 0, 1);
    b.titik(xk - 56, yAir - 20); b.titik(xw + jatuh + 40, tanah + 10);
    const xdm = xk - 14;
    isi += dim(xdm, yAir, xdm, yLubang); T(xdm - 5, (yAir + yLubang) / 2 + 4, lab('h1', cfg.h1), 'end', GAYA.teks, true);
    isi += dim(xdm, yLubang, xdm, tanah); T(xdm - 5, (yLubang + tanah) / 2 + 4, lab('h2', cfg.h2), 'end', GAYA.teks, true);
    isi += dim(xw + 2, tanah + 14, xw + jatuh, tanah + 14);
    T(xw + jatuh / 2, tanah + 30, lab('x', cfg.x), 'middle', GAYA.teks, true);
    isi += `<circle cx="${xw}" cy="${yLubang}" r="2" fill="${GAYA.hitam}"/>`;
    T((xk + xw) / 2, yAir + 20, nama1, 'middle', GAYA.teks);
    if (cfg.P0) T((xk + xw) / 2, yAir - 20, 'terbuka (P0)', 'middle', GAYA.teksKecil);
  } else if (jenis === 'apung' || jenis === 'archimedes' || jenis === 'tergantung') {
    const tergantung = jenis === 'tergantung' || /^(ya|true|1)$/i.test(String(cfg.tergantung || ''));
    const xc0 = 22, xc1 = 188, ybawah = 176, yair = 84, bw = 54, bh = 44, cx = (xc0 + xc1) / 2;
    const f = tergantung ? 1 : Math.min(0.95, Math.max(0.1, numOrDefault(cfg.bagian, 0.6)));
    const yAtasBenda = tergantung ? yair + 22 : yair - (1 - f) * bh, yBawahBenda = yAtasBenda + bh;
    isi += `<rect x="${xc0}" y="${yair}" width="${xc1 - xc0}" height="${ybawah - yair}" fill="${C1}"/>`;
    isi += g(xc0, 34, xc0, ybawah) + g(xc1, 34, xc1, ybawah) + g(xc0, ybawah, xc1, ybawah);
    isi += `<rect x="${cx - bw / 2}" y="${yAtasBenda.toFixed(1)}" width="${bw}" height="${bh}" fill="#ffffff" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    isi += g(xc0, yair, cx - bw / 2, yair, 1.2) + g(cx + bw / 2, yair, xc1, yair, 1.2);
    isi += g(cx - bw / 2, yair, cx + bw / 2, yair, 1, true, GAYA.hitam);
    b.titik(xc0 - 8, 8); b.titik(xc1 + 80, ybawah + 20);
    T(cx - bw / 2 - 6, yAtasBenda + bh / 2 + 4, cfg.benda ? String(cfg.benda) : 'benda', 'end', GAYA.teksKecil);
    T(xc0 + 34, ybawah - 12, nama1, 'middle', GAYA.teks);
    const yMid = (yAtasBenda + yBawahBenda) / 2;
    const fa = (xx, yy) => `F<tspan baseline-shift="sub" font-size="8">A</tspan>`;
    const labelFA = cfg.FA ? ` = ${pangkatSatuan(cfg.FA)}` : '';
    // gaya: w turun dari pusat benda, F_A naik, (T naik bila tergantung pada tali)
    isi += arrowSVG(cx, yMid, cx, yMid + 56, { headLen: 8, strokeWidth: 1.8 });
    T(cx + 7, yMid + 62, lab('w', cfg.w), 'start', GAYA.teks, true);
    isi += arrowSVG(cx - (tergantung ? 14 : 0), yMid, cx - (tergantung ? 14 : 0), yMid - 52, { headLen: 8, strokeWidth: 1.8 });
    isi += `<text x="${(cx - (tergantung ? 14 : 0) - 7).toFixed(1)}" y="${(yMid - 56).toFixed(1)}" text-anchor="end" font-size="${GAYA.teks}" font-style="italic" fill="${GAYA.hitam}" stroke="#ffffff" stroke-width="3" paint-order="stroke">${fa()}${escText(labelFA)}</text>`;
    b.teks(cx - 21 - 50, yMid - 56, 'FA' + labelFA, GAYA.teks, 'end');
    if (tergantung) {
      isi += g(cx, 10, cx, yAtasBenda, 1.2);
      isi += arrowSVG(cx + 14, yMid, cx + 14, yMid - 52, { headLen: 8, strokeWidth: 1.8 });
      T(cx + 21, yMid - 56, lab('T', cfg.T), 'start', GAYA.teks, true);
    }
  } else {
    throw new Error('jenis fluida "' + jenis + '" tidak dikenal (hidrolik, bejana, manometer, kontinuitas, venturi, tangki, apung, tergantung)');
  }
  return bungkusGambarSVG(isi, b, false);
}

// ---------------------------------------------------------------------
// Solenoida dan induksi elektromagnetik (hukum Faraday / Lenz)
// ---------------------------------------------------------------------

// Kumparan N lilitan + galvanometer G + magnet batang yang mendekat/menjauh/diam di salah satu ujung.
// Arah arus induksi dan arah medan induksi TIDAK digambar kecuali diminta (arus=x>y, medan=kanan),
// karena itulah yang ditanyakan soal; versi guru memakai tag yang sama dengan arus/medan terisi.
function renderSolenoidaSVG(cfg) {
  const N = Math.max(2, Math.min(14, Math.round(numOrDefault(cfg.lilitan, 6))));
  const sisi = /kiri/i.test(String(cfg.sisi || '')) ? -1 : 1;                       // magnet di ujung kanan (default) atau kiri
  const kutub = /^s|selatan/i.test(String(cfg.kutub || 'U')) ? 'S' : 'U';            // kutub magnet yang menghadap kumparan
  const gerak = String(cfg.gerak || 'mendekat').toLowerCase();
  const arus = String(cfg.arus || '').replace(/\s/g, '').toLowerCase();
  const medan = String(cfg.medan || '').toLowerCase();
  const simpangan = String(cfg.simpangan || '').toLowerCase();
  const ya = (k) => /^(ya|true|1)$/i.test(String(cfg[k] || ''));
  const b = kotakBatas();
  let isi = '';
  const g = (x1, y1, x2, y2, t, dash) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${t || GAYA.garis}"${dash ? ` stroke-dasharray="${GAYA.putus}"` : ''}/>`;
  const T = (x, y, t, anchor, size, italic) => { isi += teksGeoSVG({ x, y, anchor: anchor || 'middle' }, String(t), size || GAYA.teks, !!italic, true); b.teks(x, y, String(t), size || GAYA.teks, anchor || 'middle'); };

  const yc = 74, ry = 30, rx = 4, dx = 21, x0 = 120, x1 = x0 + N * dx;              // pusat vertikal kumparan, jari-jari lilitan, jarak antar lilitan (satu putaran)
  const cG = (x0 + x1) / 2, yBox = 150, bw = 58, bh = 42;                           // galvanometer: kotak berdial di bawah kumparan
  const xKiri = x0 - 34, xKanan = x1 + 34, yB = yc + ry;
  const tL = cG - 16, tR = cG + 16;                                                 // dua terminal di sisi atas galvanometer

  // Kumparan sebagai heliks: x maju searah sumbu, y = yc + ry sin(sudut), kedalaman z = cos(sudut). Bagian
  // DEPAN (z>0) digambar tebal hitam miring "\" dengan alas putih yang menutupi garis di belakangnya; bagian
  // BELAKANG (z<0) tipis abu-abu miring "/". Kedua ujung kawat keluar dari bagian bawah (z=0).
  const titikHeliks = (phi) => ({ x: x0 + (dx * (phi - Math.PI / 2)) / (2 * Math.PI), y: yc + ry * Math.sin(phi), z: Math.cos(phi) });
  const rute = (a, c) => { let d = ''; for (let k = 0; k <= 18; k++) { const q = titikHeliks(a + ((c - a) * k) / 18); d += (k ? ' L' : 'M') + q.x.toFixed(1) + ' ' + q.y.toFixed(1); } return d; };
  isi += g(x0, yc - ry, x1, yc - ry, 0.8).replace(`stroke="${GAYA.hitam}"`, 'stroke="#d0d0d0"') + g(x0, yc + ry, x1, yc + ry, 0.8).replace(`stroke="${GAYA.hitam}"`, 'stroke="#d0d0d0"');
  for (let i = 0; i < N; i++) {
    const a0 = Math.PI / 2 + i * 2 * Math.PI;
    isi += `<path class="sol-belakang" d="${rute(a0, a0 + Math.PI)}" fill="none" stroke="#7c7c7c" stroke-width="1.15"/>`;
  }
  for (let i = 0; i < N; i++) {
    const a1 = (3 * Math.PI) / 2 + i * 2 * Math.PI;
    const d = rute(a1, a1 + Math.PI);
    isi += `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="4.2" stroke-linecap="round"/><path class="sol-depan" d="${d}" fill="none" stroke="${GAYA.hitam}" stroke-width="1.9" stroke-linecap="round"/>`;
  }
  b.titik(x0 - rx - 2, yc - ry - 4); b.titik(x1 + rx + 2, yc + ry + 4);

  // dua kawat BERBEDA: ujung kiri (x) masuk ke terminal kiri lewat jalur rendah, ujung kanan (y) ke terminal kanan
  // lewat jalur lebih tinggi, jadi tak pernah saling menyilang dan tiap kawat jelas milik ujung yang mana
  const yLewatKiri = yBox - 14, yLewatKanan = yBox - 28;
  isi += g(x0, yB, xKiri, yB) + g(xKiri, yB, xKiri, yLewatKiri) + g(xKiri, yLewatKiri, tL, yLewatKiri) + g(tL, yLewatKiri, tL, yBox);
  isi += g(x1, yB, xKanan, yB) + g(xKanan, yB, xKanan, yLewatKanan) + g(xKanan, yLewatKanan, tR, yLewatKanan) + g(tR, yLewatKanan, tR, yBox);
  isi += `<circle cx="${xKiri}" cy="${yB}" r="2.4" fill="${GAYA.hitam}"/><circle cx="${xKanan}" cy="${yB}" r="2.4" fill="${GAYA.hitam}"/>`;
  T(xKiri - 8, yB + 4, 'x', 'end', GAYA.teks, true);
  T(xKanan + 8, yB + 4, 'y', 'start', GAYA.teks, true);
  b.titik(xKiri - 24, yc - ry - 10); b.titik(xKanan + 24, yBox + bh + 10);

  // galvanometer: kotak, dial setengah lingkaran, jarum, dua terminal
  isi += `<rect x="${(cG - bw / 2).toFixed(1)}" y="${yBox}" width="${bw}" height="${bh}" rx="3" fill="#d8d8d8" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  const cy0 = yBox + bh - 7, rd = 19;
  isi += `<path d="M${(cG - rd).toFixed(1)},${cy0} A${rd},${rd} 0 0 1 ${(cG + rd).toFixed(1)},${cy0} Z" fill="#ffffff" stroke="${GAYA.hitam}" stroke-width="1.1"/>`;
  for (let k = -2; k <= 2; k++) { const a = (k * 32 * Math.PI) / 180; isi += g(cG + Math.sin(a) * (rd - 5), cy0 - Math.cos(a) * (rd - 5), cG + Math.sin(a) * (rd - 1.5), cy0 - Math.cos(a) * (rd - 1.5), 0.9); }
  const sd = /kanan/.test(simpangan) ? 1 : /kiri/.test(simpangan) ? -1 : 0;
  const aJarum = (sd * 38 * Math.PI) / 180;
  isi += g(cG, cy0, cG + Math.sin(aJarum) * (rd - 3), cy0 - Math.cos(aJarum) * (rd - 3), 1.6);
  isi += `<circle cx="${tL}" cy="${yBox}" r="3.2" fill="${GAYA.hitam}"/><circle cx="${tR}" cy="${yBox}" r="3.2" fill="${GAYA.hitam}"/>`;
  T(cG + bw / 2 + 8, yBox + bh / 2 + 5, 'G', 'start', GAYA.teks + 1, true);
  b.titik(cG - bw / 2 - 4, yBox - 2); b.titik(cG + bw / 2 + 24, yBox + bh + 4);

  // magnet batang di salah satu ujung, kutub menghadap kumparan sesuai kutub=
  const gap = gerak === 'diam' ? 30 : 34, mw = 84, mh = 26;
  const xUjung = sisi > 0 ? x1 + rx : x0 - rx;
  const xm0 = sisi > 0 ? xUjung + gap : xUjung - gap - mw, xm1 = xm0 + mw;
  const lain = kutub === 'U' ? 'S' : 'U';
  const dekat = sisi > 0 ? 'kiri' : 'kanan';
  const hurufKiri = dekat === 'kiri' ? kutub : lain, hurufKanan = dekat === 'kiri' ? lain : kutub;
  isi += `<rect x="${xm0}" y="${yc - mh / 2}" width="${mw}" height="${mh}" fill="#ffffff" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>` + g(xm0 + mw / 2, yc - mh / 2, xm0 + mw / 2, yc + mh / 2, 1.2);
  T(xm0 + mw / 4, yc + 5, hurufKiri, 'middle', GAYA.teks + 1);
  T(xm0 + (3 * mw) / 4, yc + 5, hurufKanan, 'middle', GAYA.teks + 1);
  b.titik(xm0 - 4, yc - 52); b.titik(xm1 + 4, yc + 52);
  const arahKeKumparan = gerak === 'mendekat' ? -sisi : sisi;                                  // mendekat: menuju kumparan
  if (gerak !== 'diam') {
    const ya0 = yc - mh / 2 - 14, panjang = 34;
    const xa = xm0 + mw / 2 - (arahKeKumparan * panjang) / 2;
    isi += arrowSVG(xa, ya0, xa + arahKeKumparan * panjang, ya0, { headLen: 8, strokeWidth: 1.8 });
    if (ya('besaran')) T(xa + (arahKeKumparan * panjang) / 2, ya0 - 8, 'v', 'middle', GAYA.teks, true);
    b.titik(xa - 6, ya0 - 18); b.titik(xa + panjang + 6, ya0 + 8);
  }
  // besaran=ya: arah medan magnet B (keluar dari kutub U): menuju kumparan bila U menghadap kumparan
  if (ya('besaran')) {
    const sdB = (kutub === 'U' ? -1 : 1) * sisi;                                               // -1 = ke kiri
    const yb2 = yc + mh / 2 + 16, xa = xm0 + mw / 2 - (sdB * 34) / 2;
    isi += arrowSVG(xa, yb2, xa + sdB * 34, yb2, { headLen: 8, strokeWidth: 1.8 });
    T(xa + (sdB * 34) / 2, yb2 + 15, 'B', 'middle', GAYA.teks, true);
  }

  // label nama (label=ya), N lilitan dan titik A pada kumparan (titikA=ya), seperti gambar buku
  if (ya('label')) {
    T(xm0 + mw / 2, yc + mh / 2 + (ya('besaran') ? 44 : 20), 'Magnet', 'middle', GAYA.teks);
    T(cG, yc - ry - 8, 'Kumparan', 'middle', GAYA.teks);
    T(cG, yBox + bh + 16, 'Galvanometer', 'middle', GAYA.teks);
    b.titik(cG, yBox + bh + 22);
  }
  if (ya('n') || ya('label')) T(x0 - rx - 14, yc + 5, 'N', 'end', GAYA.teks, true);
  if (ya('titikA') || ya('titika')) {
    const xA = x1 - dx * 0.5, yA = yc - ry + 6;                                          // di ujung kanan kumparan, jauh dari tulisan "Kumparan" di tengah
    isi += arrowSVG(xA + 34, yA - 22, xA + 4, yA - 1, { headLen: 7, strokeWidth: 1.2 });
    T(xA + 40, yA - 24, 'A', 'start', GAYA.teks + 1, true);
    b.titik(xA + 56, yA - 38);
  }

  // jawaban (opsional): arah arus di rangkaian luar (panah pada KEDUA kawat), arah medan induksi di dalam kumparan
  if (arus === 'x>y' || arus === 'y>x') {
    const dari = arus === 'x>y';                                                         // x>y: arus keluar dari ujung x, melewati G, kembali lewat ujung y
    const yTengahKiri = (yB + yLewatKiri) / 2, yTengahKanan = (yB + yLewatKanan) / 2;
    isi += arrowSVG(xKiri, yTengahKiri - (dari ? 10 : -10), xKiri, yTengahKiri + (dari ? 10 : -10), { headLen: 7, strokeWidth: 1.8 });
    isi += arrowSVG(xKanan, yTengahKanan + (dari ? 10 : -10), xKanan, yTengahKanan - (dari ? 10 : -10), { headLen: 7, strokeWidth: 1.8 });
    T(xKiri - 8, yTengahKiri + 4, 'I', 'end', GAYA.teks, true);
  }
  if (medan === 'kanan' || medan === 'kiri') {
    const sdM = medan === 'kanan' ? 1 : -1;
    isi += arrowSVG(cG - sdM * 22, yc, cG + sdM * 22, yc, { headLen: 8, strokeWidth: 1.8 });
    T(cG, yc - 8, 'B', 'middle', GAYA.teks, true);
  }
  if (cfg.judul) T((xKiri + xKanan) / 2, yc - ry - 14, cfg.judul, 'middle', GAYA.teks);
  return bungkusGambarSVG(isi, b, false);
}

// ---------------------------------------------------------------------
// 2e. Sketsa geometri bebas (segitiga + garis sejajar, sudut pada garis
// lurus, garis sejajar + transversal, ... — bentuk apa pun dari koordinat)
// ---------------------------------------------------------------------

// "A-B-C-A, D-E" -> [['A','B'],['B','C'],['C','A'],['D','E']] (rangkaian dipecah jadi sisi).
function parseSisiSketsa(raw) {
  const out = [];
  String(raw || '').split(/[,|]/).forEach((chunk) => {
    const n = chunk.split('-').map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i + 1 < n.length; i++) out.push([n[i], n[i + 1]]);
  });
  return out;
}

// "D-E,A-B|P-Q" -> [[['D','E'],['A','B']], [['P','Q']]] (kelompok dipisah "|").
function parseKelompokSisi(raw) {
  return String(raw || '').split('|').map((g) => parseSisiSketsa(g)).filter((g) => g.length);
}

// "B-A-C:63, D-E:15 cm" -> [{ kunci:['B','A','C'], teks:'63' }, ...]. Pemisah "|"
// kalau ada (supaya koma desimal aman), kalau tidak koma.
function parseEntriSketsa(raw) {
  const s = String(raw || '');
  return s.split(s.indexOf('|') > -1 ? '|' : ',').map((e) => e.trim()).filter(Boolean).map((e) => {
    const i = e.indexOf(':');
    const kunci = (i < 0 ? e : e.slice(0, i)).split('-').map((x) => x.trim());
    return { kunci, teks: i < 0 ? '' : e.slice(i + 1).trim() };
  });
}

// Nilai sudut: angka atau angka+huruf ("63", "14x", "x") otomatis diberi °;
// "?" dan ungkapan yang sudah memuat ° atau operator ditulis apa adanya.
function teksSudutSketsa(t) {
  return /^-?[\d.,]*[a-zA-Z]?$/.test(t) && t !== '' ? t + '°' : t;
}

// Segitiga siku-siku di B dengan garis tinggi BD ke hipotenusa AC (soal
// kesebangunan klasik). Koordinat dihitung di sini, bukan oleh penulis soal:
// BD butuh akar (BD² = AD·DC) dan salah letak sudut siku sudah pernah terjadi.
// Diketahui cukup dua dari ad, dc, bd, ab, bc, ac; sisanya dicari dari
// hubungan AC = AD+DC, BD² = AD·DC, AB² = AD·AC, BC² = DC·AC, AB·BC = BD·AC.
function sketsaSikuTinggi(cfg) {
  const kunci = ['ad', 'dc', 'bd', 'ab', 'bc', 'ac'];
  const label = {}, v = {};
  kunci.forEach((k) => {
    const t = cfg[k]; if (t == null || t === '') return;
    label[k] = String(t);
    const n = parseFloat(String(t).replace(',', '.'));
    if (isFinite(n) && n > 0) v[k] = n;
  });
  const rel = [
    (g) => (g.ac == null && g.ad != null && g.dc != null ? ['ac', g.ad + g.dc] : g.ad == null && g.ac != null && g.dc != null ? ['ad', g.ac - g.dc] : g.dc == null && g.ac != null && g.ad != null ? ['dc', g.ac - g.ad] : null),
    (g) => (g.bd == null && g.ad != null && g.dc != null ? ['bd', Math.sqrt(g.ad * g.dc)] : g.ad == null && g.bd != null && g.dc != null ? ['ad', g.bd * g.bd / g.dc] : g.dc == null && g.bd != null && g.ad != null ? ['dc', g.bd * g.bd / g.ad] : null),
    (g) => (g.ab == null && g.ad != null && g.ac != null ? ['ab', Math.sqrt(g.ad * g.ac)] : g.ad == null && g.ab != null && g.ac != null ? ['ad', g.ab * g.ab / g.ac] : g.ac == null && g.ab != null && g.ad != null ? ['ac', g.ab * g.ab / g.ad] : null),
    (g) => (g.bc == null && g.dc != null && g.ac != null ? ['bc', Math.sqrt(g.dc * g.ac)] : g.dc == null && g.bc != null && g.ac != null ? ['dc', g.bc * g.bc / g.ac] : g.ac == null && g.bc != null && g.dc != null ? ['ac', g.bc * g.bc / g.dc] : null),
    (g) => (g.ac == null && g.ab != null && g.bc != null ? ['ac', Math.hypot(g.ab, g.bc)] : g.bc == null && g.ab != null && g.ac != null && g.ac > g.ab ? ['bc', Math.sqrt(g.ac * g.ac - g.ab * g.ab)] : g.ab == null && g.bc != null && g.ac != null && g.ac > g.bc ? ['ab', Math.sqrt(g.ac * g.ac - g.bc * g.bc)] : null),
    (g) => (g.bd == null && g.ab != null && g.bc != null && g.ac != null ? ['bd', g.ab * g.bc / g.ac] : null),
  ];
  for (let i = 0; i < 12; i++) rel.forEach((r) => { const x = r(v); if (x && isFinite(x[1]) && x[1] > 0 && v[x[0]] == null) v[x[0]] = x[1]; });
  if (v.ad == null || v.dc == null || v.bd == null) { v.ad = 4; v.dc = 9; v.bd = 6; v.ac = 13; }
  const sisi = { ad: 'A-D', dc: 'D-C', bd: 'B-D', ab: 'A-B', bc: 'B-C', ac: 'A-C' };
  return {
    titik: `A:0:0,C:${v.ad + v.dc}:0,B:${v.ad}:${v.bd},D:${v.ad}:0`,
    garis: 'A-B-C-A,B-D',
    siku: 'A-B-C,B-D-A',
    label: Object.keys(label).filter((k) => sisi[k]).map((k) => `${sisi[k]}:${label[k]}`).join('|'),
  };
}

function renderSketsaSVG(cfg) {
  if (/siku-?tinggi/i.test(String(cfg.bentuk || ''))) cfg = Object.assign({}, cfg, sketsaSikuTinggi(cfg));
  const semua = parseVertexList(cfg.titik);
  const pts = semua.length ? semua : [{ name: 'A', x: 0, y: 0 }, { name: 'B', x: 10, y: 0 }, { name: 'C', x: 5, y: 8 }];
  const areaW = 260, areaH = 200;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const skala = Math.min(areaW / Math.max(maxX - minX, 1e-6), areaH / Math.max(maxY - minY, 1e-6));
  const px = {};
  pts.forEach((p) => { px[p.name] = [(p.x - minX) * skala, (maxY - p.y) * skala]; });
  const ada = (n) => px[n] !== undefined;

  const garis = parseSisiSketsa(cfg.garis).filter((s) => ada(s[0]) && ada(s[1]));
  const putus = parseSisiSketsa(cfg.putus).filter((s) => ada(s[0]) && ada(s[1]));
  const sinar = parseSisiSketsa(cfg.sinar).filter((s) => ada(s[0]) && ada(s[1]));
  const b = kotakBatas();
  let isi = '';
  const garisSVG = (p, q, dash) => `<line x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${q[0].toFixed(1)}" y2="${q[1].toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}" stroke-linecap="round"${dash ? ` stroke-dasharray="${GAYA.putus}"` : ''}/>`;
  garis.forEach((s) => { isi += garisSVG(px[s[0]], px[s[1]], false); });
  putus.forEach((s) => { isi += garisSVG(px[s[0]], px[s[1]], true); });
  sinar.forEach((s) => { isi += arrowSVG(px[s[0]][0], px[s[0]][1], px[s[1]][0], px[s[1]][1], { headLen: 8, strokeWidth: GAYA.garis }); });
  pts.forEach((p) => b.titik(px[p.name][0], px[p.name][1]));
  const sisiSemua = garis.concat(putus, sinar);

  // Tanda sejajar (> berulang per kelompok) dan sama panjang (garis kecil).
  // Sisi satu kelompok diarahkan sama (ke kanan, atau ke atas bila tegak)
  // supaya mata panahnya searah.
  parseKelompokSisi(cfg.sejajar).forEach((kel, gi) => {
    kel.forEach((s) => {
      if (!ada(s[0]) || !ada(s[1])) return;
      let p = px[s[0]], q = px[s[1]];
      if (q[0] < p[0] - 1e-6 || (Math.abs(q[0] - p[0]) < 1e-6 && q[1] > p[1])) { const t = p; p = q; q = t; }
      isi += panahSejajarSVG(p[0], p[1], q[0], q[1], gi + 1);
    });
  });
  parseKelompokSisi(cfg.sama).forEach((kel, gi) => {
    kel.forEach((s) => { if (ada(s[0]) && ada(s[1])) isi += tickSisiSVG(px[s[0]][0], px[s[0]][1], px[s[1]][0], px[s[1]][1], gi + 1); });
  });
  parseEntriSketsa(cfg.siku).forEach((e) => {
    const [a, v, c] = e.kunci;
    if (ada(a) && ada(v) && ada(c)) isi += rightAngleSVG(px[v][0], px[v][1], px[a][0], px[a][1], px[c][0], px[c][1], 9);
  });

  // Kotak teks yang sudah terpakai: huruf berikutnya menghindarinya.
  const terpakai = [];
  const kotak = (x, y, t, size, anchor) => {
    const w = lebarTeksKira(t, size), x1 = anchor === 'end' ? x - w : anchor === 'start' ? x : x - w / 2;
    return { x1: x1 - 1.5, x2: x1 + w + 1.5, y1: y - size * 0.85, y2: y + size * 0.3 };
  };
  const bentrok = (k) => terpakai.some((o) => k.x1 < o.x2 && k.x2 > o.x1 && k.y1 < o.y2 && k.y2 > o.y1);
  const pusat = pts.reduce((s, p) => [s[0] + px[p.name][0] / pts.length, s[1] + px[p.name][1] / pts.length], [0, 0]);
  const taruh = (cands, t, size, italic) => {
    let pilih = null;
    for (const c of cands) {
      const k = kotak(c.x, c.y, t, size, c.anchor);
      if (!pilih) pilih = { c, k };
      if (!bentrok(k)) { pilih = { c, k }; break; }
    }
    terpakai.push(pilih.k);
    isi += teksGeoSVG(pilih.c, t, size, italic, true);
    b.teks(pilih.c.x, pilih.c.y, t, size, pilih.c.anchor);
  };

  // Busur sudut: label di garis bagi, di luar busur; sudut sempit memakai busur lebih besar.
  parseEntriSketsa(cfg.sudut).forEach((e) => {
    const [a, v, c] = e.kunci;
    if (!ada(a) || !ada(v) || !ada(c)) return;
    const [vx, vy] = px[v], [ax, ay] = px[a], [cx, cy] = px[c];
    const a1 = Math.atan2(ay - vy, ax - vx);
    let d = Math.atan2(cy - vy, cx - vx) - a1;
    while (d <= -Math.PI) d += 2 * Math.PI;
    while (d > Math.PI) d -= 2 * Math.PI;
    const r = Math.abs(d) < 0.8 ? 24 : 17;
    isi += angleArcSVG(vx, vy, vx + Math.cos(a1) * 40, vy + Math.sin(a1) * 40, vx + Math.cos(a1 + d) * 40, vy + Math.sin(a1 + d) * 40, r, '');
    if (e.teks) {
      const t = teksSudutSketsa(e.teks), w = lebarTeksKira(t, 11);
      const mid = a1 + d / 2;
      const cands = [0, 8, 16].map((extra) => {
        const jarak = r + 5 + extra + w * 0.5 * Math.abs(Math.cos(mid)) + 5 * Math.abs(Math.sin(mid));
        return { x: vx + jarak * Math.cos(mid), y: vy + jarak * Math.sin(mid) + 3.8, anchor: 'middle' };
      });
      taruh(cands, t, 11, false);
    }
  });

  // Panjang sisi: di sisi luar (menjauhi pusat gambar); awalan "~" membalik sisinya.
  parseEntriSketsa(cfg.label).forEach((e) => {
    const [a, c] = e.kunci;
    if (!ada(a) || !ada(c) || !e.teks) return;
    const flip = e.teks[0] === '~';
    const t = flip ? e.teks.slice(1).trim() : e.teks;
    const [x1, y1] = px[a], [x2, y2] = px[c];
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, len = Math.hypot(x2 - x1, y2 - y1) || 1;
    let nx = -(y2 - y1) / len, ny = (x2 - x1) / len;
    const arah = nx * (mx - pusat[0]) + ny * (my - pusat[1]);
    if (arah < 0 || (Math.abs(arah) < 1 && ny > 0)) { nx = -nx; ny = -ny; }
    if (flip) { nx = -nx; ny = -ny; }
    const cands = [1, -1].map((sg) => letakTeksLuar(mx, my, nx * sg, ny * sg, 7, 11.5));
    taruh(cands, t, 11.5, false);
  });

  // Huruf titik: menjauhi sisi-sisi yang bertemu di titik itu; bentrok -> diputar.
  pts.forEach((p) => {
    if (/^[._]/.test(p.name)) return;
    const [x, y] = px[p.name];
    let sx = 0, sy = 0;
    sisiSemua.forEach((s) => {
      const lain = s[0] === p.name ? s[1] : s[1] === p.name ? s[0] : null;
      if (lain === null) return;
      const d = Math.hypot(px[lain][0] - x, px[lain][1] - y) || 1;
      sx += (px[lain][0] - x) / d; sy += (px[lain][1] - y) / d;
    });
    let ux = -sx, uy = -sy, m = Math.hypot(ux, uy);
    if (m < 0.35) { ux = x - pusat[0]; uy = y - pusat[1]; m = Math.hypot(ux, uy); if (m < 1e-6) { ux = 0; uy = -1; m = 1; } }
    ux /= m; uy /= m;
    const cands = [0, 45, -45, 90, -90, 135, -135, 180].map((deg) => {
      const r = (deg * Math.PI) / 180;
      return letakTeksLuar(x, y, ux * Math.cos(r) - uy * Math.sin(r), ux * Math.sin(r) + uy * Math.cos(r), 7, 12.5);
    });
    taruh(cands, p.name, 12.5, true);
  });

  return bungkusGambarSVG(isi, b, false);
}

function renderAngleSVG(cfg) {
  return cfg.mode === 'sejajar' ? renderParallelLinesSVG(cfg) : renderPolygonAngleSVG(cfg);
}

// ---------------------------------------------------------------------
// 3. Garis Bilangan
// ---------------------------------------------------------------------

function renderNumberLineSVG(cfg) {
  const width = 400, pad = 30;
  const min = numOrDefault(cfg.min, -10), max = numOrDefault(cfg.max, 10);
  const step = numOrDefault(cfg.step, 1) || 1;
  const sx = (width - 2 * pad) / (max - min || 1);
  const toPx = (v) => pad + (v - min) * sx;
  const adaTitik = (cfg.titik || []).length > 0;
  // Kanvas dipotong pas: ruang di atas garis hanya kalau ada titik berlabel.
  const y = adaTitik ? 34 : 14;
  const height = y + 30;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  // Garis bilangan berpanah di kedua ujung (bilangan berlanjut ke dua arah).
  svg += arrowSVG(width / 2, y, width - pad + 12, y, { headLen: 7, strokeWidth: GAYA.garis });
  svg += arrowSVG(width / 2, y, pad - 12, y, { headLen: 7, strokeWidth: GAYA.garis });

  // Angka skala dijarangkan otomatis kalau langkahnya terlalu rapat untuk
  // dibaca (mis. min=0, max=100, step=1): tanda tetap digambar semua.
  const jumlah = Math.floor((max - min) / step + 1e-9) + 1;
  const tiap = Math.max(1, Math.ceil(jumlah / 21));
  let k = 0;
  for (let v = min; v <= max + 1e-9; v += step, k++) {
    const rv = Math.round(v * 1000) / 1000;
    const px = toPx(rv);
    const utama = k % tiap === 0;
    svg += `<line x1="${px.toFixed(1)}" y1="${y - (utama ? 6 : 4)}" x2="${px.toFixed(1)}" y2="${y + (utama ? 6 : 4)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
    if (utama) svg += `<text x="${px.toFixed(1)}" y="${y + 20}" font-size="${GAYA.teks}" text-anchor="middle" fill="${GAYA.hitam}">${rv}</text>`;
  }
  (cfg.titik || []).forEach((p) => {
    const px = toPx(p.value);
    svg += `<circle cx="${px.toFixed(1)}" cy="${y}" r="3.5" fill="${GAYA.hitam}"/>`;
    svg += teksHaloSVG(px, y - 12, p.label || '', { size: 12, bold: true });
  });

  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 4. Diagram Venn
// ---------------------------------------------------------------------

// Venn gaya naskah Cambridge: semesta ξ berupa persegi panjang, lingkaran
// tipis, nama himpunan italik di luar lingkaran, anggota/angka di daerahnya.
function renderVennSVG(cfg) {
  const hasC = !!(cfg.c && String(cfg.c).trim());
  const W = 300, H = hasC ? 250 : 190;
  const b = kotakBatas();
  let isi = '';
  // Persegi panjang semesta dengan ξ di pojok kiri atas: konvensi Cambridge
  // (S hanya bila pemakai memberi nama sendiri lewat s=...).
  isi += `<rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garisBantu + 0.3}"/>`;
  b.titik(0, 0); b.titik(W, H);
  isi += `<text x="8" y="17" font-size="13" fill="${GAYA.hitam}">${escText(cfg.s || 'ξ')}</text>`;

  const lingkaran = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garisBantu + 0.3}"/>`;
  const isiDaerah = (x, y, val) => (val == null || val === '') ? '' : `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="${GAYA.teks}" text-anchor="middle" fill="${GAYA.hitam}">${escText(val)}</text>`;
  // Nama himpunan italik, di LUAR lingkarannya (pojok atas) — di dalam akan
  // tertukar dengan anggota himpunan.
  const namaHimpunan = (x, y, val, anchor) => (val ? `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="13" font-style="italic" text-anchor="${anchor}" fill="${GAYA.hitam}">${escText(val)}</text>` : '');

  if (!hasC) {
    const r = 66, cy = H / 2 + 6, cxA = W / 2 - 40, cxB = W / 2 + 40;
    isi += lingkaran(cxA, cy, r) + lingkaran(cxB, cy, r);
    isi += namaHimpunan(cxA - r * 0.72, cy - r * 0.78, cfg.a, 'end');
    isi += namaHimpunan(cxB + r * 0.72, cy - r * 0.78, cfg.b, 'start');
    isi += isiDaerah(cxA - 32, cy, cfg.onlyA);
    isi += isiDaerah(cxB + 32, cy, cfg.onlyB);
    isi += isiDaerah(W / 2, cy, cfg.ab);
  } else {
    const r = 60;
    const cxA = W / 2 - 34, cyA = H / 2 - 22;
    const cxB = W / 2 + 34, cyB = cyA;
    const cxC = W / 2, cyC = H / 2 + 38;
    isi += lingkaran(cxA, cyA, r) + lingkaran(cxB, cyB, r) + lingkaran(cxC, cyC, r);
    isi += namaHimpunan(cxA - r * 0.75, cyA - r * 0.75, cfg.a, 'end');
    isi += namaHimpunan(cxB + r * 0.75, cyB - r * 0.75, cfg.b, 'start');
    isi += namaHimpunan(cxC + r * 0.8, cyC + r * 0.8, cfg.c, 'start');
    isi += isiDaerah(cxA - 28, cyA - 12, cfg.onlyA);
    isi += isiDaerah(cxB + 28, cyB - 12, cfg.onlyB);
    isi += isiDaerah(cxC, cyC + 30, cfg.onlyC);
    isi += isiDaerah(W / 2, cyA - 8, cfg.ab);
    isi += isiDaerah((cxA + cxC) / 2 - 12, (cyA + cyC) / 2 + 10, cfg.ac);
    isi += isiDaerah((cxB + cxC) / 2 + 12, (cyB + cyC) / 2 + 10, cfg.bc);
    isi += isiDaerah(W / 2, (2 * cyA + cyC) / 3 + 4, cfg.abc);
  }
  return bungkusGambarSVG(isi, b, false);
}

// ---------------------------------------------------------------------
// 5. Diagram Statistik
// ---------------------------------------------------------------------

// Isian juring/batang tanpa warna, dibedakan pola: putih, abu-abu muda,
// arsir miring, titik-titik, arsir miring balik, abu-abu tua, arsir silang,
// garis mendatar. Id pola unik per gambar karena satu halaman memuat banyak
// SVG inline yang berbagi ruang id. isi(i) mengembalikan atribut fill.
let polaArsirCounter = 0;
function polaArsirSVG() {
  const id = 'pola' + (polaArsirCounter++) + '_';
  const garis = (rot) => `<pattern id="${id}${rot}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(${rot})"><line x1="0" y1="0" x2="0" y2="6" stroke="${GAYA.hitam}" stroke-width="0.9"/></pattern>`;
  const defs = '<defs>' + garis(45) + garis(135) + garis(0) + garis(90)
    + `<pattern id="${id}titik" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.1" fill="${GAYA.hitam}"/></pattern>`
    + `<pattern id="${id}silang" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 0L6 6M6 0L0 6" stroke="${GAYA.hitam}" stroke-width="0.7"/></pattern>`
    + '</defs>';
  const daftar = [
    `fill="${GAYA.putih}"`, `fill="${GAYA.arsir}"`, `fill="url(#${id}45)"`, `fill="url(#${id}titik)"`,
    `fill="url(#${id}135)"`, `fill="#b5b5b5"`, `fill="url(#${id}silang)"`, `fill="url(#${id}0)"`, `fill="url(#${id}90)"`,
  ];
  return { defs, isi: (i) => daftar[i % daftar.length] };
}

function renderStatSVG(cfg) {
  const type = cfg.tipe || 'batang';
  const labels = String(cfg.label || '').split(',').map((s) => s.trim()).filter(Boolean);
  const data = String(cfg.data || '').split(',').map((s) => parseFloat(s.trim()) || 0);

  if (type === 'lingkaran') {
    // Label langsung di juringnya (nama + persen); juring sempit diberi
    // garis penunjuk ke label di luar lingkaran. Juring dibedakan pola
    // arsiran, bukan warna — naskah ujian dicetak hitam-putih.
    const total = data.reduce((a, b) => a + b, 0) || 1;
    const r = 88;
    const luar = [];
    let angle = -Math.PI / 2;
    const juring = data.map((v, i) => {
      const frac = v / total;
      const a1 = angle, a2 = angle + frac * Math.PI * 2;
      angle = a2;
      const pct = Math.round(frac * 1000) / 10;
      return { i, frac, a1, a2, mid: (a1 + a2) / 2, nama: labels[i] || '', pct: pct + '%' };
    });
    // Juring < 9% terlalu sempit untuk dua baris teks: labelnya keluar.
    juring.forEach((j) => { if (j.frac < 0.09) luar.push(j); });
    const lebarLuar = Math.max.apply(null, luar.map((j) => lebarTeksKira(j.nama + ' ' + j.pct)).concat([0]));
    const padX = 16 + (luar.length ? 34 + lebarLuar : 0);
    const cx = padX + r, cy = 16 + r;
    const width = 2 * (padX + r), height = 2 * (16 + r);
    const pola = polaArsirSVG();

    let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width.toFixed(0)} ${height}" xmlns="http://www.w3.org/2000/svg">` + pola.defs;
    juring.forEach((j) => {
      if (j.frac <= 0) return;
      const x1 = cx + r * Math.cos(j.a1), y1 = cy + r * Math.sin(j.a1);
      const x2 = cx + r * Math.cos(j.a2), y2 = cy + r * Math.sin(j.a2);
      const large = j.frac > 0.5 ? 1 : 0;
      const d = j.frac >= 1 - 1e-9
        ? `M${cx},${cy - r} A${r},${r} 0 1 1 ${cx},${cy + r} A${r},${r} 0 1 1 ${cx},${cy - r} Z`
        : `M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z`;
      svg += `<path d="${d}" ${pola.isi(j.i)} stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    });
    juring.forEach((j) => {
      if (j.frac <= 0 || j.frac < 0.09) return;
      const rl = j.frac > 0.25 ? 0.58 : 0.68;
      const lx = cx + r * rl * Math.cos(j.mid), ly = cy + r * rl * Math.sin(j.mid);
      svg += teksHaloSVG(lx, ly - 2, j.nama, { size: GAYA.teks });
      svg += teksHaloSVG(lx, ly + 11, j.pct);
    });
    // Label luar: garis penunjuk dari tepi juring ke samping, ditumpuk
    // berjarak minimal 14 px supaya tidak saling menimpa.
    const kanan = luar.filter((j) => Math.cos(j.mid) >= 0).sort((a, b) => Math.sin(a.mid) - Math.sin(b.mid));
    const kiri = luar.filter((j) => Math.cos(j.mid) < 0).sort((a, b) => Math.sin(a.mid) - Math.sin(b.mid));
    [[kanan, 1], [kiri, -1]].forEach(([grup, arah]) => {
      let prevY = -Infinity;
      grup.forEach((j) => {
        const ex = cx + r * Math.cos(j.mid), ey = cy + r * Math.sin(j.mid);
        let ty = cy + (r + 14) * Math.sin(j.mid);
        if (ty < prevY + 14) ty = prevY + 14;
        prevY = ty;
        const tx = cx + arah * (r + 22);
        svg += `<polyline points="${ex.toFixed(1)},${ey.toFixed(1)} ${(cx + arah * (r + 12)).toFixed(1)},${ty.toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garisBantu}"/>`;
        svg += `<text x="${(tx + arah * 4).toFixed(1)}" y="${(ty + 3.5).toFixed(1)}" font-size="${GAYA.teksKecil}" text-anchor="${arah > 0 ? 'start' : 'end'}" fill="${GAYA.hitam}">${escText(j.nama)} ${escText(j.pct)}</text>`;
      });
    });
    svg += '</svg>';
    return svg;
  }

  // Batang dan garis: sumbu berpanah, angka skala di sumbu y, nama kategori
  // di bawah sumbu x, label "frekuensi" di atas panah y.
  const maxV = Math.max.apply(null, data.concat([1]));
  const yStep = niceStep(maxV);
  const ymax = Math.ceil(maxV / yStep) * yStep;
  const yTicks = [];
  for (let gy = 0; gy <= ymax + 1e-9; gy += yStep) yTicks.push(Math.round(gy * 1e6) / 1e6);
  const yTickW = Math.max.apply(null, yTicks.map((v) => lebarTeksKira(formatTick(v), GAYA.teksKecil)).concat([0]));
  const n = Math.max(data.length, 1);
  const plotW = Math.max(220, Math.min(360, n * 60)), plotH = 200;
  const padL = yTickW + 16, padR = 24, padT = 30, padB = 30;
  const width = padL + plotW + padR, height = padT + plotH + padB;
  const xAxisY = padT + plotH, yAxisX = padL;
  const toY = (v) => xAxisY - (v / (ymax || 1)) * plotH;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width.toFixed(0)} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  yTicks.forEach((gy) => {
    if (gy === 0) return;
    svg += `<line x1="${padL}" y1="${toY(gy).toFixed(1)}" x2="${padL + plotW}" y2="${toY(gy).toFixed(1)}" stroke="${GAYA.abuMuda}" stroke-width="0.6"/>`;
  });

  if (type === 'garis') {
    const stepX = plotW / n;
    const xs = data.map((v, i) => padL + stepX * (i + 0.5));
    let d = '';
    data.forEach((v, i) => { d += (i === 0 ? 'M' : 'L') + xs[i].toFixed(1) + ' ' + toY(v).toFixed(1) + ' '; });
    svg += `<path d="${d}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    data.forEach((v, i) => {
      svg += `<circle cx="${xs[i].toFixed(1)}" cy="${toY(v).toFixed(1)}" r="3" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
      svg += `<line x1="${xs[i].toFixed(1)}" y1="${xAxisY}" x2="${xs[i].toFixed(1)}" y2="${xAxisY + 4}" stroke="${GAYA.hitam}" stroke-width="1"/>`;
      svg += `<text x="${xs[i].toFixed(1)}" y="${xAxisY + 15}" font-size="${GAYA.teksKecil}" text-anchor="middle" fill="${GAYA.hitam}">${escText(labels[i] || '')}</text>`;
      svg += teksHaloSVG(xs[i], toY(v) - 8, formatTick(v));
    });
  } else {
    // Batang abu-abu muda bertepi hitam, bercelah (diagram batang, bukan
    // histogram), nilainya ditulis di atas batang.
    const gap = plotW / n;
    const bw = gap * 0.6;
    data.forEach((v, i) => {
      const x = padL + i * gap + (gap - bw) / 2;
      const y = toY(v);
      svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(xAxisY - y).toFixed(1)}" fill="${GAYA.arsir}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
      svg += `<text x="${(x + bw / 2).toFixed(1)}" y="${xAxisY + 15}" font-size="${GAYA.teksKecil}" text-anchor="middle" fill="${GAYA.hitam}">${escText(labels[i] || '')}</text>`;
      svg += `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="${GAYA.teksKecil}" text-anchor="middle" fill="${GAYA.hitam}">${formatTick(v)}</text>`;
    });
  }

  svg += sumbuALevelSVG({ xAxisY, yAxisX, xFrom: padL, xTo: padL + plotW + 10, yFrom: xAxisY, yTo: padT - 10, labelY: 'frekuensi' });
  yTicks.forEach((gy) => { svg += tickYSVG(yAxisX, toY(gy), formatTick(gy)); });
  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 6. Pohon Faktor
// ---------------------------------------------------------------------

function isPrimeNum(n) {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
}
function smallestFactorNum(n) {
  for (let i = 2; i <= n; i++) if (n % i === 0) return i;
  return n;
}
function buildFactorTreeNode(n) {
  if (isPrimeNum(n)) return { value: n, isPrime: true, children: [] };
  const f = smallestFactorNum(n), rest = n / f;
  return { value: n, isPrime: false, children: [buildFactorTreeNode(f), buildFactorTreeNode(rest)] };
}
function layoutFactorTreeNode(node) {
  let counter = 0;
  function assign(n, depth) {
    n.y = depth;
    if (n.children.length === 0) {
      n.x = counter++;
      return;
    }
    n.children.forEach((c) => assign(c, depth + 1));
    const xs = n.children.map((c) => c.x);
    n.x = (Math.min(...xs) + Math.max(...xs)) / 2;
  }
  assign(node, 0);
  return node;
}

function renderFactorTreeSVG(cfg) {
  const num = Math.max(2, Math.round(numOrDefault(cfg.n, 60)));
  // Blank by default — a worksheet factor tree is meant for the student to
  // fill in themselves; only the starting number is given. Set jawaban=ya
  // to reveal the full worked tree instead (e.g. for a teacher's key).
  const showAnswer = /^(ya|iya|true|1|lengkap)$/i.test(String(cfg.jawaban || ''));
  const root = layoutFactorTreeNode(buildFactorTreeNode(num));
  const nodes = [], edges = [];
  (function walk(n, parent) {
    nodes.push(n);
    if (parent) edges.push([parent, n]);
    n.children.forEach((c) => walk(c, n));
  })(root, null);

  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), maxY = Math.max(...ys);
  const width = 380, pad = 40, stepY = 60;
  const spanX = Math.max(maxX - minX, 1);
  const stepX = Math.max((width - 2 * pad) / spanX, 55);
  const height = pad * 2 + maxY * stepY + 20;
  const px = (x) => pad + (x - minX) * stepX;
  const py = (y) => pad + y * stepY;
  const R = 17;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  edges.forEach(([a, b]) => {
    // Stop each line at the circle's edge (not its center) so it doesn't
    // visibly cut across the — now unfilled — circle outline.
    const ax = px(a.x), ay = py(a.y), bx = px(b.x), by = py(b.y);
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const x1 = ax + ux * R, y1 = ay + uy * R;
    const x2 = bx - ux * R, y2 = by - uy * R;
    svg += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#000000" stroke-width="1.4"/>`;
  });
  nodes.forEach((n) => {
    const isRoot = n === root;
    const reveal = isRoot || showAnswer;
    // Prime vs. composite is only told apart (bold text, thicker ring) once
    // revealed — showing it on a still-blank node would give the answer away.
    const bold = reveal && n.isPrime;
    svg += `<circle cx="${px(n.x).toFixed(1)}" cy="${py(n.y).toFixed(1)}" r="${R}" fill="none" stroke="#000000" stroke-width="${bold ? 2 : 1.2}"/>`;
    if (reveal) {
      svg += `<text x="${px(n.x).toFixed(1)}" y="${(py(n.y) + 4).toFixed(1)}" text-anchor="middle" font-size="12.5" font-weight="${bold ? 700 : 400}" fill="#000000">${n.value}</text>`;
    }
  });
  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 6a2. Pembagian Bersusun (long division)
// ---------------------------------------------------------------------

// Runs the schoolbook long-division algorithm digit by digit and records
// one "step" per dividend digit once the running remainder first reaches
// the divisor — exactly the digits a student would write by hand. Each
// step's remainder already has the next digit folded in (workVal), which
// doubles as the next step's row, matching how it's actually written on
// paper (remainder and brought-down digit share one line).
function computeLongDivision(dividend, divisor) {
  const digits = String(dividend).split('').map(Number);
  const n = digits.length;
  const quotientDigits = new Array(n).fill(null);
  const steps = [];
  let carry = 0, started = false;
  for (let i = 0; i < n; i++) {
    carry = carry * 10 + digits[i];
    if (!started && carry < divisor) continue;
    started = true;
    const q = Math.floor(carry / divisor);
    const product = q * divisor;
    const remainder = carry - product;
    quotientDigits[i] = q;
    steps.push({ col: i, workVal: carry, product, remainder });
    carry = remainder;
  }
  if (!started) {
    // Divisor bigger than the whole dividend (e.g. 3 ÷ 4): quotient is 0,
    // remainder is the dividend itself — still one step, so rendering
    // doesn't need a separate no-steps code path.
    quotientDigits[n - 1] = 0;
    steps.push({ col: n - 1, workVal: carry, product: 0, remainder: carry });
  }
  return { digits, quotientDigits, steps };
}

function renderLongDivisionSVG(cfg) {
  const dividend = Math.max(1, Math.round(Math.abs(numOrDefault(cfg.dividen, 968))));
  const divisor = Math.max(1, Math.round(Math.abs(numOrDefault(cfg.pembagi, 4))));
  // Blank by default, like pohonfaktor — the worked steps are the answer
  // the student fills in; set jawaban=lengkap for a teacher's key.
  const showAnswer = /^(ya|iya|true|1|lengkap)$/i.test(String(cfg.jawaban || ''));

  const { digits, quotientDigits, steps } = computeLongDivision(dividend, divisor);
  const n = digits.length;

  const charW = 20, rh = 30;
  const padTop = 26, padLeft = 22;
  const divisorStr = String(divisor);
  const originX = padLeft + divisorStr.length * 11 + 20;
  const colX = (i) => originX + i * charW;
  const quotY = padTop + 4;
  const lineY = padTop + 18;
  const dividendY = lineY + rh - 8;
  const width = colX(n) + 24;

  const rows = [];
  let yCursor = dividendY;
  steps.forEach((st, k) => {
    yCursor += rh;
    const productRowY = yCursor;
    const ruleY = productRowY + 8;
    yCursor = ruleY + rh;
    const remainderRowY = yCursor;
    const remainderVal = (k + 1 < steps.length) ? steps[k + 1].workVal : st.remainder;
    rows.push({ col: st.col, product: st.product, productRowY, ruleY, remainderVal, remainderRowY });
  });
  const height = yCursor + 22;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;

  svg += `<text x="${padLeft}" y="${dividendY.toFixed(1)}" font-family="monospace" font-size="16" fill="#000000">${escText(divisorStr)}</text>`;
  const bracketX = originX - 10;
  svg += `<line x1="${bracketX.toFixed(1)}" y1="${lineY.toFixed(1)}" x2="${bracketX.toFixed(1)}" y2="${(dividendY + 6).toFixed(1)}" stroke="#000000" stroke-width="1.8"/>`;
  svg += `<line x1="${bracketX.toFixed(1)}" y1="${lineY.toFixed(1)}" x2="${(colX(n) + 4).toFixed(1)}" y2="${lineY.toFixed(1)}" stroke="#000000" stroke-width="1.8"/>`;

  digits.forEach((d, i) => {
    svg += `<text x="${(colX(i) + charW / 2).toFixed(1)}" y="${dividendY.toFixed(1)}" font-family="monospace" font-size="16" text-anchor="middle" fill="#000000">${d}</text>`;
  });

  quotientDigits.forEach((q, i) => {
    if (q === null) return;
    if (showAnswer) {
      svg += `<text x="${(colX(i) + charW / 2).toFixed(1)}" y="${quotY.toFixed(1)}" font-family="monospace" font-size="16" text-anchor="middle" fill="#000000">${q}</text>`;
    } else {
      svg += `<rect x="${(colX(i) + 2).toFixed(1)}" y="${(quotY - 13).toFixed(1)}" width="${charW - 4}" height="16" fill="none" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2,2"/>`;
    }
  });

  rows.forEach((row) => {
    const endX = colX(row.col) + charW;
    const digitCount = Math.max(String(row.product).length, String(row.remainderVal).length);
    const boxW = digitCount * 13 + 4;
    svg += `<text x="${(endX - boxW - 6).toFixed(1)}" y="${row.productRowY.toFixed(1)}" font-family="monospace" font-size="15" fill="#000000">-</text>`;
    if (showAnswer) {
      svg += `<text x="${endX.toFixed(1)}" y="${row.productRowY.toFixed(1)}" font-family="monospace" font-size="15" text-anchor="end" fill="#000000">${row.product}</text>`;
    } else {
      svg += `<rect x="${(endX - boxW).toFixed(1)}" y="${(row.productRowY - 13).toFixed(1)}" width="${boxW.toFixed(1)}" height="16" fill="none" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2,2"/>`;
    }
    svg += `<line x1="${(endX - boxW).toFixed(1)}" y1="${row.ruleY.toFixed(1)}" x2="${endX.toFixed(1)}" y2="${row.ruleY.toFixed(1)}" stroke="#000000" stroke-width="1.2"/>`;
    if (showAnswer) {
      svg += `<text x="${endX.toFixed(1)}" y="${row.remainderRowY.toFixed(1)}" font-family="monospace" font-size="15" text-anchor="end" fill="#000000">${row.remainderVal}</text>`;
    } else {
      svg += `<rect x="${(endX - boxW).toFixed(1)}" y="${(row.remainderRowY - 13).toFixed(1)}" width="${boxW.toFixed(1)}" height="16" fill="none" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2,2"/>`;
    }
  });

  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 6b. Shared arrow helper (fisika, rantai makanan)
// ---------------------------------------------------------------------

function arrowSVG(x1, y1, x2, y2, opts) {
  opts = opts || {};
  const color = opts.color || '#000000';
  const headLen = opts.headLen || 8;
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const perpx = -uy, perpy = ux;
  const bx = x2 - ux * headLen, by = y2 - uy * headLen;
  const p1x = bx + perpx * headLen * 0.5, p1y = by + perpy * headLen * 0.5;
  const p2x = bx - perpx * headLen * 0.5, p2y = by - perpy * headLen * 0.5;
  const dashAttr = opts.dash ? ` stroke-dasharray="${opts.dash}"` : '';
  let s = `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${color}" stroke-width="${opts.strokeWidth || 1.8}"${dashAttr}/>`;
  s += `<polygon points="${x2.toFixed(1)},${y2.toFixed(1)} ${p1x.toFixed(1)},${p1y.toFixed(1)} ${p2x.toFixed(1)},${p2y.toFixed(1)}" fill="${color}"/>`;
  return s;
}

// Draws 1/2/3 parallel lines (single/double/triple bond) between two
// points, shrunk in from each end so they stop short of the atom label
// rather than running under it.
function bondLinesSVG(x1, y1, x2, y2, order, clearance) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux;
  const r = clearance == null ? 13 : clearance;
  const sx1 = x1 + ux * r, sy1 = y1 + uy * r, sx2 = x2 - ux * r, sy2 = y2 - uy * r;
  const offsets = order === 3 ? [-5, 0, 5] : order === 2 ? [-3, 3] : [0];
  let s = '';
  offsets.forEach((off) => {
    s += `<line x1="${(sx1 + nx * off).toFixed(1)}" y1="${(sy1 + ny * off).toFixed(1)}" x2="${(sx2 + nx * off).toFixed(1)}" y2="${(sy2 + ny * off).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
  });
  return s;
}

// ---------------------------------------------------------------------
// 6c. Struktur Lewis (ikatan kimia)
// ---------------------------------------------------------------------

// Pembungkus <svg> untuk gambar kimia/biologi yang viewBox-nya dipotong pas
// ke isi. Tanpa batas ini, CSS (width:100%; max-width: slider "ukuran
// diagram") akan membesarkan gambar kecil seperti CH4 sampai selebar
// kolom sehingga hurufnya raksasa. min() menjaga slider tetap berlaku
// untuk gambar yang lebih lebar dari slider; 1 satuan viewBox = 0,9 pt
// supaya teks 11,5–13 satuan tercetak ≥ 10 pt. Kalau pemakai menulis
// lebar=/lebargambar=, renderDiagramTag yang memasang style-nya, jadi di
// sini tidak dipasang agar atribut style tidak ganda.
function svgPas(width, height, isi, cfg) {
  const w = Math.round(width), h = Math.round(height);
  const adaLebar = cfg && (cfg.lebar || cfg.lebargambar);
  const gaya = adaLebar ? '' : ` style="max-width:min(var(--ws-diagram-width, 260pt), ${Math.round(w * 0.9)}pt)"`;
  return `<svg class="ws-diagram-svg"${gaya} viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${isi}</svg>`;
}

// Koordinat x,y di sini hanya ARAH relatif antar-atom (satuan bebas): jarak
// sebenarnya dihitung ulang di renderLewisSVG dari jari-jari lingkaran
// kulit supaya kedua lingkaran saling tumpang tindih tepat selebar pasangan
// ikatan, seperti diagram dot-and-cross Cambridge. "lone" = jumlah pasangan
// elektron bebas. Senyawa ionik: kation digambar kosong (elektron sudah
// pindah), anion penuh 4 pasangan; "pindah" = banyaknya elektron yang
// berasal dari kation dan digambar dengan lambang kation (titik).
const LEWIS_PRESETS = {
  h2o: {
    atoms: [
      { id: 'O', symbol: 'O', x: 0, y: 0, lone: 2 },
      { id: 'H1', symbol: 'H', x: -1, y: -0.75, lone: 0 },
      { id: 'H2', symbol: 'H', x: 1, y: -0.75, lone: 0 },
    ],
    bonds: [{ a: 'O', b: 'H1', order: 1 }, { a: 'O', b: 'H2', order: 1 }],
  },
  co2: {
    atoms: [
      { id: 'C', symbol: 'C', x: 0, y: 0, lone: 0 },
      { id: 'O1', symbol: 'O', x: -1, y: 0, lone: 2 },
      { id: 'O2', symbol: 'O', x: 1, y: 0, lone: 2 },
    ],
    bonds: [{ a: 'C', b: 'O1', order: 2 }, { a: 'C', b: 'O2', order: 2 }],
  },
  nh3: {
    atoms: [
      { id: 'N', symbol: 'N', x: 0, y: 0, lone: 1 },
      { id: 'H1', symbol: 'H', x: -1, y: 0, lone: 0 },
      { id: 'H2', symbol: 'H', x: 0, y: -1, lone: 0 },
      { id: 'H3', symbol: 'H', x: 1, y: 0, lone: 0 },
    ],
    bonds: [{ a: 'N', b: 'H1', order: 1 }, { a: 'N', b: 'H2', order: 1 }, { a: 'N', b: 'H3', order: 1 }],
  },
  ch4: {
    atoms: [
      { id: 'C', symbol: 'C', x: 0, y: 0, lone: 0 },
      { id: 'H1', symbol: 'H', x: 0, y: 1, lone: 0 },
      { id: 'H2', symbol: 'H', x: 1, y: 0, lone: 0 },
      { id: 'H3', symbol: 'H', x: -1, y: 0, lone: 0 },
      { id: 'H4', symbol: 'H', x: 0, y: -1, lone: 0 },
    ],
    bonds: [
      { a: 'C', b: 'H1', order: 1 }, { a: 'C', b: 'H2', order: 1 },
      { a: 'C', b: 'H3', order: 1 }, { a: 'C', b: 'H4', order: 1 },
    ],
  },
  o2: {
    atoms: [{ id: 'O1', symbol: 'O', x: -1, y: 0, lone: 2 }, { id: 'O2', symbol: 'O', x: 1, y: 0, lone: 2 }],
    bonds: [{ a: 'O1', b: 'O2', order: 2 }],
  },
  n2: {
    atoms: [{ id: 'N1', symbol: 'N', x: -1, y: 0, lone: 1 }, { id: 'N2', symbol: 'N', x: 1, y: 0, lone: 1 }],
    bonds: [{ a: 'N1', b: 'N2', order: 3 }],
  },
  hcl: {
    atoms: [{ id: 'H', symbol: 'H', x: -1, y: 0, lone: 0 }, { id: 'Cl', symbol: 'Cl', x: 1, y: 0, lone: 3 }],
    bonds: [{ a: 'H', b: 'Cl', order: 1 }],
  },
  co: {
    atoms: [{ id: 'C', symbol: 'C', x: -1, y: 0, lone: 1 }, { id: 'O', symbol: 'O', x: 1, y: 0, lone: 1 }],
    bonds: [{ a: 'C', b: 'O', order: 3 }],
  },
  ccl4: {
    atoms: [
      { id: 'C', symbol: 'C', x: 0, y: 0, lone: 0 },
      { id: 'Cl1', symbol: 'Cl', x: 0, y: 1, lone: 3 },
      { id: 'Cl2', symbol: 'Cl', x: 1, y: 0, lone: 3 },
      { id: 'Cl3', symbol: 'Cl', x: -1, y: 0, lone: 3 },
      { id: 'Cl4', symbol: 'Cl', x: 0, y: -1, lone: 3 },
    ],
    bonds: [
      { a: 'C', b: 'Cl1', order: 1 }, { a: 'C', b: 'Cl2', order: 1 },
      { a: 'C', b: 'Cl3', order: 1 }, { a: 'C', b: 'Cl4', order: 1 },
    ],
  },
  c2h4: {
    atoms: [
      { id: 'C1', symbol: 'C', x: -1, y: 0, lone: 0 },
      { id: 'C2', symbol: 'C', x: 1, y: 0, lone: 0 },
      { id: 'H1', symbol: 'H', x: -1.8, y: 0.8, lone: 0 },
      { id: 'H2', symbol: 'H', x: -1.8, y: -0.8, lone: 0 },
      { id: 'H3', symbol: 'H', x: 1.8, y: 0.8, lone: 0 },
      { id: 'H4', symbol: 'H', x: 1.8, y: -0.8, lone: 0 },
    ],
    bonds: [
      { a: 'C1', b: 'C2', order: 2 }, { a: 'C1', b: 'H1', order: 1 }, { a: 'C1', b: 'H2', order: 1 },
      { a: 'C2', b: 'H3', order: 1 }, { a: 'C2', b: 'H4', order: 1 },
    ],
  },
  ch2o: {
    atoms: [
      { id: 'C', symbol: 'C', x: 0, y: 0, lone: 0 },
      { id: 'O', symbol: 'O', x: 0, y: 1, lone: 2 },
      { id: 'H1', symbol: 'H', x: -1, y: -0.6, lone: 0 },
      { id: 'H2', symbol: 'H', x: 1, y: -0.6, lone: 0 },
    ],
    bonds: [{ a: 'C', b: 'O', order: 2 }, { a: 'C', b: 'H1', order: 1 }, { a: 'C', b: 'H2', order: 1 }],
  },
  nacl: {
    ionic: true,
    atoms: [
      { id: 'Na', symbol: 'Na', x: -1, y: 0, lone: 0, charge: '+', bracket: true },
      { id: 'Cl', symbol: 'Cl', x: 1, y: 0, lone: 4, charge: String.fromCharCode(8722), bracket: true, pindah: 1 },
    ],
    bonds: [],
  },
  mgo: {
    ionic: true,
    atoms: [
      { id: 'Mg', symbol: 'Mg', x: -1, y: 0, lone: 0, charge: '2+', bracket: true },
      { id: 'O', symbol: 'O', x: 1, y: 0, lone: 4, charge: '2' + String.fromCharCode(8722), bracket: true, pindah: 2 },
    ],
    bonds: [],
  },
};

// Satu elektron gaya dot-and-cross: titik untuk atom "pemilik" pertama,
// silang untuk atom pasangannya. Keduanya hitam — yang membedakan asal
// elektron adalah bentuknya, bukan warna, supaya tetap terbaca saat difotokopi.
function elektronSVG(x, y, silang) {
  if (!silang) return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="${GAYA.hitam}"/>`;
  const h = 2.7;
  return `<path d="M${(x - h).toFixed(1)} ${(y - h).toFixed(1)} L${(x + h).toFixed(1)} ${(y + h).toFixed(1)} M${(x - h).toFixed(1)} ${(y + h).toFixed(1)} L${(x + h).toFixed(1)} ${(y - h).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.3" fill="none"/>`;
}

// Kurung siku [ ] mengelilingi ion, digambar sebagai garis (bukan huruf)
// supaya tingginya pas dengan lingkaran kulit dan tidak bergantung font.
function kurungIonSVG(px, py, r) {
  const t = r + 7, k = 5;
  let s = `<path d="M${(px - t + k).toFixed(1)} ${(py - t).toFixed(1)} L${(px - t).toFixed(1)} ${(py - t).toFixed(1)} L${(px - t).toFixed(1)} ${(py + t).toFixed(1)} L${(px - t + k).toFixed(1)} ${(py + t).toFixed(1)}" fill="none" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
  s += `<path d="M${(px + t - k).toFixed(1)} ${(py - t).toFixed(1)} L${(px + t).toFixed(1)} ${(py - t).toFixed(1)} L${(px + t).toFixed(1)} ${(py + t).toFixed(1)} L${(px + t - k).toFixed(1)} ${(py + t).toFixed(1)}" fill="none" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
  return s;
}

// Memilih k arah pasangan bebas dari daftar kandidat. Urutan penilaian:
// (1) jarak sudut terkecil ke ikatan dan ke sesama pasangan sebesar
// mungkin, (2) resultan arah pasangan sejajar/berlawanan dengan resultan
// ikatan (simetris), (3) sebanyak mungkin arah sejajar sumbu, (4) menjauhi
// ikatan. Kombinasi maksimal C(8,4) = 70, jadi murah.
function pilihArahPasanganBebas(ikatan, k, kandidat, jarakSudut) {
  if (!k) return [];
  const bx = ikatan.reduce((s, t) => s + Math.cos(t), 0), by = ikatan.reduce((s, t) => s + Math.sin(t), 0);
  let terbaik = null;
  // Perbandingan leksikografis: kriteria pertama yang berbeda yang menentukan.
  const lebihBaik = (baru, lama) => {
    for (let i = 0; i < baru.length; i++) if (baru[i] !== lama[i]) return baru[i] > lama[i];
    return false;
  };
  const coba = (mulai, pilihan) => {
    if (pilihan.length === k) {
      let minD = Infinity;
      pilihan.forEach((p, i) => {
        ikatan.forEach((t) => { minD = Math.min(minD, jarakSudut(p, t)); });
        pilihan.forEach((q, j) => { if (j > i) minD = Math.min(minD, jarakSudut(p, q)); });
      });
      const lx = pilihan.reduce((s, t) => s + Math.cos(t), 0), ly = pilihan.reduce((s, t) => s + Math.sin(t), 0);
      const silang = Math.abs(lx * by - ly * bx);
      const searah = lx * bx + ly * by;
      // Arah sejajar sumbu (4 kandidat pertama) lebih disukai daripada
      // diagonal supaya CO2 tergambar dengan pasangan bebas atas-bawah.
      const sejajarSumbu = pilihan.filter((t) => kandidat.indexOf(t) < 4).length;
      const skor = [Math.round(minD * 1000), -Math.round(silang * 1000), sejajarSumbu, -Math.round(searah * 1000)];
      if (!terbaik || lebihBaik(skor, terbaik.skor)) terbaik = { skor, pilihan: pilihan.slice() };
      return;
    }
    for (let i = mulai; i < kandidat.length; i++) coba(i + 1, pilihan.concat(kandidat[i]));
  };
  coba(0, []);
  return terbaik ? terbaik.pilihan : [];
}

// Diagram dot-and-cross ala Cambridge 9701: tiap atom = lingkaran kulit
// terluar tipis abu-abu dengan simbol di tengah; lingkaran dua atom yang
// berikatan saling tumpang tindih dan pasangan ikatan (titik + silang)
// duduk di daerah tumpang tindih itu. Tidak ada garis ikatan — di diagram
// jenis ini ikatan justru ditunjukkan oleh elektron yang dipakai bersama.
function renderLewisSVG(cfg) {
  const preset = LEWIS_PRESETS[String(cfg.molekul || 'h2o').toLowerCase()] || LEWIS_PRESETS.h2o;
  const atomMap = {};
  preset.atoms.forEach((a) => { atomMap[a.id] = a; });
  const jari = (a) => (a.symbol === 'H' ? 20 : 27);
  const TUMPANG = 12; // lebar daerah tumpang tindih dua kulit (px)

  // Tata letak ulang: mulai dari atom pertama, tiap tetangga diletakkan pada
  // ARAH preset tapi pada jarak (rA + rB - TUMPANG) supaya tumpang tindihnya
  // seragam untuk semua ikatan, apa pun angka koordinat presetnya.
  const pos = {};
  const tanda = {}; // 0 = titik, 1 = silang (pewarnaan dua-warna sepanjang ikatan)
  const first = preset.atoms[0];
  pos[first.id] = [0, 0];
  tanda[first.id] = 0;
  const antrean = [first.id];
  while (antrean.length) {
    const cur = antrean.shift();
    (preset.bonds || []).forEach((bd) => {
      if (bd.a !== cur && bd.b !== cur) return;
      const other = bd.a === cur ? bd.b : bd.a;
      if (pos[other]) return;
      const a = atomMap[cur], b = atomMap[other];
      const dx = b.x - a.x, dy = -(b.y - a.y), len = Math.hypot(dx, dy) || 1;
      const d = jari(a) + jari(b) - TUMPANG;
      pos[other] = [pos[cur][0] + (dx / len) * d, pos[cur][1] + (dy / len) * d];
      tanda[other] = 1 - tanda[cur];
      antrean.push(other);
    });
  }
  // Atom yang tidak terikat (ion): berjajar mendatar dengan celah untuk kurung.
  let xIon = 0;
  preset.atoms.forEach((a) => {
    if (pos[a.id]) return;
    const placed = preset.atoms.filter((p) => pos[p.id]);
    if (placed.length) {
      const last = placed[placed.length - 1];
      xIon = pos[last.id][0] + jari(last) + jari(a) + 40;
    }
    pos[a.id] = [xIon, 0];
    tanda[a.id] = 1;
  });

  // kosong=ya: hanya kulit dan simbol (murid melengkapi elektronnya).
  // bebas=tidak: tanpa pasangan bebas. ekstra=ya: satu elektron berlebih di sisi
  // luar atom tepi. Dua yang terakhir untuk pilihan jawaban pengecoh.
  const kosong = /^(ya|true|1)$/i.test(String(cfg.kosong || ''));
  const tanpaBebas = /^(tidak|false|0)$/i.test(String(cfg.bebas || ''));
  const ekstra = /^(ya|true|1)$/i.test(String(cfg.ekstra || ''));
  let body = '';
  // Kulit terluar dulu supaya elektron tercetak di atas garis lingkaran.
  preset.atoms.forEach((a) => {
    const [px, py] = pos[a.id];
    body += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${jari(a)}" fill="none" stroke="${GAYA.abu}" stroke-width="${GAYA.garisBantu}"/>`;
  });

  // Pasangan ikatan di daerah tumpang tindih: titik milik atom a, silang
  // milik atom b (atau sebaliknya, mengikuti pewarnaan dua-warna).
  (kosong ? [] : preset.bonds || []).forEach((bd) => {
    const a = atomMap[bd.a], b = atomMap[bd.b];
    const [ax, ay] = pos[a.id], [bx, by] = pos[b.id];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
    const pusatLensa = (len - jari(b) + jari(a)) / 2;
    const order = bd.order || 1;
    const geser = order === 3 ? [-9, 0, 9] : order === 2 ? [-6, 6] : [0];
    geser.forEach((g) => {
      const mx = ax + ux * pusatLensa + nx * g, my = ay + uy * pusatLensa + ny * g;
      body += elektronSVG(mx - ux * 2.9, my - uy * 2.9, tanda[a.id] === 1);
      body += elektronSVG(mx + ux * 2.9, my + uy * 2.9, tanda[b.id] === 1);
    });
  });

  const sudutIkatan = (a) => (preset.bonds || [])
    .filter((bd) => bd.a === a.id || bd.b === a.id)
    .map((bd) => {
      const o = pos[bd.a === a.id ? bd.b : bd.a], p = pos[a.id];
      return Math.atan2(o[1] - p[1], o[0] - p[0]);
    });
  const KANDIDAT = [0, Math.PI / 2, Math.PI, -Math.PI / 2, Math.PI / 4, (3 * Math.PI) / 4, -Math.PI / 4, (-3 * Math.PI) / 4];
  const jarakSudut = (a1, a2) => {
    const d = Math.abs(a1 - a2) % (2 * Math.PI);
    return Math.min(d, 2 * Math.PI - d);
  };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  preset.atoms.forEach((a) => {
    const [px, py] = pos[a.id];
    const r = jari(a);
    const ext = a.bracket ? r + 22 : r + 3;
    minX = Math.min(minX, px - ext); maxX = Math.max(maxX, px + ext);
    minY = Math.min(minY, py - ext); maxY = Math.max(maxY, py + ext);

    if (a.bracket) body += kurungIonSVG(px, py, r);
    body += `<text x="${px.toFixed(1)}" y="${(py + (r > 20 ? 5 : 4.5)).toFixed(1)}" text-anchor="middle" font-size="${r > 20 ? 13 : 11.5}" font-weight="700" fill="${GAYA.hitam}">${escText(a.symbol)}</text>`;
    if (a.charge) {
      body += `<text x="${(px + r + 9).toFixed(1)}" y="${(py - r - 2).toFixed(1)}" font-size="${GAYA.teks}" fill="${GAYA.hitam}">${escText(a.charge)}</text>`;
    }

    // Pasangan bebas di lingkaran kulit. Semua kombinasi arah (8 arah,
    // maksimal 4 pasangan) dinilai: jarak sudut terkecil ke ikatan/pasangan
    // lain sebesar mungkin, lalu yang simetris terhadap arah ikatan (CO2:
    // atas-bawah, H2O: keduanya di seberang H) — seperti gambar buku.
    const terpakai = sudutIkatan(a);
    const arahLone = kosong || tanpaBebas ? [] : pilihArahPasanganBebas(terpakai, a.lone || 0, KANDIDAT, jarakSudut);
    if (ekstra && !kosong && terpakai.length === 1) {
      const tepi = terpakai[0] + Math.PI;                    // sisi yang membelakangi atom pusat
      body += elektronSVG(px + Math.cos(tepi) * r, py + Math.sin(tepi) * r, false);
    }
    let sisaTitik = a.pindah || 0; // elektron pindahan (ionik) digambar titik
    arahLone.forEach((ang) => {
      const lx = px + Math.cos(ang) * r, ly = py + Math.sin(ang) * r;
      const tx = -Math.sin(ang), ty = Math.cos(ang);
      [-3.6, 3.6].forEach((t) => {
        const silang = sisaTitik > 0 ? false : tanda[a.id] === 1;
        if (sisaTitik > 0) sisaTitik--;
        body += elektronSVG(lx + tx * t, ly + ty * t, silang);
      });
    });
  });

  const pad = 8;
  const width = maxX - minX + 2 * pad, height = maxY - minY + 2 * pad;
  return svgPas(width, height, `<g transform="translate(${(pad - minX).toFixed(1)},${(pad - minY).toFixed(1)})">${body}</g>`, cfg);
}

// ---------------------------------------------------------------------
// 6d. Rangkaian Hidrokarbon
// ---------------------------------------------------------------------

// "2:2,4:3" -> [{pos:2,val:'2'},{pos:4,val:'3'}]
function parsePosValCommaList(raw) {
  if (!raw) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    const idx = part.indexOf(':');
    return { pos: parseInt(idx > -1 ? part.slice(0, idx) : part, 10), val: idx > -1 ? part.slice(idx + 1).trim() : '' };
  });
}

// "CH3" -> "CH₃", "C2H5" -> "C₂H₅": angka sesudah huruf/kurung tutup pada
// rumus dijadikan subskrip Unicode supaya label cabang tercetak seperti di
// buku tanpa perlu <tspan> bertingkat.
const SUBSKRIP = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉' };
function subskripRumus(s) {
  return String(s || '').replace(/([A-Za-z)])(\d+)/g, (_, huruf, angka) => huruf + angka.split('').map((c) => SUBSKRIP[c] || c).join(''));
}

// Rumus struktur tampilan (displayed formula) gaya naskah A-Level: semua
// atom C sejajar mendatar, ikatan rangkap dua/tiga sebagai garis sejajar,
// H dan cabang di atas/bawah tiap C (dan di ujung rantai untuk C terminal).
// Bukan zig-zag: soal 9701 tentang isomer/penamaan memakai bentuk ini
// karena setiap ikatan dan atom harus terlihat.
function renderHydrocarbonSVG(cfg) {
  const n = Math.max(1, Math.min(12, Math.round(numOrDefault(cfg.rantai, 4))));
  const bondOrder = {};
  parsePosValCommaList(cfg.ikatan).forEach(({ pos, val }) => {
    bondOrder[pos] = Math.max(1, Math.min(3, parseInt(val, 10) || 1));
  });
  const branchesByPos = {};
  let labelTerpanjang = 0;
  parsePosValCommaList(cfg.cabang).forEach(({ pos, val }) => {
    if (!branchesByPos[pos]) branchesByPos[pos] = [];
    if (val) {
      branchesByPos[pos].push(subskripRumus(val));
      labelTerpanjang = Math.max(labelTerpanjang, val.length);
    }
  });

  // Jarak antar-C melebar kalau ada label cabang panjang di C bersebelahan.
  const step = Math.max(46, labelTerpanjang * 7 + 16);
  const used = new Array(n + 2).fill(0);
  for (let i = 1; i < n; i++) {
    const order = bondOrder[i] || 1;
    used[i] += order;
    used[i + 1] += order;
  }
  Object.keys(branchesByPos).forEach((posStr) => {
    const p = parseInt(posStr, 10);
    if (p >= 1 && p <= n) used[p] += branchesByPos[posStr].length;
  });

  const FONT = 13;
  let body = '';
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const catat = (x, y, halfW, halfH) => {
    minX = Math.min(minX, x - halfW); maxX = Math.max(maxX, x + halfW);
    minY = Math.min(minY, y - halfH); maxY = Math.max(maxY, y + halfH);
  };
  const teks = (x, y, s, anchor, size) => {
    const ukuran = size || FONT;
    body += `<text x="${x.toFixed(1)}" y="${(y + ukuran * 0.36).toFixed(1)}" text-anchor="${anchor || 'middle'}" font-size="${ukuran}" fill="${GAYA.hitam}">${escText(s)}</text>`;
    const w = s.length * ukuran * 0.6;
    catat(anchor === 'start' ? x + w / 2 : anchor === 'end' ? x - w / 2 : x, y, w / 2, ukuran * 0.55);
  };

  for (let i = 1; i < n; i++) {
    body += bondLinesSVG((i - 1) * step, 0, i * step, 0, bondOrder[i] || 1, 9);
  }

  // Arah slot: [dx, dy, jarakUjungIkatan, jarakTeks, anchor]. Atas/bawah
  // dulu, lalu sisi luar (hanya C ujung), diagonal hanya cadangan kalau
  // valensi yang diminta pemakai melebihi empat.
  const ATAS = [0, -1, 20, 30, 'middle'], BAWAH = [0, 1, 20, 30, 'middle'];
  const KIRI = [-1, 0, 20, 24, 'end'], KANAN = [1, 0, 20, 24, 'start'];
  const DIAG = [[0.71, -0.71, 22, 32, 'start'], [-0.71, -0.71, 22, 32, 'end'], [0.71, 0.71, 22, 32, 'start'], [-0.71, 0.71, 22, 32, 'end']];

  for (let i = 1; i <= n; i++) {
    const cx = (i - 1) * step, cy = 0;
    const slots = [ATAS, BAWAH];
    if (i === 1) slots.push(KIRI);
    if (i === n) slots.push(KANAN);
    slots.push(...DIAG);
    const cabang = branchesByPos[i] || [];
    const hCount = Math.max(0, 4 - used[i]);
    const isi = cabang.map((c) => ({ label: c, size: FONT - 1 })).concat(new Array(hCount).fill(0).map(() => ({ label: 'H', size: FONT })));
    isi.forEach((item, k) => {
      const s = slots[Math.min(k, slots.length - 1)];
      const ex = cx + s[0] * s[2], ey = cy + s[1] * s[2];
      body += `<line x1="${(cx + s[0] * 9).toFixed(1)}" y1="${(cy + s[1] * 9).toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
      teks(cx + s[0] * s[3], cy + s[1] * s[3], item.label, s[4], item.size);
    });
    teks(cx, cy, 'C');
  }

  const pad = 6;
  const width = maxX - minX + 2 * pad, height = maxY - minY + 2 * pad;
  return svgPas(width, height, `<g transform="translate(${(pad - minX).toFixed(1)},${(pad - minY).toFixed(1)})">${body}</g>`, cfg);
}

// ---------------------------------------------------------------------
// 6e. Dinamika Partikel / Hukum Newton (diagram gaya)
// ---------------------------------------------------------------------

// "W:20:270|N:20:90" -> [{label:'W',magnitude:20,angle:270}, ...]
function parseForceList(raw) {
  if (!raw) return [];
  return String(raw).split('|').map((s) => s.trim()).filter(Boolean).map((part) => {
    const bits = part.split(':').map((s) => s.trim());
    const m = besarGaya(bits[1]);
    return { label: bits[0] || '', magnitude: m.nilai, teks: m.teks, angle: parseFloat(bits[2]) || 0 };
  });
}

// Besar gaya: angka biasa atau bentuk akar ("10\\sqrt{3}", "30√3", "20 sqrt(2)"). Teksnya
// ditulis apa adanya dengan √ (jangan dibuang akarnya: gambar harus sama dengan soal),
// nilai numeriknya dipakai hanya untuk panjang panah relatif.
function besarGaya(raw) {
  const t = String(raw == null ? '' : raw).trim();
  const norm = t.replace(/\\sqrt\s*\{\s*([\d.]+)\s*\}/g, '√$1').replace(/\\?sqrt\s*\(\s*([\d.]+)\s*\)/g, '√$1').replace(/\\sqrt\s*([\d.]+)/g, '√$1').replace(/\s*\\?cdot\s*|\s*\*\s*/g, '');
  const m = norm.match(/^(\d+(?:[.,]\d+)?)?\s*√\s*(\d+(?:\.\d+)?)$/);
  if (m) return { nilai: (m[1] ? parseFloat(m[1].replace(',', '.')) : 1) * Math.sqrt(parseFloat(m[2])), teks: (m[1] || '') + '√' + m[2] };
  const v = parseFloat(norm.replace(',', '.'));
  return { nilai: v, teks: isFinite(v) ? String(norm) : '' };
}

// Arsiran tumpuan: garis-garis pendek miring di sisi bawah garis permukaan
// (konvensi gambar teknik/fisika untuk lantai atau bidang miring). (ux,uy)
// arah garis permukaan, (nx,ny) normal yang menjauhi benda.
function arsirTumpuanSVG(x1, y1, x2, y2, nx, ny) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  // arah arsir: 45° dari normal, condong berlawanan arah garis
  const hx = (nx - ux) / Math.SQRT2, hy = (ny - uy) / Math.SQRT2;
  let s = '';
  for (let d = 8; d < len - 2; d += 9) {
    const px = x1 + ux * d, py = y1 + uy * d;
    s += `<line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${(px + hx * 8).toFixed(1)}" y2="${(py + hy * 8).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="0.8"/>`;
  }
  return s;
}

const norm0 = (a) => ((a % 360) + 360) % 360;
function renderForceDiagramSVG(cfg) {
  // Digambar dalam kerangka berpusat di benda, lalu dipotong pas ke apa
  // yang benar-benar tergambar: kanvas tetap 340x300 yang lama sebagian
  // besar kosong, sehingga gambar tercetak kecil di tengah ruang putih.
  const titik = String(cfg.bentuk || '').toLowerCase() === 'titik';
  const boxSize = titik ? 0 : 64;
  const cx = 0, cy = 0;
  const objek = cfg.objek || (titik ? 'O' : 'Benda');
  const forces = parseForceList(cfg.gaya);
  // sudutBidang: memiringkan garis permukaan untuk bidang miring — bentuk
  // soal Hukum Newton yang sangat umum dan tidak bisa diwakili lantai datar.
  // Kotak benda tetap tegak (diagram benda bebas mengisolasi benda; sudut
  // gaya tetap dalam kerangka 0-360 mutlak), jadi ini hanya mengubah garis
  // tumpuannya.
  const inclineDeg = numOrDefault(cfg.sudutBidang, 0);

  const parts = [];
  const bounds = [];
  const cover = (x1, y1, x2, y2) => bounds.push([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]);
  const textW = (t) => String(t).length * 6.6;

  // Bentuk "titik": gaya-gaya konkuren dari satu titik pangkal O, dengan
  // sumbu X/Y sebagai acuan sudut — dipakai utk soal "gaya-gaya pada satu
  // titik" (bukan diagram benda bebas berkotak).
  if (titik) {
    if (cfg.sumbu !== 'tidak') {
      const axisLen = 95;
      parts.push(arrowSVG(-axisLen, 0, axisLen, 0, { strokeWidth: GAYA.garisBantu, color: '#8a93a3' }));
      parts.push(arrowSVG(0, axisLen, 0, -axisLen, { strokeWidth: GAYA.garisBantu, color: '#8a93a3' }));
      // Gaya yang searah sumbu positif memakai ujung sumbu itu: huruf X/Y digeser ke
      // samping garis gayanya supaya tidak tertimpa anak panah.
      const searahX = forces.some((f) => Math.abs(norm0(f.angle)) < 1e-6), searahY = forces.some((f) => Math.abs(norm0(f.angle) - 90) < 1e-6);
      parts.push(`<text x="${(axisLen + 6).toFixed(1)}" y="${searahX ? 17 : 4}" font-size="${GAYA.teksKecil}" fill="#8a93a3">X</text>`);
      parts.push(`<text x="${searahY ? 7 : -5}" y="${(-axisLen - (searahY ? 0 : 6)).toFixed(1)}" font-size="${GAYA.teksKecil}" fill="#8a93a3" text-anchor="${searahY ? 'start' : 'middle'}">Y</text>`);
      cover(-axisLen - 4, -axisLen - 14, axisLen + 14, axisLen + 4);
    }
    parts.push(`<circle cx="0" cy="0" r="3.2" fill="${GAYA.hitam}"/>`);
    parts.push(`<text x="-8" y="16" text-anchor="end" font-size="${GAYA.teks}" font-weight="700" fill="${GAYA.hitam}">${escText(objek)}</text>`);
    cover(-8 - textW(objek), -4, 4, 16);
  } else if (cfg.permukaan !== 'tanpa') {
    const rad = (inclineDeg * Math.PI) / 180;
    const halfLen = 120;
    // Kotak tetap tegak, jadi permukaan miring akan memotong sudut bawah
    // kotak: garis diturunkan secukupnya sampai lolos dari sudut itu.
    const gy = cy + boxSize / 2 + 14 + Math.abs(Math.tan(rad)) * (boxSize / 2);
    const x1 = cx - halfLen, x2 = cx + halfLen;
    const y1 = gy + Math.tan(rad) * halfLen, y2 = gy - Math.tan(rad) * halfLen;
    parts.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`);
    // arsiran tumpuan di sisi yang menjauhi benda
    const nx = -Math.sin(rad), ny = Math.cos(rad); // normal ke bawah (SVG) untuk garis miring
    parts.push(arsirTumpuanSVG(x1, y1, x2, y2, nx, ny));
    cover(x1, y1, x2, y2);
    cover(x1 + nx * 8, y1 + ny * 8, x2 + nx * 8, y2 + ny * 8);
    if (inclineDeg) {
      // sudut kemiringan ditandai busur kecil di kaki bidang miring
      parts.push(`<path d="M${(x1 + 30).toFixed(1)},${y1.toFixed(1)} A30,30 0 0 1 ${(x1 + 30 * Math.cos(rad)).toFixed(1)},${(y1 - 30 * Math.sin(rad)).toFixed(1)}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garisBantu}"/>`);
      parts.push(`<text x="${(x1 + 38).toFixed(1)}" y="${(y1 - 6).toFixed(1)}" font-size="${GAYA.teksKecil}" fill="${GAYA.hitam}">${inclineDeg}°</text>`);
      cover(x1 + 30, y1 - 18, x1 + 38 + textW(inclineDeg + '°'), y1);
    }
  }

  if (!titik) {
    parts.push(`<rect x="${(cx - boxSize / 2).toFixed(1)}" y="${(cy - boxSize / 2).toFixed(1)}" width="${boxSize}" height="${boxSize}" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`);
    parts.push(`<text x="${cx.toFixed(1)}" y="${(cy + 4.5).toFixed(1)}" text-anchor="middle" font-size="${GAYA.teks}" font-weight="700" fill="${GAYA.hitam}">${escText(objek)}</text>`);
    cover(cx - boxSize / 2, cy - boxSize / 2, cx + boxSize / 2, cy + boxSize / 2);
  }

  // Panjang panah mengikuti besar gaya RELATIF terhadap gaya terbesar di
  // gambar (45–110 px), supaya "F1:40 vs F2:20" terlihat 2:1, bukan dua
  // panah yang hampir sama panjang.
  const maxMag = forces.reduce((m, f) => (isFinite(f.magnitude) ? Math.max(m, Math.abs(f.magnitude)) : m), 0);
  const norm = (a) => ((a % 360) + 360) % 360;

  // Gaya searah ("F1:40:0|F2:20:0" — dua dorongan ke kanan) dulu digambar
  // bertumpuk, labelnya juga, sehingga tercetak jadi "F2F120" yang tak
  // terbaca. Gaya segaris dikelompokkan dan dikipas ke samping, masing-
  // masing dengan panah dan labelnya sendiri.
  const groups = [];
  forces.forEach((f) => {
    const a = norm(f.angle);
    let g = groups.find((g) => Math.min(Math.abs(g.angle - a), 360 - Math.abs(g.angle - a)) <= 4);
    if (!g) { g = { angle: a, items: [] }; groups.push(g); }
    g.items.push(f);
  });

  // Label yang sudah dipasang, untuk menggeser label berikutnya yang
  // menabraknya (mis. gaya 90° dan 60° yang labelnya bertemu di atas kotak).
  const labelBoxes = [];
  let nSudut = 0;                       // pengurut jari-jari busur sudut (mode titik)
  const tabrak = (b) => labelBoxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);

  groups.forEach((g) => {
    const n = g.items.length;
    g.items.forEach((f, i) => {
      const rad = (f.angle * Math.PI) / 180;
      const dirx = Math.cos(rad), diry = -Math.sin(rad);
      const off = (i - (n - 1) / 2) * 18;
      const ox = -diry * off, oy = dirx * off;
      const len = maxMag > 0 && isFinite(f.magnitude) ? 45 + 65 * (Math.abs(f.magnitude) / maxMag) : 70;
      const startR = boxSize / 2 + 3;
      const x1 = cx + dirx * startR + ox, y1 = cy + diry * startR + oy;
      const x2 = x1 + dirx * len, y2 = y1 + diry * len;
      parts.push(arrowSVG(x1, y1, x2, y2, { strokeWidth: GAYA.garis }));
      cover(x1, y1, x2, y2);

      // Sudut gaya digambar sebagai busur + nilainya (kecuali gaya yang searah
      // sumbu, atau sudut=tidak): soal vektor tanpa sudut tidak bisa dikerjakan.
      // Mode titik: dari sumbu X positif (ke atas = berlawanan jarum jam, ke bawah
      // = searah jarum jam, nilai sudut lancipnya); benda berkotak: dari garis
      // mendatar di pangkal panah.
      const aMut = norm(f.angle);
      const sejajarSumbu = Math.abs(((aMut % 90) + 90) % 90) < 1e-6;
      if (String(cfg.sudut || '').toLowerCase() !== 'tidak' && !sejajarSumbu) {
        const ref = titik ? 0 : (dirx >= 0 ? 0 : 180);
        let d = aMut - ref; d = ((d + 540) % 360) - 180;                     // selisih bertanda (-180,180]
        if (titik && aMut > 180) d = aMut - 360;                              // titik: ke bawah = searah jarum jam dari +X
        else if (titik) d = aMut;
        const px = titik ? 0 : x1, py = titik ? 0 : y1;
        const r = (titik ? 24 : 20) + (titik ? 9 : 0) * nSudut++;
        const t0 = (ref * Math.PI) / 180, t1 = ((ref + d) * Math.PI) / 180, tm = ((ref + d / 2) * Math.PI) / 180;
        if (!titik) parts.push(`<line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${(px + Math.cos(t0) * (r + 12)).toFixed(1)}" y2="${(py - Math.sin(t0) * (r + 12)).toFixed(1)}" stroke="${GAYA.abu}" stroke-width="${GAYA.garisBantu}" stroke-dasharray="${GAYA.putusHalus}"/>`);
        parts.push(`<path d="M${(px + r * Math.cos(t0)).toFixed(1)} ${(py - r * Math.sin(t0)).toFixed(1)} A${r} ${r} 0 0 ${d > 0 ? 0 : 1} ${(px + r * Math.cos(t1)).toFixed(1)} ${(py - r * Math.sin(t1)).toFixed(1)}" fill="none" stroke="${GAYA.hitam}" stroke-width="1"/>`);
        const nilai = String(Math.round(Math.abs(d) * 100) / 100).replace('.', ',') + '°';
        let rl = r + 10 + nilai.length * 1.5;
        let lxA = px + rl * Math.cos(tm), lyA = py - rl * Math.sin(tm) + 3.5;
        const kotakA = () => { const w = textW(nilai); return [lxA - w / 2, lyA - 10, lxA + w / 2, lyA + 3]; };
        for (let k = 0; k < 4 && tabrak(kotakA()); k++) { rl += 9; lxA = px + rl * Math.cos(tm); lyA = py - rl * Math.sin(tm) + 3.5; }
        parts.push(`<text x="${lxA.toFixed(1)}" y="${lyA.toFixed(1)}" text-anchor="middle" font-size="${GAYA.teksKecil}" fill="${GAYA.hitam}" stroke="${GAYA.putih}" stroke-width="2.4" paint-order="stroke">${escText(nilai)}</text>`);
        const bA = kotakA(); labelBoxes.push(bA); cover(bA[0], bA[1], bA[2], bA[3]);
        cover(px - r, py - r, px + r, py + r);
      }

      const magTxt = f.teks ? ` = ${f.teks} N` : '';
      const label = `${f.label}${magTxt}`;
      const vertical = Math.abs(dirx) < 0.3;
      let lx, ly, anchor;
      if (vertical && n > 1) {
        // Panah tegak berjajar: label di samping ujung, kiri/kanan panahnya
        // sendiri, supaya tidak saling menindih.
        anchor = off >= 0 ? 'start' : 'end';
        lx = x2 + (off >= 0 ? 7 : -7); ly = y2 + diry * 6 + 4;
      } else if (vertical) {
        anchor = 'middle'; lx = x2; ly = y2 + diry * 14 + 4;
      } else {
        anchor = dirx > 0 ? 'start' : 'end';
        lx = x2 + dirx * 7; ly = y2 + diry * 7 + 4;
      }
      const w = textW(label);
      let box = () => { const tx1 = anchor === 'start' ? lx : anchor === 'end' ? lx - w : lx - w / 2; return [tx1, ly - 11, tx1 + w, ly + 3]; };
      // dorong menjauhi kotak sepanjang arah panah sampai lepas dari label lain
      for (let k = 0; k < 6 && tabrak(box()); k++) { lx += dirx * 12; ly += diry * 12; }
      parts.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" font-size="${GAYA.teks}" fill="${GAYA.hitam}">${escText(label)}</text>`);
      const b = box();
      labelBoxes.push(b);
      cover(b[0], b[1], b[2], b[3]);
    });
  });

  const pad = 12;
  const minX = Math.min(...bounds.map((b) => b[0])) - pad;
  const minY = Math.min(...bounds.map((b) => b[1])) - pad;
  const maxX = Math.max(...bounds.map((b) => b[2])) + pad;
  const maxY = Math.max(...bounds.map((b) => b[3])) + pad;
  const width = maxX - minX, height = maxY - minY;

  let svg = `<svg class="ws-diagram-svg" viewBox="${minX.toFixed(1)} ${minY.toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="${(minX + 0.5).toFixed(1)}" y="${(minY + 0.5).toFixed(1)}" width="${(width - 1).toFixed(1)}" height="${(height - 1).toFixed(1)}" fill="#ffffff" stroke="#d8dce1"/>`;
  svg += parts.join('');
  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 6e1b. Sistem katrol & benda terhubung (dinamika Newton)
// ---------------------------------------------------------------------

// Kotak benda, boleh diputar (dipakai di permukaan miring) — sisi x2 adalah
// sisi yang "menempel" ke permukaan (jadi kotaknya digambar DI LUAR garis
// permukaan, bukan menembusnya).
function kotakBendaSVG(cx, cy, w, h, label, rotasiDerajat) {
  const rot = rotasiDerajat ? ` transform="rotate(${rotasiDerajat.toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)})"` : '';
  let s = `<g${rot}><rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - h / 2).toFixed(1)}" width="${w}" height="${h}" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  s += `<text x="${cx.toFixed(1)}" y="${(cy + 4).toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${GAYA.hitam}">${escText(label)}</text></g>`;
  return s;
}

function katrolSVG(cx, cy, r) {
  r = r || 10;
  return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.4"/>`
    + `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="1.6" fill="${GAYA.hitam}"/>`;
}

// "1" -> "m1": nama benda yang cuma angka dibaca sebagai nomor massa, sehingga
// keterangannya "m1 = 4 kg", bukan "1 = 4 kg".
function namaBenda(l) {
  const t = String(l == null ? '' : l).trim();
  return /^\d+$/.test(t) ? 'm' + t : t;
}

// "F = 12 N:210" -> { label:'F = 12 N', sudut:210 }. Sudut = arah gaya terhadap
// layar: 0 = ke kanan, 90 = ke atas, 180 = ke kiri, 270 (atau -90) = ke bawah.
function parseGayaLuar(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return null;
  const i = t.lastIndexOf(':');
  if (i < 0) return { label: t, sudut: 0 };
  const a = parseFloat(t.slice(i + 1).replace(',', '.'));
  return { label: t.slice(0, i).trim(), sudut: isFinite(a) ? a : 0 };
}

// Gaya luar yang ditarikkan pada kotak berpusat (cx,cy): panah keluar dari tepi
// kotak ke arah gaya, labelnya di ujung panah.
function gayaLuarSVG(raw, cx, cy, setengah, b, panjang) {
  const g = parseGayaLuar(raw);
  if (!g) return '';
  const rad = (g.sudut * Math.PI) / 180, dx = Math.cos(rad), dy = -Math.sin(rad);
  const k = setengah / Math.max(Math.abs(dx), Math.abs(dy), 1e-6);
  const x1 = cx + dx * k, y1 = cy + dy * k, L = panjang || 42, x2 = x1 + dx * L, y2 = y1 + dy * L;
  let s = arrowSVG(x1, y1, x2, y2, { strokeWidth: 1.6, headLen: 8 });
  b.titik(x1, y1); b.titik(x2, y2);
  if (g.label) {
    const pos = letakTeksLuar(x2, y2, dx, dy, 6, GAYA.teks);
    s += teksGeoSVG(pos, g.label, GAYA.teks, false, true);
    b.teks(pos.x, pos.y, g.label, GAYA.teks, pos.anchor);
  }
  return s;
}

// Katrol di meja/bidang miring (sudut=0 -> meja datar) + beban tergantung.
// Benda A di atas permukaan (meja/bidang miring), tali lewat katrol di ujung
// atas permukaan itu, lalu tegak lurus turun ke benda B yang menggantung.
// Konvensi "licin" (tanpa gesekan) ditulis di dekat permukaannya kalau
// cfg.licin bukan "tidak" — hampir semua soal katrol+bidang miring di
// naskah ujian memang mengasumsikan licin, jadi itu baku (bukan tulisan
// gesekan, yang jauh lebih jarang dipakai di level ini).
function renderInclinePulleySVG(cfg) {
  const sudutDerajat = numOrDefault(cfg.sudut, 30);
  const rad = (sudutDerajat * Math.PI) / 180;
  const labelAtas = namaBenda(cfg.labelAtas || 'A');
  const labelBawah = namaBenda(cfg.labelBawah || 'B');
  const massaAtas = cfg.massaAtas != null ? String(cfg.massaAtas).trim() : '';
  const massaBawah = cfg.massaBawah != null ? String(cfg.massaBawah).trim() : '';
  const licin = String(cfg.licin || 'ya').toLowerCase() !== 'tidak';

  const baseWidth = 175, groundY = 190;
  const inclineHeight = baseWidth * Math.tan(rad);
  const A0 = [0, groundY], A1 = [baseWidth, groundY], Apex = [baseWidth, groundY - inclineHeight];

  const b = kotakBatas();
  let isi = '';

  // Baji (wedge): alas - sisi tegak kanan - sisi miring, arsiran di alas
  // menandai benda itu tertambat ke tanah (konvensi gambar teknik).
  isi += `<polygon points="${A0.join(',')} ${A1.join(',')} ${Apex.join(',')}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  isi += arsirTumpuanSVG(A0[0], A0[1], A1[0], A1[1], 0, 1);
  b.titik(A0[0], A0[1]); b.titik(A1[0], A1[1] + 10); b.titik(Apex[0], Apex[1]);

  if (sudutDerajat > 0) {
    const busurR = 26;
    isi += `<path d="M${(A0[0] + busurR).toFixed(1)} ${A0[1].toFixed(1)} A${busurR} ${busurR} 0 0 1 ${(A0[0] + busurR * Math.cos(rad)).toFixed(1)} ${(A0[1] - busurR * Math.sin(rad)).toFixed(1)}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garisBantu}"/>`;
    const posSudut = { x: A0[0] + busurR + 14, y: A0[1] - 6, anchor: 'start' };
    isi += teksGeoSVG(posSudut, `${sudutDerajat}°`, GAYA.teks);
    b.teks(posSudut.x, posSudut.y, `${sudutDerajat}°`, GAYA.teks, 'start');
  }

  // Benda A: dudukannya di tengah sisi miring, diputar supaya alasnya rata
  // dengan permukaan (sisi miring A0->Apex "naik" ke kanan, jadi kotaknya
  // diputar -sudutDerajat — SVG rotate() searah jarum jam untuk sudut positif).
  const fA = 0.5;
  const titikA = [A0[0] + fA * (Apex[0] - A0[0]), A0[1] + fA * (Apex[1] - A0[1])];
  const normalA = [-Math.sin(rad), -Math.cos(rad)]; // menjauhi baji (ke atas-kiri)
  const boxA = 36;
  const pusatA = [titikA[0] + normalA[0] * boxA / 2, titikA[1] + normalA[1] * boxA / 2];
  // Tali dari benda A ke katrol: SEJAJAR permukaan, setinggi garis tengah benda
  // (setengah tinggi kotak dari permukaan) dan menyinggung puncak katrol, seperti
  // gambar buku. Katrol berjari-jari seperempat sisi kotak duduk di sudut permukaan.
  const rKat = boxA / 4;
  const pKat = [Apex[0] + normalA[0] * rKat, Apex[1] + normalA[1] * rKat];
  const arahLereng = [Math.cos(rad), -Math.sin(rad)];
  const taliA1 = [titikA[0] + normalA[0] * (boxA / 2) + arahLereng[0] * (boxA / 2), titikA[1] + normalA[1] * (boxA / 2) + arahLereng[1] * (boxA / 2)];
  const taliA2 = [Apex[0] + normalA[0] * (boxA / 2), Apex[1] + normalA[1] * (boxA / 2)];
  isi += `<line x1="${taliA1[0].toFixed(1)}" y1="${taliA1[1].toFixed(1)}" x2="${taliA2[0].toFixed(1)}" y2="${taliA2[1].toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
  isi += `<line x1="${Apex[0].toFixed(1)}" y1="${Apex[1].toFixed(1)}" x2="${pKat[0].toFixed(1)}" y2="${pKat[1].toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
  isi += kotakBendaSVG(pusatA[0], pusatA[1], boxA, boxA, labelAtas, -sudutDerajat);
  b.titik(pusatA[0] + normalA[0] * boxA, pusatA[1] + normalA[1] * boxA);
  b.titik(pusatA[0] - normalA[0] * boxA * 0.3, pusatA[1] - normalA[1] * boxA * 0.3);
  isi += gayaLuarSVG(cfg.gayaluar, pusatA[0], pusatA[1], boxA / 2, b);
  if (massaAtas) {
    // di sisi menjauhi permukaan (normal), bukan ke arah katrol: di sana ada tali
    const posM = letakTeksLuar(pusatA[0], pusatA[1], normalA[0], normalA[1], boxA / 2 + 6);
    isi += teksGeoSVG(posM, `${labelAtas} = ${massaAtas} kg`, GAYA.teks);
    b.teks(posM.x, posM.y, `${labelAtas} = ${massaAtas} kg`, GAYA.teks, posM.anchor);
  }

  // Katrol di puncak, tali tegak turun ke benda B yang menggantung.
  isi += katrolSVG(pKat[0], pKat[1], rKat);
  b.titik(pKat[0], pKat[1] - rKat - 3);
  const boxB = 32;
  const taliPanjang = 60;
  const xTali = pKat[0] + rKat;                       // tali tegak dari tepi kanan katrol
  const pusatB = [xTali, pKat[1] + taliPanjang + boxB / 2];
  isi += `<line x1="${xTali.toFixed(1)}" y1="${pKat[1].toFixed(1)}" x2="${xTali.toFixed(1)}" y2="${(pusatB[1] - boxB / 2).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
  isi += kotakBendaSVG(pusatB[0], pusatB[1], boxB, boxB, labelBawah, 0);
  b.titik(pusatB[0] + boxB / 2 + 55, pusatB[1] + boxB / 2);
  if (massaBawah) {
    const posM = letakTeksLuar(pusatB[0], pusatB[1], 1, 0, boxB / 2 + 10);
    isi += teksGeoSVG(posM, `${labelBawah} = ${massaBawah} kg`, GAYA.teks);
    b.teks(posM.x, posM.y, `${labelBawah} = ${massaBawah} kg`, GAYA.teks, posM.anchor);
  }

  // tinggi=10 m: jarak beban yang menggantung ke lantai (meja datar saja).
  if (cfg.tinggi && sudutDerajat === 0) {
    const bawahB = pusatB[1] + boxB / 2, lantai = bawahB + 46, xd = pusatB[0] - boxB / 2 - 14;
    isi += `<line x1="${(pusatB[0] - 70).toFixed(1)}" y1="${lantai.toFixed(1)}" x2="${(pusatB[0] + 70).toFixed(1)}" y2="${lantai.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    isi += arsirTumpuanSVG(pusatB[0] - 70, lantai, pusatB[0] + 70, lantai, 0, 1);
    const tengah = (bawahB + lantai) / 2;
    isi += arrowSVG(xd, tengah, xd, lantai, { headLen: 6, strokeWidth: 1.2 }) + arrowSVG(xd, tengah, xd, bawahB, { headLen: 6, strokeWidth: 1.2 });
    const posH = { x: xd - 6, y: tengah + 4, anchor: 'end' };
    isi += teksGeoSVG(posH, String(cfg.tinggi), GAYA.teks, false, true);
    b.teks(posH.x, posH.y, String(cfg.tinggi), GAYA.teks, 'end');
    b.titik(pusatB[0] - 70, lantai + 10); b.titik(pusatB[0] + 70, lantai + 10);
  }

  if (licin) {
    // Ditaruh di seperempat pertama lereng (dekat dasar), menjauhi benda A
    // yang duduk di tengah lereng supaya labelnya tidak bertumpuk.
    const fL = 0.22;
    const titikL = [A0[0] + fL * (Apex[0] - A0[0]), A0[1] + fL * (Apex[1] - A0[1])];
    const posL = { x: titikL[0] + normalA[0] * 14, y: titikL[1] + normalA[1] * 14, anchor: 'middle' };
    isi += teksGeoSVG(posL, 'licin', GAYA.teksKecil, true);
    b.teks(posL.x, posL.y, 'licin', GAYA.teksKecil, 'middle');
  }

  return bungkusGambarSVG(isi, b, false);
}

// Katrol sederhana (Atwood): katrol digantung di langit-langit (massa
// diabaikan), dua beban P/Q tergantung simetris di kedua ujung talinya —
// beda dari katrol+bidang miring di atas yang salah satu sisinya mendatar.
function renderAtwoodSVG(cfg) {
  const labelKiri = namaBenda(cfg.labelKiri || 'P');
  const labelKanan = namaBenda(cfg.labelKanan || 'Q');
  const massaKiri = cfg.massaKiri != null ? String(cfg.massaKiri).trim() : '';
  const massaKanan = cfg.massaKanan != null ? String(cfg.massaKanan).trim() : '';
  const taliKiri = String(cfg.labelTaliKiri || 'T1').trim();
  const taliKanan = String(cfg.labelTaliKanan || 'T2').trim();

  const ceilingY = 10, cx = 90, pulleyY = 52, pulleyR = 17;
  const lebarCeiling = 90, dropLen = 84, sebar = pulleyR; // tali tegak lurus dari tepi katrol: beban tepat di bawah tepi kiri/kanan katrol

  const b = kotakBatas();
  let isi = '';

  // Langit-langit: garis mendatar dengan arsiran di atasnya (tertambat tetap).
  isi += `<line x1="${(cx - lebarCeiling / 2).toFixed(1)}" y1="${ceilingY.toFixed(1)}" x2="${(cx + lebarCeiling / 2).toFixed(1)}" y2="${ceilingY.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  isi += arsirTumpuanSVG(cx - lebarCeiling / 2, ceilingY, cx + lebarCeiling / 2, ceilingY, 0, -1);
  b.titik(cx - lebarCeiling / 2, ceilingY - 10); b.titik(cx + lebarCeiling / 2, ceilingY - 10);

  // Gantungan katrol ke langit-langit.
  isi += `<line x1="${cx.toFixed(1)}" y1="${ceilingY.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${(pulleyY - pulleyR).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
  isi += katrolSVG(cx, pulleyY, pulleyR);

  // Tali dari tepi katrol turun ke tiap beban.
  const xKiri = cx - sebar, xKanan = cx + sebar;
  const yBeban = pulleyY + dropLen;
  isi += `<line x1="${xKiri.toFixed(1)}" y1="${pulleyY.toFixed(1)}" x2="${xKiri.toFixed(1)}" y2="${yBeban.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
  isi += `<line x1="${xKanan.toFixed(1)}" y1="${pulleyY.toFixed(1)}" x2="${xKanan.toFixed(1)}" y2="${yBeban.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
  const posT1 = letakTeksLuar(xKiri, (pulleyY + yBeban) / 2, -1, 0, 6);
  isi += teksGeoSVG(posT1, taliKiri, GAYA.teks);
  b.teks(posT1.x, posT1.y, taliKiri, GAYA.teks, posT1.anchor);
  const posT2 = letakTeksLuar(xKanan, (pulleyY + yBeban) / 2, 1, 0, 6);
  isi += teksGeoSVG(posT2, taliKanan, GAYA.teks);
  b.teks(posT2.x, posT2.y, taliKanan, GAYA.teks, posT2.anchor);

  const boxSisi = 28;                   // lebih sempit dari jarak tali (2 x jari-jari katrol) supaya kedua beban tak bersentuhan
  isi += kotakBendaSVG(xKiri, yBeban + boxSisi / 2, boxSisi, boxSisi, labelKiri, 0);
  isi += kotakBendaSVG(xKanan, yBeban + boxSisi / 2, boxSisi, boxSisi, labelKanan, 0);
  b.titik(xKiri - boxSisi / 2 - 50, yBeban + boxSisi);
  b.titik(xKanan + boxSisi / 2 + 50, yBeban + boxSisi);
  // gayaluar=label:sudut — gaya luar pada beban kanan (gayapada=kiri untuk beban kiri).
  if (cfg.gayaluar) {
    const kiri = String(cfg.gayapada || 'kanan').toLowerCase() === 'kiri';
    isi += gayaLuarSVG(cfg.gayaluar, kiri ? xKiri : xKanan, yBeban + boxSisi / 2, boxSisi / 2, b);
  }
  if (massaKiri) {
    const pos = letakTeksLuar(xKiri, yBeban + boxSisi / 2, -1, 0, boxSisi / 2 + 8);
    isi += teksGeoSVG(pos, `${labelKiri} = ${massaKiri} kg`, GAYA.teks);
    b.teks(pos.x, pos.y, `${labelKiri} = ${massaKiri} kg`, GAYA.teks, pos.anchor);
  }
  if (massaKanan) {
    const pos = letakTeksLuar(xKanan, yBeban + boxSisi / 2, 1, 0, boxSisi / 2 + 8);
    isi += teksGeoSVG(pos, `${labelKanan} = ${massaKanan} kg`, GAYA.teks);
    b.teks(pos.x, pos.y, `${labelKanan} = ${massaKanan} kg`, GAYA.teks, pos.anchor);
  }

  return bungkusGambarSVG(isi, b, false);
}

// Dua beban digantung BERURUTAN (satu tali dari satu ke yang lain, bukan
// dua tali terpisah dari satu titik seperti Atwood) di dalam lift yang
// bergerak dengan percepatan a — soal tegangan tali dalam kerangka
// noninersial. Lift digambar sebagai bingkai sederhana, panah percepatan di
// luar bingkai supaya tidak tertukar dengan tali di dalamnya.
function renderLiftSVG(cfg) {
  const labelAtas = namaBenda(cfg.labelAtas || 'A');
  const labelBawah = namaBenda(cfg.labelBawah || 'B');
  const massaAtas = cfg.massaAtas != null ? String(cfg.massaAtas).trim() : '';
  const massaBawah = cfg.massaBawah != null ? String(cfg.massaBawah).trim() : '';
  const arah = String(cfg.arah || 'atas').toLowerCase() === 'bawah' ? 'bawah' : 'atas';

  const liftW = 170, liftTopY = 14, liftBottomY = 230, cx = 90;
  const b = kotakBatas();
  let isi = '';

  // Bingkai lift (atap + dua dinding, bawah terbuka — cukup untuk konteks).
  isi += `<line x1="${(cx - liftW / 2).toFixed(1)}" y1="${liftTopY.toFixed(1)}" x2="${(cx + liftW / 2).toFixed(1)}" y2="${liftTopY.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  isi += `<line x1="${(cx - liftW / 2).toFixed(1)}" y1="${liftTopY.toFixed(1)}" x2="${(cx - liftW / 2).toFixed(1)}" y2="${liftBottomY.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  isi += `<line x1="${(cx + liftW / 2).toFixed(1)}" y1="${liftTopY.toFixed(1)}" x2="${(cx + liftW / 2).toFixed(1)}" y2="${liftBottomY.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  b.titik(cx - liftW / 2, liftTopY); b.titik(cx + liftW / 2, liftBottomY);

  // Beban A tergantung dari atap, beban B tergantung dari A (satu tali sambung).
  const boxSisi = 34;
  const yA = liftTopY + 55, yB = yA + 70;
  isi += `<line x1="${cx.toFixed(1)}" y1="${liftTopY.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${(yA - boxSisi / 2).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
  isi += kotakBendaSVG(cx, yA, boxSisi, boxSisi, labelAtas, 0);
  isi += `<line x1="${cx.toFixed(1)}" y1="${(yA + boxSisi / 2).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${(yB - boxSisi / 2).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
  isi += kotakBendaSVG(cx, yB, boxSisi, boxSisi, labelBawah, 0);

  if (massaAtas) {
    const pos = letakTeksLuar(cx, yA, 1, 0, boxSisi / 2 + 8);
    isi += teksGeoSVG(pos, `${labelAtas} = ${massaAtas} kg`, GAYA.teks);
    b.teks(pos.x, pos.y, `${labelAtas} = ${massaAtas} kg`, GAYA.teks, pos.anchor);
  }
  if (massaBawah) {
    const pos = letakTeksLuar(cx, yB, 1, 0, boxSisi / 2 + 8);
    isi += teksGeoSVG(pos, `${labelBawah} = ${massaBawah} kg`, GAYA.teks);
    b.teks(pos.x, pos.y, `${labelBawah} = ${massaBawah} kg`, GAYA.teks, pos.anchor);
  }

  // Panah percepatan lift, DI LUAR bingkai (kiri), arah sesuai cfg.arah.
  const xPanah = cx - liftW / 2 - 28, yMid = (liftTopY + liftBottomY) / 2;
  if (arah === 'atas') isi += arrowSVG(xPanah, yMid + 24, xPanah, yMid - 24, { headLen: 9 });
  else isi += arrowSVG(xPanah, yMid - 24, xPanah, yMid + 24, { headLen: 9 });
  const posA = letakTeksLuar(xPanah, yMid - 24 * (arah === 'atas' ? 1 : -1), -1, 0, 6);
  isi += teksGeoSVG(posA, 'a', GAYA.teks, true);
  b.teks(posA.x, posA.y, 'a', GAYA.teks, posA.anchor);
  b.titik(xPanah - 10, yMid);

  return bungkusGambarSVG(isi, b, false);
}

// Beberapa balok berjajar di atas permukaan datar, disambung tali
// (T1, T2, ...) berurutan, ditarik satu gaya F di ujung paling kanan — pola
// khas soal "tiga balok dihubungkan tali, hitung percepatan & tegangan".
function renderBeratBerurutanSVG(cfg) {
  const daftar = String(cfg.massa || 'm1:2,m2:3,m3:5').split(',').map((s) => s.trim()).filter(Boolean)
    .map((tok) => { const bits = tok.split(':').map((s) => s.trim()); return { label: bits[0], nilai: bits[1] }; });
  const labelGaya = String(cfg.gaya || 'F').trim();
  const licin = String(cfg.licin || 'ya').toLowerCase() !== 'tidak';
  // sisi=kanan (default): balok PERTAMA di daftar dikenai gaya tarik dan duduk
  // paling dekat F di kanan; sisi=kiri: gaya mendorong dari kiri. sudut = arah
  // gaya (0 mendatar, 37 ke atas-kanan, -37 ke bawah-kanan). kontak=ya: balok
  // berimpitan tanpa tali.
  const dariKiri = String(cfg.sisi || 'kanan').toLowerCase() === 'kiri';
  const kontak = /^(ya|true|1)$/i.test(String(cfg.kontak || ''));
  const sudutF = numOrDefault(cfg.sudut, 0);
  const massa = dariKiri ? daftar : daftar.slice().reverse();

  const groundY = 110, boxSisi = 40, gap = kontak ? boxSisi : 70, mulaiX = dariKiri ? 120 : 50;
  const panjangF = 56;
  const b = kotakBatas();
  let isi = '';

  const xs = massa.map((_, i) => mulaiX + i * gap);
  const kiriX = xs[0] - boxSisi / 2 - (dariKiri ? 78 : 30), kananX = xs[xs.length - 1] + boxSisi / 2 + (dariKiri ? 30 : 78);
  isi += `<line x1="${kiriX.toFixed(1)}" y1="${groundY.toFixed(1)}" x2="${kananX.toFixed(1)}" y2="${groundY.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  isi += arsirTumpuanSVG(kiriX, groundY, kananX, groundY, 0, 1);
  b.titik(kiriX, groundY + 10); b.titik(kananX, groundY + 10);

  const cy = groundY - boxSisi / 2;
  massa.forEach((m, i) => {
    isi += kotakBendaSVG(xs[i], cy, boxSisi, boxSisi, namaBenda(m.label), 0);
    if (m.nilai) {
      const pos = letakTeksLuar(xs[i], cy, 0, -1, boxSisi / 2 + 8);
      isi += teksGeoSVG(pos, `${m.nilai} kg`, GAYA.teksKecil);
      b.teks(pos.x, pos.y, `${m.nilai} kg`, GAYA.teksKecil, pos.anchor);
    }
    if (i < massa.length - 1 && !kontak) {
      const x1 = xs[i] + boxSisi / 2, x2 = xs[i + 1] - boxSisi / 2;
      isi += `<line x1="${x1.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
      const pos = letakTeksLuar((x1 + x2) / 2, cy, 0, -1, 7);
      isi += teksGeoSVG(pos, `T${i + 1}`, GAYA.teks);
      b.teks(pos.x, pos.y, `T${i + 1}`, GAYA.teks, pos.anchor);
    }
  });

  const rad = (sudutF * Math.PI) / 180, dx = Math.cos(rad), dy = -Math.sin(rad);
  let x1, y1, x2, y2;
  if (dariKiri) {                      // dorong: ujung panah menyentuh sisi kiri balok pertama
    x2 = xs[0] - boxSisi / 2; y2 = cy; x1 = x2 - dx * panjangF; y1 = y2 - dy * panjangF;
  } else {                             // tarik: pangkal panah di sisi kanan balok pertama
    x1 = xs[xs.length - 1] + boxSisi / 2; y1 = cy; x2 = x1 + dx * panjangF; y2 = y1 + dy * panjangF;
  }
  isi += arrowSVG(x1, y1, x2, y2, { headLen: 9, strokeWidth: 1.8 });
  b.titik(x1, y1); b.titik(x2, y2);
  const ujung = dariKiri ? [x1, y1, -dx, -dy] : [x2, y2, dx, dy];
  const posF = letakTeksLuar(ujung[0], ujung[1], ujung[2], ujung[3], 8, GAYA.teks);
  isi += teksGeoSVG(posF, labelGaya, GAYA.teks, true, true);
  b.teks(posF.x, posF.y, labelGaya, GAYA.teks, posF.anchor);

  if (licin) {
    const pos = letakTeksLuar(kiriX + 15, groundY, 0, 1, 14);
    isi += teksGeoSVG(pos, 'licin', GAYA.teksKecil, true);
    b.teks(pos.x, pos.y, 'licin', GAYA.teksKecil, pos.anchor);
  }

  return bungkusGambarSVG(isi, b, false);
}

// Dua bidang miring bertemu di satu puncak (bentuk "tenda"), katrol di
// puncaknya, satu benda di tiap sisi disambung satu tali — beda dari
// katrol+bidang miring tunggal di atas yang satu sisinya menggantung lurus;
// di sini KEDUA sisi adalah permukaan miring (sudut boleh beda kiri-kanan).
function renderDoubleInclineSVG(cfg) {
  const sudutKiri = numOrDefault(cfg.sudutKiri, 37), sudutKanan = numOrDefault(cfg.sudutKanan, 53);
  const radKiri = (sudutKiri * Math.PI) / 180, radKanan = (sudutKanan * Math.PI) / 180;
  const labelKiri = String(cfg.labelKiri || 'm1').trim(), labelKanan = String(cfg.labelKanan || 'm2').trim();
  const massaKiri = cfg.massaKiri != null ? String(cfg.massaKiri).trim() : '';
  const massaKanan = cfg.massaKanan != null ? String(cfg.massaKanan).trim() : '';
  const licin = String(cfg.licin || 'ya').toLowerCase() !== 'tidak';

  const tinggi = 120, apexY = 20, groundY = apexY + tinggi;
  const apexXTengah = 150;
  const Apex = [apexXTengah, apexY];
  const BL = [apexXTengah - tinggi / Math.tan(radKiri), groundY];
  const BR = [apexXTengah + tinggi / Math.tan(radKanan), groundY];

  const b = kotakBatas();
  let isi = '';

  isi += `<polygon points="${BL.join(',')} ${BR.join(',')} ${Apex.join(',')}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  isi += arsirTumpuanSVG(BL[0], BL[1], BR[0], BR[1], 0, 1);
  b.titik(BL[0], BL[1] + 10); b.titik(BR[0], BR[1] + 10); b.titik(Apex[0], Apex[1] - 14);

  // Sudut di tiap kaki.
  [[BL, radKiri, sudutKiri, 1], [BR, radKanan, sudutKanan, -1]].forEach(([titik, rad, derajat, arahX]) => {
    const busurR = 24;
    const x1 = titik[0] + arahX * busurR, y1 = titik[1];
    const x2 = titik[0] + arahX * busurR * Math.cos(rad), y2 = titik[1] - busurR * Math.sin(rad);
    const sweep = arahX > 0 ? 1 : 0;
    isi += `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${busurR} ${busurR} 0 0 ${sweep} ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garisBantu}"/>`;
    const pos = { x: titik[0] + arahX * (busurR + 16), y: titik[1] - 6, anchor: 'middle' };
    isi += teksGeoSVG(pos, `${derajat}°`, GAYA.teks);
    b.teks(pos.x, pos.y, `${derajat}°`, GAYA.teks, 'middle');
  });

  const boxSisi = 32;
  const sisiInfo = [
    { base: BL, rad: radKiri, arahX: 1, label: labelKiri, massa: massaKiri, rotasi: (r) => -((r * 180) / Math.PI) },
    { base: BR, rad: radKanan, arahX: -1, label: labelKanan, massa: massaKanan, rotasi: (r) => (r * 180) / Math.PI },
  ];
  sisiInfo.forEach(({ base, rad, arahX, label, massa, rotasi }) => {
    const f = 0.45;
    const titik = [base[0] + f * (Apex[0] - base[0]), base[1] + f * (Apex[1] - base[1])];
    // Normal menjauhi baji: komponen x searah arahX (menjauhi pusat), y ke atas.
    const normal = [arahX * Math.sin(rad), -Math.cos(rad)];
    const pusat = [titik[0] + normal[0] * boxSisi / 2, titik[1] + normal[1] * boxSisi / 2];
    const taliUjung = [titik[0] + normal[0] * boxSisi * 0.35, titik[1] + normal[1] * boxSisi * 0.35];
    isi += `<line x1="${taliUjung[0].toFixed(1)}" y1="${taliUjung[1].toFixed(1)}" x2="${Apex[0].toFixed(1)}" y2="${Apex[1].toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
    isi += kotakBendaSVG(pusat[0], pusat[1], boxSisi, boxSisi, label, rotasi(rad));
    b.titik(pusat[0] + normal[0] * boxSisi, pusat[1] + normal[1] * boxSisi);
    if (massa) {
      const pos = letakTeksLuar(pusat[0], pusat[1], -normal[1] * arahX, normal[0] * arahX, boxSisi / 2 + 10);
      isi += teksGeoSVG(pos, `${label} = ${massa} kg`, GAYA.teksKecil);
      b.teks(pos.x, pos.y, `${label} = ${massa} kg`, GAYA.teksKecil, pos.anchor);
    }
  });

  isi += katrolSVG(Apex[0], Apex[1], 9);
  b.titik(Apex[0], Apex[1] - 11);

  if (licin) {
    const pos = { x: Apex[0], y: groundY + 16, anchor: 'middle' };
    isi += teksGeoSVG(pos, 'licin', GAYA.teksKecil, true);
    b.teks(pos.x, pos.y, 'licin', GAYA.teksKecil, 'middle');
  }

  return bungkusGambarSVG(isi, b, false);
}

// ---------------------------------------------------------------------
// 6e2. Rangkaian Listrik (seri / paralel / campuran)
// ---------------------------------------------------------------------

// "R1:10" -> {name:'R1', value:10}
// Every component symbol a school-level circuit question needs. The key is
// what the author writes after the colon; ALIASES map the English spellings
// onto the same symbol so either language works.
const CIRCUIT_KINDS = {
  resistor: 'resistor', hambatan: 'resistor',
  lampu: 'lampu', lamp: 'lampu', bohlam: 'lampu',
  saklar: 'saklar', switch: 'saklar', 'saklar-buka': 'saklar',
  'saklar-tutup': 'saklarTutup', 'switch-closed': 'saklarTutup',
  amperemeter: 'amperemeter', ammeter: 'amperemeter', ampermeter: 'amperemeter',
  voltmeter: 'voltmeter',
  geser: 'geser', rheostat: 'geser', 'hambatan-geser': 'geser', variabel: 'geser',
  termistor: 'termistor', thermistor: 'termistor',
  ldr: 'ldr',
  dioda: 'dioda', diode: 'dioda', led: 'led',
  kapasitor: 'kapasitor', capacitor: 'kapasitor',
  motor: 'motor',
  sekring: 'sekring', fuse: 'sekring'
};

// "R1:10" (a resistor of 10 Ω, the original and still the default form),
// "S1:saklar" (a symbol with no value), or "R1:geser:20" (both).
function parseCircuitComponent(str) {
  const parts = String(str).split(':').map((s) => s.trim());
  const name = parts[0] || 'R';
  let kind = 'resistor';
  let valueRaw = parts[1];
  if (parts[1] && CIRCUIT_KINDS[parts[1].toLowerCase()]) {
    kind = CIRCUIT_KINDS[parts[1].toLowerCase()];
    valueRaw = parts[2];
  }
  const v = parseFloat(valueRaw);
  return { name, kind, value: isFinite(v) ? v : NaN };
}

// General "susunan" DSL: series blocks joined by "+", with a parenthesised
// "(A|B|C)" group standing for those components wired in parallel with
// each other — e.g. "R1:10+(R2:20|R3:30)+R4:15" is R1 in series with a
// two-branch parallel group, in series with R4. Splitting on "+" has to
// respect paren depth so it doesn't cut a parallel group in half.
function parseCircuitSusunan(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const tokens = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === '+' && depth === 0) { tokens.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) tokens.push(cur);
  return tokens.map((t) => {
    t = t.trim();
    if (t.startsWith('(') && t.endsWith(')')) {
      return { type: 'parallel', comps: t.slice(1, -1).split('|').map(parseCircuitComponent) };
    }
    return { type: 'series', comp: parseCircuitComponent(t) };
  });
}

// IEC-style resistor (a plain rectangle, not a zigzag) matching what
// Indonesian textbooks use, with short lead wires on each side so it drops
// cleanly into any horizontal wire span.
// Unit shown beside a component's value, by symbol. Anything not listed
// carries no value at all (a switch has no ohms).
const CIRCUIT_UNITS = { resistor: ' Ω', geser: ' Ω', termistor: ' Ω', ldr: ' Ω', kapasitor: ' μF', lampu: ' W' };

function circuitLabel(comp) {
  const unit = CIRCUIT_UNITS[comp.kind];
  return comp.name + (unit && isFinite(comp.value) ? ' = ' + comp.value + unit : '');
}

// Draws one component in the slot between x1 and x2 at height y: leads in
// from both sides, symbol centred, label above.
function componentSVG(x1, y, x2, comp) {
  const kind = comp.kind || 'resistor';
  if (kind === 'resistor') return resistorSVG(x1, y, x2, circuitLabel(comp));

  const cx = (x1 + x2) / 2;
  const label = circuitLabel(comp);
  const S = (a, b, c, d, w) => `<line x1="${a.toFixed(1)}" y1="${b.toFixed(1)}" x2="${c.toFixed(1)}" y2="${d.toFixed(1)}" stroke="#000000" stroke-width="${w || 1.6}"/>`;
  let bodyHalf = 12;
  let out = '';
  let labelY = y - 18;

  if (kind === 'lampu' || kind === 'amperemeter' || kind === 'voltmeter' || kind === 'motor') {
    const r = 11;
    bodyHalf = r;
    out += `<circle cx="${cx.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="#ffffff" stroke="#000000" stroke-width="1.6"/>`;
    if (kind === 'lampu') {
      const k = r * 0.7;
      out += S(cx - k, y - k, cx + k, y + k);
      out += S(cx - k, y + k, cx + k, y - k);
    } else {
      const letter = kind === 'amperemeter' ? 'A' : kind === 'voltmeter' ? 'V' : 'M';
      out += `<text x="${cx.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#000000">${letter}</text>`;
    }
    labelY = y - r - 6;
  } else if (kind === 'saklar' || kind === 'saklarTutup') {
    bodyHalf = 13;
    const a = cx - bodyHalf, b = cx + bodyHalf;
    out += `<circle cx="${a.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="#000000"/>`;
    out += `<circle cx="${b.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="#000000"/>`;
    // An open switch is drawn with its blade lifted — the only thing that
    // distinguishes "the circuit is broken" from "the circuit is complete".
    out += kind === 'saklarTutup' ? S(a, y, b, y) : S(a, y, b - 3, y - 11);
    labelY = y - 20;
  } else if (kind === 'kapasitor') {
    bodyHalf = 5;
    out += S(cx - bodyHalf, y - 10, cx - bodyHalf, y + 10);
    out += S(cx + bodyHalf, y - 10, cx + bodyHalf, y + 10);
    labelY = y - 16;
  } else if (kind === 'dioda' || kind === 'led') {
    bodyHalf = 9;
    out += `<polygon points="${(cx - bodyHalf).toFixed(1)},${(y - 8).toFixed(1)} ${(cx - bodyHalf).toFixed(1)},${(y + 8).toFixed(1)} ${(cx + bodyHalf).toFixed(1)},${y.toFixed(1)}" fill="#ffffff" stroke="#000000" stroke-width="1.6"/>`;
    out += S(cx + bodyHalf, y - 8, cx + bodyHalf, y + 8);
    if (kind === 'led') {
      out += arrowSVG(cx + 2, y - 12, cx + 12, y - 20);
      out += arrowSVG(cx - 4, y - 12, cx + 6, y - 20);
      labelY = y - 26;
    } else {
      labelY = y - 15;
    }
  } else if (kind === 'sekring') {
    const w = 30, h = 12;
    bodyHalf = w / 2;
    out += `<rect x="${(cx - w / 2).toFixed(1)}" y="${(y - h / 2).toFixed(1)}" width="${w}" height="${h}" fill="#ffffff" stroke="#000000" stroke-width="1.6"/>`;
    out += S(cx - w / 2, y, cx + w / 2, y, 1.2);
    labelY = y - h / 2 - 5;
  } else {
    // geser / termistor / ldr all start from the resistor box and add
    // their own distinguishing mark on top.
    const w = 34, h = 14;
    bodyHalf = w / 2;
    out += `<rect x="${(cx - w / 2).toFixed(1)}" y="${(y - h / 2).toFixed(1)}" width="${w}" height="${h}" fill="#ffffff" stroke="#000000" stroke-width="1.6"/>`;
    if (kind === 'geser') {
      out += arrowSVG(cx - w / 2 - 5, y + 13, cx + w / 2 + 3, y - 13);
      labelY = y - h / 2 - 14;
    } else if (kind === 'termistor') {
      out += S(cx - w / 2 - 4, y + 12, cx + 4, y + 12, 1.4);
      out += S(cx + 4, y + 12, cx + w / 2 + 4, y - 12, 1.4);
      labelY = y - h / 2 - 5;
    } else if (kind === 'ldr') {
      out += `<circle cx="${cx.toFixed(1)}" cy="${y.toFixed(1)}" r="17" fill="none" stroke="#000000" stroke-width="1.3"/>`;
      bodyHalf = 17;
      out += arrowSVG(cx - 26, y - 26, cx - 14, y - 14);
      out += arrowSVG(cx - 16, y - 30, cx - 4, y - 18);
      labelY = y - 34;
    }
  }

  // kawat penghubung 1.2 px, lebih tipis dari garis simbol supaya simbol menonjol
  let svg = S(x1, y, cx - bodyHalf, y, 1.2) + out + S(cx + bodyHalf, y, x2, y, 1.2);
  if (label) {
    svg += `<text x="${cx.toFixed(1)}" y="${labelY.toFixed(1)}" font-size="10.5" text-anchor="middle" fill="#000000">${escText(label)}</text>`;
  }
  return svg;
}

function resistorSVG(x1, y, x2, label) {
  const w = 34, h = 14;
  const bx = (x1 + x2) / 2 - w / 2;
  let s = `<line x1="${x1.toFixed(1)}" y1="${y.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#000000" stroke-width="1.2"/>`;
  s += `<rect x="${bx.toFixed(1)}" y="${(y - h / 2).toFixed(1)}" width="${w}" height="${h}" fill="#ffffff" stroke="#000000" stroke-width="1.6"/>`;
  s += `<line x1="${(bx + w).toFixed(1)}" y1="${y.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#000000" stroke-width="1.2"/>`;
  if (label) s += `<text x="${((x1 + x2) / 2).toFixed(1)}" y="${(y - h / 2 - 5).toFixed(1)}" font-size="10.5" text-anchor="middle" fill="#000000">${escText(label)}</text>`;
  return s;
}

// Sel (baterai) tegak lurus untuk cabang vertikal rangkaian multiloop: pelat
// panjang+tipis (+) di atas, pelat pendek+tebal (-) di bawah — konvensi yang
// sama dengan sel mendatar di renderCircuitSVG, cuma diputar 90°. balik=true
// menukar pelatnya (kutub - di atas) — baterai yang kutubnya dibalik-balik
// antar cabang itu lazim di soal hukum Kirchhoff, arah arusnya justru bagian
// dari yang harus dicari siswa.
function selVertikalSVG(cx, y1, y2, volt, balik) {
  const mid = (y1 + y2) / 2;
  const yPelat1 = mid - 6, yPelat2 = mid + 2;
  const pelatPanjang = (x, y) => `<line x1="${(x - 12).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + 12).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
  const pelatPendek = (x, y) => `<line x1="${(x - 6).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + 6).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="4"/>`;
  let s = `<line x1="${cx.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yPelat1.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
  s += balik ? pelatPendek(cx, yPelat1) : pelatPanjang(cx, yPelat1);
  s += balik ? pelatPanjang(cx, yPelat2) : pelatPendek(cx, yPelat2);
  s += `<line x1="${cx.toFixed(1)}" y1="${(yPelat2 + 2).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
  if (volt != null && isFinite(volt)) {
    s += `<text x="${(cx + 15).toFixed(1)}" y="${(mid + 4).toFixed(1)}" font-size="10.5" text-anchor="start" fill="${GAYA.hitam}">${volt} V</text>`;
  }
  return s;
}

// Resistor IEC tegak (sama seperti resistorSVG tapi arah vertikal), untuk
// cabang rangkaian multiloop — label di sisi kanan.
function resistorVertikalSVG(x, y1, y2, label) {
  const w = 14, h = 34;
  const by = (y1 + y2) / 2 - h / 2;
  let s = `<line x1="${x.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
  s += `<rect x="${(x - w / 2).toFixed(1)}" y="${by.toFixed(1)}" width="${w}" height="${h}" fill="#ffffff" stroke="${GAYA.hitam}" stroke-width="1.6"/>`;
  s += `<line x1="${x.toFixed(1)}" y1="${(by + h).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
  if (label) s += `<text x="${(x + 12).toFixed(1)}" y="${((y1 + y2) / 2 + 4).toFixed(1)}" font-size="10.5" text-anchor="start" fill="${GAYA.hitam}">${escText(label)}</text>`;
  return s;
}

function parseCabangMultiloop(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).map((tok, i) => {
    const bits = tok.split(':').map((s) => s.trim());
    return {
      name: bits[0] || ('R' + (i + 1)),
      ohm: numOrDefault(bits[1], 10),
      volt: numOrDefault(bits[2], 0),
      // rdalam (hambatan dalam baterai) & arah (balik = kutub ditukar) sama-sama
      // opsional — kosongkan rdalam tapi isi arah dengan "Nama:ohm:volt::balik".
      rdalam: numOrDefault(bits[3], 0),
      balik: (bits[4] || '').trim().toLowerCase() === 'balik',
    };
  });
}

// Rangkaian 1-loop/multiloop (Kirchhoff): N cabang VERTIKAL (resistor lalu
// sel, masing-masing sel BEBAS bedanya tegangannya) berjajar antara rel atas
// (simpul A) dan rel bawah (simpul B) — beda dari tipe seri/paralel/campuran
// di bawah yang cuma punya SATU sel keseluruhan. Rel atas/bawah sendiri
// boleh diselingi resistor di antara cabang-cabang (relAtas/relBawah),
// persis pola naskah ujian 2-loop yang resistornya ada di kawat penghubung,
// bukan cuma di cabang.
function renderMultiloopSVG(cfg) {
  const cabang = parseCabangMultiloop(cfg.cabang);
  if (!cabang.length) cabang.push({ name: 'R1', ohm: 5, volt: 4 }, { name: 'R2', ohm: 2, volt: 3 });
  const relBawah = String(cfg.relBawah || '').split(',').map((s) => s.trim());
  const relAtas = String(cfg.relAtas || '').split(',').map((s) => s.trim());
  const simpulAtas = String(cfg.simpulAtas || 'A').trim();
  const simpulBawah = String(cfg.simpulBawah || 'B').trim();

  const n = cabang.length;
  const adaRdalam = cabang.some((c) => c.rdalam > 0);
  const branchGap = 110, leftX = 60;
  const topY = 42, resBottom = topY + 36, battTop = resBottom + 16, battBottom = battTop + 50;
  // Zona hambatan dalam cuma disediakan kalau ADA cabang yang memakainya —
  // reservasinya sama untuk semua cabang (biar rel bawah tetap lurus),
  // cabang yang tidak punya hambatan dalam cuma diberi kawat lurus di situ.
  const rdalamTop = battBottom + 16, rdalamBottom = rdalamTop + 34;
  const bottomY = (adaRdalam ? rdalamBottom : battBottom) + 16;
  const xs = cabang.map((_, i) => leftX + i * branchGap);
  const rightX = xs[n - 1];
  const atasStartX = leftX - 28, bawahEndX = rightX + 28;
  const width = bawahEndX + 36;
  const height = bottomY + 24;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  const W = (x1, y1, x2, y2) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;

  // Rel atas: simpul A -> cabang pertama -> ... -> cabang terakhir.
  svg += W(atasStartX, topY, xs[0], topY);
  for (let i = 0; i < n - 1; i++) {
    const val = parseFloat(relAtas[i]);
    svg += (relAtas[i] && isFinite(val) && val > 0)
      ? resistorSVG(xs[i], topY, xs[i + 1], `${val} Ω`)
      : W(xs[i], topY, xs[i + 1], topY);
  }
  svg += `<circle cx="${atasStartX.toFixed(1)}" cy="${topY.toFixed(1)}" r="2.6" fill="${GAYA.hitam}"/>`;
  svg += `<text x="${atasStartX.toFixed(1)}" y="${(topY - 11).toFixed(1)}" font-size="12.5" font-weight="700" text-anchor="middle" fill="${GAYA.hitam}">${escText(simpulAtas)}</text>`;

  // Tiap cabang: resistor di atas, sel di bawahnya, lalu hambatan dalam
  // (kalau ada cabang lain yang memakainya, zona ini tetap disediakan supaya
  // rel bawah tetap lurus — cabang yang tidak punya cukup kawat lurus).
  cabang.forEach((c, i) => {
    const x = xs[i];
    svg += resistorVertikalSVG(x, topY, resBottom, `${c.ohm} Ω`);
    svg += W(x, resBottom, x, battTop);
    svg += selVertikalSVG(x, battTop, battBottom, c.volt, c.balik);
    if (adaRdalam) {
      svg += W(x, battBottom, x, rdalamTop);
      svg += c.rdalam > 0
        ? resistorVertikalSVG(x, rdalamTop, rdalamBottom, `r = ${c.rdalam} Ω`)
        : W(x, rdalamTop, x, rdalamBottom);
      svg += W(x, rdalamBottom, x, bottomY);
    } else {
      svg += W(x, battBottom, x, bottomY);
    }
  });

  // Rel bawah: cabang pertama -> ... -> cabang terakhir -> simpul B.
  for (let i = 0; i < n - 1; i++) {
    const val = parseFloat(relBawah[i]);
    svg += (relBawah[i] && isFinite(val) && val > 0)
      ? resistorSVG(xs[i], bottomY, xs[i + 1], `${val} Ω`)
      : W(xs[i], bottomY, xs[i + 1], bottomY);
  }
  svg += W(rightX, bottomY, bawahEndX, bottomY);
  svg += `<circle cx="${bawahEndX.toFixed(1)}" cy="${bottomY.toFixed(1)}" r="2.6" fill="${GAYA.hitam}"/>`;
  svg += `<text x="${bawahEndX.toFixed(1)}" y="${(bottomY + 17).toFixed(1)}" font-size="12.5" font-weight="700" text-anchor="middle" fill="${GAYA.hitam}">${escText(simpulBawah)}</text>`;

  // Titik sambungan (junction dot) di tiap percabangan 3 kawat — konvensi
  // standar IEC, menandai rel dan cabang memang tersambung (bukan cuma
  // kawat lewat). Digambar PALING AKHIR supaya tidak tertimpa garis rel
  // yang baru selesai digambar di atas.
  xs.forEach((x) => {
    svg += `<circle cx="${x.toFixed(1)}" cy="${topY.toFixed(1)}" r="2.6" fill="${GAYA.hitam}"/>`;
    svg += `<circle cx="${x.toFixed(1)}" cy="${bottomY.toFixed(1)}" r="2.6" fill="${GAYA.hitam}"/>`;
  });

  return svg + '</svg>';
}

function renderCircuitSVG(cfg) {
  if (String(cfg.tipe || '').toLowerCase() === 'multiloop') return renderMultiloopSVG(cfg);
  const tipe = cfg.tipe || 'seri';
  const comps = String(cfg.komponen || '').split(',').map((s) => s.trim()).filter(Boolean).map(parseCircuitComponent);
  let blocks;
  if (cfg.susunan) blocks = parseCircuitSusunan(cfg.susunan);
  else if (tipe === 'paralel') blocks = comps.length ? [{ type: 'parallel', comps }] : [];
  else blocks = comps.map((c) => ({ type: 'series', comp: c }));
  if (!blocks.length) blocks = [{ type: 'series', comp: { name: 'R1', value: 10 } }];

  // Jarak antarcabang paralel 38 px: label komponen cabang bawah (≈ y−17)
  // harus lepas dari kotak komponen cabang di atasnya (tinggi 14 px).
  const branchGap = 38, blockWidth = 90;
  const maxBranches = Math.max(1, ...blocks.map((b) => (b.type === 'parallel' ? b.comps.length : 1)));

  // Kawat 1.2 px hitam, sudut siku; sel di kawat kiri, komponen di kawat
  // atas (cabang paralel turun ke bawah), kanvas dipotong pas.
  const KAWAT = 1.2;
  const W = (x1, y1, x2, y2) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${KAWAT}"/>`;
  const leftX = 56;
  const rightX = leftX + blocks.length * blockWidth;
  const width = rightX + 22;
  const topY = 46;
  const bottomY = topY + (maxBranches - 1) * branchGap + 56;
  const height = bottomY + 18;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;

  // Sel: pelat panjang tipis (+) di atas, pelat pendek tebal (−) di bawah,
  // tanda + di sisi pelat panjang dan tegangan di samping kiri.
  const bcy = (topY + bottomY) / 2;
  svg += W(leftX, topY, leftX, bcy - 6);
  svg += `<line x1="${(leftX - 12).toFixed(1)}" y1="${(bcy - 6).toFixed(1)}" x2="${(leftX + 12).toFixed(1)}" y2="${(bcy - 6).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
  svg += `<line x1="${(leftX - 6).toFixed(1)}" y1="${(bcy + 2).toFixed(1)}" x2="${(leftX + 6).toFixed(1)}" y2="${(bcy + 2).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="4"/>`;
  svg += W(leftX, bcy + 4, leftX, bottomY);
  svg += `<text x="${(leftX + 16).toFixed(1)}" y="${(bcy - 8).toFixed(1)}" font-size="${GAYA.teks}" fill="${GAYA.hitam}">+</text>`;
  const sumber = numOrDefault(cfg.sumber, null);
  if (sumber !== null) {
    svg += `<text x="${(leftX - 16).toFixed(1)}" y="${(bcy + 2).toFixed(1)}" font-size="${GAYA.teks}" text-anchor="end" fill="${GAYA.hitam}">${sumber} V</text>`;
  }

  svg += W(leftX, bottomY, rightX, bottomY);
  svg += W(rightX, topY, rightX, bottomY);

  blocks.forEach((block, i) => {
    const bx0 = leftX + i * blockWidth, bx1 = bx0 + blockWidth;
    if (block.type === 'series') {
      svg += componentSVG(bx0, topY, bx1, block.comp);
    } else {
      const n = block.comps.length;
      const lastY = topY + (n - 1) * branchGap;
      if (n > 1) {
        svg += W(bx0, topY, bx0, lastY);
        svg += W(bx1, topY, bx1, lastY);
        // titik sambung hanya di percabangan
        svg += `<circle cx="${bx0.toFixed(1)}" cy="${topY}" r="2.2" fill="${GAYA.hitam}"/>`;
        svg += `<circle cx="${bx1.toFixed(1)}" cy="${topY}" r="2.2" fill="${GAYA.hitam}"/>`;
      }
      block.comps.forEach((c, j) => {
        svg += componentSVG(bx0, topY + j * branchGap, bx1, c);
      });
    }
  });

  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 6f. Rantai Makanan (biologi)
// ---------------------------------------------------------------------

function renderFoodChainSVG(cfg) {
  const organisms = String(cfg.organisme || '').split(',').map((s) => s.trim()).filter(Boolean);
  const n = Math.max(1, organisms.length);
  const boxW = 92, boxH = 42, gap = 36;
  const width = Math.max(320, n * boxW + (n - 1) * gap + 40);
  const height = 130;
  const y = height / 2 - boxH / 2;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;

  organisms.forEach((name, i) => {
    const x = 20 + i * (boxW + gap);
    svg += `<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" fill="none" stroke="#000000" stroke-width="1.6"/>`;
    svg += `<text x="${(x + boxW / 2).toFixed(1)}" y="${(y + boxH / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="#000000">${escText(name)}</text>`;
    if (i < n - 1) svg += arrowSVG(x + boxW, y + boxH / 2, x + boxW + gap, y + boxH / 2);
  });

  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 6g. Bentuk Molekul / Domain Elektron (VSEPR) — kimia
// ---------------------------------------------------------------------

// angleDeg measured the usual math way (0 = right, 90 = up) so preset data
// below reads naturally; the y-flip that turns "up" into a smaller SVG y
// happens once, here.
function vseprPolar(cx, cy, angleDeg, r) {
  const rad = (angleDeg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy - r * Math.sin(rad)];
}

// Baji padat: ikatan ke arah pembaca. Sempit di atom pusat, melebar di ujung.
function wedgeBondSVG(cx, cy, ex, ey, halfWidth) {
  const dx = ex - cx, dy = ey - cy, len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len;
  const w = halfWidth == null ? 5 : halfWidth;
  const p2x = ex + px * w, p2y = ey + py * w;
  const p3x = ex - px * w, p3y = ey - py * w;
  return `<polygon points="${(cx + px * 0.8).toFixed(1)},${(cy + py * 0.8).toFixed(1)} ${p2x.toFixed(1)},${p2y.toFixed(1)} ${p3x.toFixed(1)},${p3y.toFixed(1)} ${(cx - px * 0.8).toFixed(1)},${(cy - py * 0.8).toFixed(1)}" fill="${GAYA.hitam}"/>`;
}

// Baji arsir (hashed wedge): ikatan menjauhi pembaca, deretan garis pendek
// melintang yang makin lebar ke ujung — konvensi buku, bukan garis putus.
function hashedBondSVG(cx, cy, ex, ey, halfWidth) {
  const dx = ex - cx, dy = ey - cy, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, px = -uy, py = ux;
  const w = halfWidth == null ? 5 : halfWidth;
  const n = Math.max(4, Math.round(len / 6));
  let s = '';
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = cx + ux * len * t, y = cy + uy * len * t;
    const h = 1 + (w - 1) * t;
    s += `<line x1="${(x + px * h).toFixed(1)}" y1="${(y + py * h).toFixed(1)}" x2="${(x - px * h).toFixed(1)}" y2="${(y - py * h).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
  }
  return s;
}

// Tiap preset = satu susunan domain elektron AXmEn. "bonds" = arah m atom
// terikat yang digambar (solid = sebidang kertas, wedge = ke arah pembaca,
// dash = menjauhi pembaca — konvensi buku untuk bentuk 3D di bidang 2D),
// "lp" = arah n pasangan elektron bebas (lobus berisi dua titik). "busur"
// = pasangan indeks ikatan sebidang yang diberi busur sudut berlabel;
// dihilangkan jika sudutnya bukan satu nilai atau tidak ada dua ikatan
// sebidang yang mewakilinya. Sudut di gambar bukan proyeksi kristalografi
// — dipilih supaya bentuknya langsung dikenali.
const VSEPR_PRESETS = {
  ax2: {
    nama: 'Linear', sudut: '180°',
    bonds: [{ ang: 0, style: 'solid' }, { ang: 180, style: 'solid' }], lp: [],
  },
  ax2e1: {
    nama: 'Bentuk V (Bengkok)', sudut: '≈120°', busur: [0, 1],
    bonds: [{ ang: 210, style: 'solid' }, { ang: 330, style: 'solid' }], lp: [{ ang: 90 }],
  },
  ax2e2: {
    nama: 'Bentuk V (Bengkok)', sudut: '≈104,5°', busur: [0, 1],
    bonds: [{ ang: 218, style: 'solid' }, { ang: 322, style: 'solid' }], lp: [{ ang: 60 }, { ang: 120 }],
  },
  ax3: {
    nama: 'Segitiga Datar (Trigonal Planar)', sudut: '120°', busur: [1, 2],
    bonds: [{ ang: 90, style: 'solid' }, { ang: 210, style: 'solid' }, { ang: 330, style: 'solid' }], lp: [],
  },
  ax3e1: {
    nama: 'Piramida Trigonal', sudut: '≈107°', busur: [0, 1],
    bonds: [{ ang: 210, style: 'solid' }, { ang: 330, style: 'solid' }, { ang: 270, style: 'wedge', len: 62 }], lp: [{ ang: 90 }],
  },
  ax3e2: {
    nama: 'Bentuk T', sudut: '≈90°', busur: [0, 2],
    bonds: [{ ang: 90, style: 'solid' }, { ang: 270, style: 'solid' }, { ang: 0, style: 'solid' }],
    lp: [{ ang: 150 }, { ang: 210 }],
  },
  ax4: {
    nama: 'Tetrahedral', sudut: '109,5°', busur: [0, 1],
    bonds: [
      { ang: 90, style: 'solid' }, { ang: 210, style: 'solid' },
      { ang: 300, style: 'wedge' }, { ang: 340, style: 'dash' },
    ],
    lp: [],
  },
  ax4e1: {
    nama: 'Jungkat-jungkit (See-saw)', sudut: '≈89° / ≈117°',
    bonds: [
      { ang: 90, style: 'solid' }, { ang: 270, style: 'solid' },
      { ang: 340, style: 'wedge', len: 70 }, { ang: 20, style: 'dash', len: 70 },
    ],
    lp: [{ ang: 180 }],
  },
  ax4e2: {
    nama: 'Segiempat Datar (Square Planar)', sudut: '90°', busur: [0, 2],
    bonds: [
      { ang: 0, style: 'solid' }, { ang: 180, style: 'solid' },
      { ang: 305, style: 'wedge', len: 66 }, { ang: 125, style: 'dash', len: 66 },
    ],
    lp: [{ ang: 90, r: 30 }, { ang: 270, r: 30 }],
  },
  ax5: {
    nama: 'Bipiramida Trigonal', sudut: '90° / 120°',
    bonds: [
      { ang: 90, style: 'solid' }, { ang: 270, style: 'solid' }, { ang: 180, style: 'solid' },
      { ang: 330, style: 'wedge', len: 68 }, { ang: 30, style: 'dash', len: 68 },
    ],
    lp: [],
  },
  ax5e1: {
    nama: 'Piramida Segiempat', sudut: '≈90°',
    bonds: [
      { ang: 90, style: 'solid' }, { ang: 190, style: 'solid' }, { ang: 350, style: 'solid' },
      { ang: 235, style: 'wedge', len: 66 }, { ang: 305, style: 'dash', len: 66 },
    ],
    lp: [{ ang: 270, r: 30 }],
  },
  ax6: {
    nama: 'Oktahedral', sudut: '90°', busur: [0, 2],
    bonds: [
      { ang: 90, style: 'solid' }, { ang: 270, style: 'solid' },
      { ang: 0, style: 'solid' }, { ang: 180, style: 'solid' },
      { ang: 330, style: 'wedge', len: 64 }, { ang: 150, style: 'dash', len: 64 },
    ],
    lp: [],
  },
};

// Bentuk molekul gaya naskah 9701: huruf atom polos (tanpa lingkaran),
// ikatan sebidang garis, ke depan baji padat, ke belakang baji arsir,
// pasangan bebas dua titik di dalam lobus tipis, busur sudut berlabel, nama
// bentuk dan sudut ikatan di bawah gambar.
function renderMoleculeShapeSVG(cfg) {
  const key = String(cfg.tipe || 'ax4').toLowerCase();
  const preset = VSEPR_PRESETS[key] || VSEPR_PRESETS.ax4;
  const pusatLabel = cfg.pusat || 'A';
  const ikatanLabel = cfg.ikatan || 'X';
  const cx = 0, cy = 0;
  const BOND_LEN = 78, CLEAR = 11;

  let body = '';
  let minX = -20, maxX = 20, minY = -20, maxY = 20;
  const catat = (x, y, hw, hh) => {
    minX = Math.min(minX, x - hw); maxX = Math.max(maxX, x + hw);
    minY = Math.min(minY, y - hh); maxY = Math.max(maxY, y + hh);
  };

  preset.bonds.forEach((b) => {
    const len = b.len || BOND_LEN;
    const [sx, sy] = vseprPolar(cx, cy, b.ang, CLEAR);
    const [ex, ey] = vseprPolar(cx, cy, b.ang, len);
    if (b.style === 'wedge') body += wedgeBondSVG(sx, sy, ex, ey, 5);
    else if (b.style === 'dash') body += hashedBondSVG(sx, sy, ex, ey, 5);
    else body += `<line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    const [lx, ly] = vseprPolar(cx, cy, b.ang, len + 12);
    body += `<text x="${lx.toFixed(1)}" y="${(ly + 4.5).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="700" fill="${GAYA.hitam}">${escText(ikatanLabel)}</text>`;
    catat(lx, ly, 5 + ikatanLabel.length * 4, 8);
  });

  (preset.lp || []).forEach((lpItem) => {
    const r = lpItem.r || 32;
    const [px, py] = vseprPolar(cx, cy, lpItem.ang, r);
    const rad = (lpItem.ang * Math.PI) / 180;
    const perpx = -Math.sin(rad), perpy = -Math.cos(rad);
    // Lobus orbital: elips tipis memanjang searah pasangan bebas.
    body += `<ellipse cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" rx="8" ry="15" transform="rotate(${(90 - lpItem.ang).toFixed(1)} ${px.toFixed(1)} ${py.toFixed(1)})" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garisBantu}"/>`;
    body += `<circle cx="${(px + perpx * 3.5).toFixed(1)}" cy="${(py + perpy * 3.5).toFixed(1)}" r="2" fill="${GAYA.hitam}"/>`;
    body += `<circle cx="${(px - perpx * 3.5).toFixed(1)}" cy="${(py - perpy * 3.5).toFixed(1)}" r="2" fill="${GAYA.hitam}"/>`;
    catat(px, py, 16, 16);
  });

  if (preset.busur && /^≈?\d/.test(preset.sudut)) {
    const a = preset.bonds[preset.busur[0]].ang, b = preset.bonds[preset.busur[1]].ang;
    let dari = a, ke = b;
    if (((ke - dari) % 360 + 360) % 360 > 180) { dari = b; ke = a; }
    const R = 26;
    const [ax, ay] = vseprPolar(cx, cy, dari, R), [bx, by] = vseprPolar(cx, cy, ke, R);
    body += `<path d="M${ax.toFixed(1)} ${ay.toFixed(1)} A${R} ${R} 0 0 0 ${bx.toFixed(1)} ${by.toFixed(1)}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garisBantu}"/>`;
    const tengah = dari + (((ke - dari) % 360 + 360) % 360) / 2;
    const [tx, ty] = vseprPolar(cx, cy, tengah, R + 16);
    body += `<text x="${tx.toFixed(1)}" y="${(ty + 4).toFixed(1)}" text-anchor="middle" font-size="11.5" fill="${GAYA.hitam}">${escText(preset.sudut)}</text>`;
  }

  body += `<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="14" font-weight="700" fill="${GAYA.hitam}">${escText(pusatLabel)}</text>`;

  // Judul (rumus molekul) di atas, nama bentuk + sudut di bawah. Angka
  // pada rumus dijadikan subskrip (XeF4 -> XeF₄).
  const judul = cfg.nama ? subskripRumus(cfg.nama) : '';
  const namaBentuk = `${preset.nama} (${key.toUpperCase()})`;
  const teksSudut = `sudut ikatan ${preset.sudut}`;
  const lebarTeks = Math.max(namaBentuk.length * 7, teksSudut.length * 6.2, judul.length * 7.5);
  const yJudul = minY - 14;
  const yNama = maxY + 22, ySudut = yNama + 16;
  if (judul) body += `<text x="${cx}" y="${yJudul.toFixed(1)}" text-anchor="middle" font-size="13" font-weight="700" fill="${GAYA.hitam}">${escText(judul)}</text>`;
  body += `<text x="${cx}" y="${yNama.toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="${GAYA.hitam}">${escText(namaBentuk)}</text>`;
  body += `<text x="${cx}" y="${ySudut.toFixed(1)}" text-anchor="middle" font-size="11.5" fill="${GAYA.hitam}">${escText(teksSudut)}</text>`;

  const halfW = Math.max(maxX - cx, cx - minX, lebarTeks / 2) + 8;
  const top = (judul ? yJudul - 12 : minY) - 6, bottom = ySudut + 6;
  const width = halfW * 2, height = bottom - top;
  return svgPas(width, height, `<g transform="translate(${halfW.toFixed(1)},${(-top).toFixed(1)})">${body}</g>`, cfg);
}

// ---------------------------------------------------------------------
// 6g2. Diagram Tingkat Energi (kimia — termokimia/entalpi, konfigurasi
// elektron, dsb: any "level ke level" energy comparison)
// ---------------------------------------------------------------------

// "Reaktan:0,Produk:-50" -> [{name:'Reaktan',value:0}, {name:'Produk',value:-50}]
function parseEnergyLevelList(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [name, val] = pair.split(':').map((x) => (x || '').trim());
    return { name: name || '', value: parseFloat(val) };
  });
}

function renderEnergyLevelSVG(cfg) {
  let levels = parseEnergyLevelList(cfg.level);
  if (!levels.length) levels = [{ name: 'Reaktan', value: 0 }, { name: 'Produk', value: -50 }];
  const satuan = cfg.satuan || '';

  const width = 360, padTop = 30, padBottom = 46, padX = 50, chartH = 190;
  const height = padTop + chartH + padBottom;
  const vals = levels.map((l) => (isFinite(l.value) ? l.value : 0));
  const vmin = Math.min(...vals), vmax = Math.max(...vals);
  const vrange = (vmax - vmin) || 1;
  // Levels with equal or near-equal values would otherwise collapse onto
  // the same line — pad the range a bit so every shelf stays visible even
  // when all the given values are identical.
  const toY = (v) => padTop + chartH - ((v - vmin) / (vrange || 1)) * (chartH - 20) - 10;

  const shelfW = 76;
  const n = levels.length;
  const gap = n > 1 ? (width - 2 * padX - shelfW) / (n - 1) : 0;
  const xs = levels.map((_, i) => padX + i * gap);

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;

  levels.forEach((lv, i) => {
    const x0 = xs[i], x1 = x0 + shelfW, y = toY(vals[i]);
    svg += `<line x1="${x0.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#000000" stroke-width="2.2"/>`;
    svg += `<text x="${((x0 + x1) / 2).toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle" font-size="11.5" font-weight="700" fill="#000000">${escText(lv.name)}</text>`;
    const valTxt = isFinite(lv.value) ? lv.value + (satuan ? ' ' + satuan : '') : '';
    svg += `<text x="${((x0 + x1) / 2).toFixed(1)}" y="${(y + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="#475569">${escText(valTxt)}</text>`;
  });

  const wantTransisi = String(cfg.transisi || '').trim().toLowerCase();
  if (wantTransisi !== 'tidak' && wantTransisi !== 'no' && wantTransisi !== 'none') {
    for (let i = 0; i < n - 1; i++) {
      const x0 = xs[i] + shelfW, y0 = toY(vals[i]);
      const x1 = xs[i + 1], y1 = toY(vals[i + 1]);
      svg += arrowSVG(x0, y0, x1, y1, { dash: '4,3', strokeWidth: 1.4 });
      const diff = vals[i + 1] - vals[i];
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const diffTxt = (diff >= 0 ? '+' : '') + (Math.round(diff * 100) / 100) + (satuan ? ' ' + satuan : '');
      svg += `<text x="${mx.toFixed(1)}" y="${(my - 6).toFixed(1)}" text-anchor="middle" font-size="10" fill="#000000">Δ = ${escText(diffTxt)}</text>`;
    }
  }

  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 6h. Sel Hewan / Sel Tumbuhan — biologi
// ---------------------------------------------------------------------

function cellPartLabel(x, y, text, anchor) {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor || 'start'}" font-size="10.5" fill="#000000">${escText(text)}</text>`;
}

function cellLeader(x1, y1, x2, y2) {
  return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#666666" stroke-width="0.9"/>`;
}

function renderCellSVG(cfg) {
  const tipe = String(cfg.tipe || 'hewan').toLowerCase() === 'tumbuhan' ? 'tumbuhan' : 'hewan';
  const showLabel = String(cfg.label || 'ya').toLowerCase() !== 'tidak';
  const width = 420, height = 320;
  const cx = width / 2, cy = height / 2 + 5;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  svg += `<text x="${(width / 2).toFixed(1)}" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#000000">${tipe === 'tumbuhan' ? 'Sel Tumbuhan' : 'Sel Hewan'}</text>`;

  const parts = [];

  if (tipe === 'tumbuhan') {
    // Dinding sel (cell wall) — outer, rigid, drawn as a rounded rect since
    // a real plant cell's wall gives it straighter edges than an animal
    // cell's membrane.
    svg += `<rect x="${cx - 165}" y="${cy - 118}" width="330" height="236" rx="18" fill="none" stroke="#000000" stroke-width="2.6"/>`;
    // Membran sel (cell membrane) — just inside the wall.
    svg += `<rect x="${cx - 155}" y="${cy - 108}" width="310" height="216" rx="14" fill="#f0fdf4" stroke="#000000" stroke-width="1.2"/>`;
    // Vakuola (vacuole) — dominates a mature plant cell.
    svg += `<ellipse cx="${cx + 15}" cy="${cy + 5}" rx="105" ry="78" fill="#dbeafe" stroke="#000000" stroke-width="1.3"/>`;
    parts.push({ x: cx + 15, y: cy + 5, label: 'Vakuola', lx: cx + 100, ly: cy + 90, anchor: 'start' });
    // Kloroplas (chloroplast) — a few, near the wall.
    [[-125, -70], [-135, 30], [-95, 85]].forEach(([dx, dy], i) => {
      svg += `<ellipse cx="${cx + dx}" cy="${cy + dy}" rx="16" ry="9" fill="#86efac" stroke="#000000" stroke-width="1"/>`;
      if (i === 0) parts.push({ x: cx + dx, y: cy + dy, label: 'Kloroplas', lx: cx - 160, ly: cy - 88, anchor: 'start' });
    });
    // Nukleus, pushed to a corner since the vacuole takes the center.
    svg += `<circle cx="${cx - 90}" cy="${cy - 60}" r="34" fill="#e0e7ff" stroke="#000000" stroke-width="1.3"/>`;
    svg += `<circle cx="${cx - 90}" cy="${cy - 60}" r="9" fill="#6366f1"/>`;
    parts.push({ x: cx - 90, y: cy - 60, label: 'Inti Sel (Nukleus)', lx: cx - 160, ly: cy - 128, anchor: 'start' });
    // Mitokondria.
    svg += `<ellipse cx="${cx - 60}" cy="${cy + 95}" rx="18" ry="10" fill="#fed7aa" stroke="#000000" stroke-width="1" transform="rotate(20 ${cx - 60} ${cy + 95})"/>`;
    parts.push({ x: cx - 60, y: cy + 95, label: 'Mitokondria', lx: cx - 160, ly: cy + 128, anchor: 'start' });
    parts.push({ x: cx - 155, y: cy - 108, label: 'Membran Sel', lx: cx + 30, ly: cy - 128, anchor: 'start' });
    parts.push({ x: cx - 165, y: cy - 118, label: 'Dinding Sel', lx: cx + 100, ly: cy - 143, anchor: 'start' });
  } else {
    // Membran sel (cell membrane) — soft, irregular outline typical of an
    // animal cell (no rigid wall).
    svg += `<ellipse cx="${cx}" cy="${cy}" rx="160" ry="120" fill="#fff7ed" stroke="#000000" stroke-width="2.2"/>`;
    parts.push({ x: cx, y: cy - 120, label: 'Membran Sel', lx: cx + 5, ly: cy - 132, anchor: 'start' });
    // Nukleus + anak inti (nucleolus).
    svg += `<circle cx="${cx - 40}" cy="${cy - 15}" r="42" fill="#e0e7ff" stroke="#000000" stroke-width="1.3"/>`;
    svg += `<circle cx="${cx - 40}" cy="${cy - 15}" r="10" fill="#6366f1"/>`;
    parts.push({ x: cx - 40, y: cy - 15, label: 'Inti Sel (Nukleus)', lx: cx - 150, ly: cy - 95, anchor: 'start' });
    parts.push({ x: cx - 40, y: cy - 15, label: 'Anak Inti (Nukleolus)', lx: cx - 150, ly: cy - 78, anchor: 'start' });
    // Retikulum endoplasma — a short squiggle beside the nucleus.
    svg += `<path d="M ${cx + 6} ${cy - 45} q 12 -14 24 0 t 24 0 t 24 0" fill="none" stroke="#000000" stroke-width="1.3"/>`;
    parts.push({ x: cx + 42, y: cy - 45, label: 'Retikulum Endoplasma', lx: cx + 60, ly: cy - 95, anchor: 'start' });
    // Mitokondria, x2.
    svg += `<ellipse cx="${cx + 70}" cy="${cy + 40}" rx="22" ry="12" fill="#fed7aa" stroke="#000000" stroke-width="1" transform="rotate(-25 ${cx + 70} ${cy + 40})"/>`;
    svg += `<ellipse cx="${cx + 55}" cy="${cy - 55}" rx="20" ry="11" fill="#fed7aa" stroke="#000000" stroke-width="1" transform="rotate(30 ${cx + 55} ${cy - 55})"/>`;
    parts.push({ x: cx + 70, y: cy + 40, label: 'Mitokondria', lx: cx + 90, ly: cy + 95, anchor: 'start' });
    // Ribosom — scattered dots.
    [[-90, 55], [-60, 70], [-100, 20], [30, 75]].forEach(([dx, dy]) => {
      svg += `<circle cx="${cx + dx}" cy="${cy + dy}" r="2.4" fill="#000000"/>`;
    });
    parts.push({ x: cx - 90, y: cy + 55, label: 'Ribosom', lx: cx - 150, ly: cy + 95, anchor: 'start' });
    // Vakuola — small in an animal cell.
    svg += `<circle cx="${cx + 20}" cy="${cy + 75}" r="14" fill="#bfdbfe" stroke="#000000" stroke-width="1"/>`;
    parts.push({ x: cx + 20, y: cy + 75, label: 'Vakuola', lx: cx + 5, ly: cy + 115, anchor: 'start' });
  }

  if (showLabel) {
    parts.forEach((p) => {
      svg += cellLeader(p.x, p.y, p.lx, p.ly);
      svg += cellPartLabel(p.lx + 3, p.ly + 3, p.label, p.anchor);
    });
  }

  svg += '</svg>';
  return svg;
}

// Struktur bunga: mahkota (kelopak bunga, whorl luar berwarna) mengelilingi
// benang sari & putik di tengah, kelopak (sepal, hijau) mengintip di
// sela-sela mahkota, tangkai + daun di bawah. Simetri radial n=6 kelopak,
// posisi tiap bagian dihitung dari sudut supaya proporsional untuk n berapa
// pun kalau nanti perlu diubah, bukan dikoordinat-tetapkan manual.
function renderFlowerSVG(cfg) {
  const showLabel = String(cfg.label || 'ya').toLowerCase() !== 'tidak';
  const width = 380, height = 380;
  const cx = width / 2, fy = 145; // fy = pusat kepala bunga

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  svg += `<text x="${(width / 2).toFixed(1)}" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#000000">Struktur Bunga</text>`;

  const parts = [];
  const n = 6;

  // Tangkai (stem) — bawah sekali, digambar duluan.
  svg += `<line x1="${cx}" y1="${fy + 60}" x2="${cx}" y2="${height - 24}" stroke="#166534" stroke-width="4"/>`;
  parts.push({ x: cx, y: fy + 170, label: 'Tangkai', lx: cx + 95, ly: fy + 180, anchor: 'start' });

  // Daun (leaf), menempel di tangkai.
  const leafY = fy + 110;
  svg += `<path d="M ${cx} ${leafY} Q ${cx - 58} ${leafY - 8} ${cx - 74} ${leafY + 18} Q ${cx - 56} ${leafY + 38} ${cx} ${leafY + 6} Z" fill="#86efac" stroke="#166534" stroke-width="1.2"/>`;
  parts.push({ x: cx - 58, y: leafY + 14, label: 'Daun', lx: cx - 150, ly: leafY + 40, anchor: 'start' });

  // Kelopak (sepal) — di sela-sela mahkota, digambar SEBELUM mahkota supaya
  // ujungnya saja yang mengintip di tepi luar.
  for (let i = 0; i < n; i++) {
    const theta = (i + 0.5) * ((2 * Math.PI) / n);
    const dist = 42, sudutDerajat = (theta * 180) / Math.PI;
    const sx = cx + dist * Math.sin(theta), sy = fy - dist * Math.cos(theta);
    svg += `<ellipse cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" rx="9" ry="20" fill="#4ade80" stroke="#166534" stroke-width="1" transform="rotate(${sudutDerajat.toFixed(1)} ${sx.toFixed(1)} ${sy.toFixed(1)})"/>`;
    if (i === n - 1) {
      const lx2 = cx + (dist + 22) * Math.sin(theta), ly2 = fy - (dist + 22) * Math.cos(theta);
      parts.push({ x: lx2, y: ly2, label: 'Kelopak', lx: cx + 130, ly: fy - 55, anchor: 'start' });
    }
  }

  // Mahkota (petal) — whorl utama, menutupi sebagian besar kelopak.
  for (let i = 0; i < n; i++) {
    const theta = i * ((2 * Math.PI) / n);
    const dist = 46, sudutDerajat = (theta * 180) / Math.PI;
    const px = cx + dist * Math.sin(theta), py = fy - dist * Math.cos(theta);
    svg += `<ellipse cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" rx="23" ry="48" fill="#fbcfe8" stroke="#9d174d" stroke-width="1.3" transform="rotate(${sudutDerajat.toFixed(1)} ${px.toFixed(1)} ${py.toFixed(1)})"/>`;
    if (i === 0) {
      const lx2 = cx + (dist + 46) * Math.sin(theta), ly2 = fy - (dist + 46) * Math.cos(theta);
      parts.push({ x: lx2, y: ly2, label: 'Mahkota', lx: cx, ly: fy - 108, anchor: 'middle' });
    }
  }

  // Benang sari (stamen) — cincin garis tipis dari pusat, ujungnya kepala
  // sari (anther) bulat kuning.
  const stamenCount = 8;
  for (let i = 0; i < stamenCount; i++) {
    const theta = i * ((2 * Math.PI) / stamenCount);
    const r1 = 6, r2 = 27;
    const x1 = cx + r1 * Math.sin(theta), y1 = fy - r1 * Math.cos(theta);
    const x2 = cx + r2 * Math.sin(theta), y2 = fy - r2 * Math.cos(theta);
    svg += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#a16207" stroke-width="1.3"/>`;
    svg += `<circle cx="${x2.toFixed(1)}" cy="${y2.toFixed(1)}" r="3.4" fill="#eab308" stroke="#a16207" stroke-width="0.6"/>`;
    if (i === 1) parts.push({ x: x2, y: y2, label: 'Benang Sari', lx: cx + 95, ly: fy + 40, anchor: 'start' });
  }

  // Putik (pistil) — kapsul kecil tepat di pusat, di atas semua bagian lain.
  svg += `<ellipse cx="${cx}" cy="${fy}" rx="7" ry="17" fill="#fef08a" stroke="#000000" stroke-width="1.3"/>`;
  parts.push({ x: cx, y: fy - 16, label: 'Putik', lx: cx - 95, ly: fy + 42, anchor: 'end' });

  if (showLabel) {
    parts.forEach((p) => {
      svg += cellLeader(p.x, p.y, p.lx, p.ly);
      svg += cellPartLabel(p.lx + (p.anchor === 'end' ? -3 : 3), p.ly + 3, p.label, p.anchor);
    });
  }

  svg += '</svg>';
  return svg;
}

// Daur hidup / metamorfosis — generik untuk hewan/tumbuhan apa pun, bukan
// cuma kupu-kupu: N tahap (tahapan=Telur,Larva,...) diletakkan melingkar,
// dihubungkan panah searah jarum jam (tahap terakhir kembali ke pertama,
// karena memang siklus). Labelnya di LUAR tiap simpul (bukan di dalam
// lingkaran) supaya nama tahap yang panjang tidak perlu dipotong/mengecil.
function renderLifeCycleSVG(cfg) {
  const stages = String(cfg.tahapan || 'Telur,Larva,Pupa,Dewasa').split(',').map((s) => s.trim()).filter(Boolean);
  const n = Math.max(2, stages.length);
  const judul = String(cfg.judul || 'Daur Hidup').trim();
  const width = 480, height = 420;
  const cx = width / 2, cy = height / 2 + 10;
  const R = 100, nodeR = 28;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  svg += `<text x="${(width / 2).toFixed(1)}" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#000000">${escText(judul)}</text>`;

  const pos = [];
  for (let i = 0; i < n; i++) {
    const theta = i * ((2 * Math.PI) / n) - Math.PI / 2; // mulai di atas, searah jarum jam
    pos.push({ x: cx + R * Math.cos(theta), y: cy + R * Math.sin(theta), theta });
  }

  // Panah antar tahap, dipendekkan supaya berhenti di TEPI lingkaran simpul
  // (bukan pusatnya) di kedua ujung — termasuk yang terakhir kembali ke awal.
  for (let i = 0; i < n; i++) {
    const a = pos[i], b = pos[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const x1 = a.x + ux * (nodeR + 4), y1 = a.y + uy * (nodeR + 4);
    const x2 = b.x - ux * (nodeR + 4), y2 = b.y - uy * (nodeR + 4);
    svg += arrowSVG(x1, y1, x2, y2, { headLen: 9, strokeWidth: 1.6 });
  }

  const warna = ['#fde68a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fecaca', '#ddd6fe', '#fed7aa', '#a7f3d0'];
  pos.forEach((p, i) => {
    svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${nodeR}" fill="${warna[i % warna.length]}" stroke="#000000" stroke-width="1.3"/>`;
    svg += `<text x="${p.x.toFixed(1)}" y="${(p.y + 4).toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#000000">${i + 1}</text>`;
    // Nama tahap ditulis di LUAR simpul, menjauhi pusat lingkaran besar —
    // anchor menyesuaikan sisi mana simpulnya (kiri/kanan/atas/bawah) supaya
    // teksnya tidak menabrak panah atau simpul tetangga.
    const lx = cx + (R + nodeR + 14) * Math.cos(p.theta), ly = cy + (R + nodeR + 14) * Math.sin(p.theta);
    const cosT = Math.cos(p.theta);
    const anchor = cosT > 0.3 ? 'start' : cosT < -0.3 ? 'end' : 'middle';
    svg += cellLeader(p.x + nodeR * Math.cos(p.theta), p.y + nodeR * Math.sin(p.theta), lx, ly);
    svg += cellPartLabel(lx + (anchor === 'end' ? -3 : anchor === 'start' ? 3 : 0), ly + 3, stages[i] || `Tahap ${i + 1}`, anchor);
  });

  svg += '</svg>';
  return svg;
}

// Panah bersiku (garis lurus per segmen, kepala panah cuma di ujung
// terakhir) — dipakai untuk pipa/saluran yang perlu berbelok tanpa
// menembus kotak lain (pembuluh darah di sekitar jantung, saluran
// pencernaan), karena arrowSVG cuma tahu garis lurus satu segmen.
function elbowArrowSVG(points, opts) {
  opts = opts || {};
  const color = opts.color || '#000000';
  const strokeWidth = opts.strokeWidth || 1.8;
  let s = '';
  for (let i = 0; i < points.length - 2; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[i + 1];
    s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${strokeWidth}"/>`;
  }
  const [lx1, ly1] = points[points.length - 2], [lx2, ly2] = points[points.length - 1];
  s += arrowSVG(lx1, ly1, lx2, ly2, { color, strokeWidth, headLen: opts.headLen || 8 });
  return s;
}

// Peredaran darah ganda (sirkulasi pulmonal + sistemik): jantung di tengah
// dipecah 4 ruang (serambi/bilik kiri-kanan), paru-paru di atas, tubuh di
// bawah. Jalur MERAH (kaya oksigen) selalu di sisi KIRI gambar: paru-paru
// -> serambi kiri -> (internal) -> bilik kiri -> tubuh. Jalur BIRU (miskin
// oksigen) selalu di sisi KANAN: tubuh -> serambi kanan -> (internal) ->
// bilik kanan -> paru-paru — sengaja dipisah kiri/kanan biar jalurnya tidak
// perlu saling menyilang untuk dibaca.
function renderCirculationSVG(cfg) {
  const width = 520, height = 460;
  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  svg += `<text x="${(width / 2).toFixed(1)}" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#000000">Peredaran Darah Ganda</text>`;

  const MERAH = '#dc2626', BIRU = '#2563eb';
  const cx = width / 2;

  // Paru-paru (dua bentuk paru sederhana berdampingan).
  const paruY = 90;
  svg += `<ellipse cx="${cx - 55}" cy="${paruY}" rx="55" ry="38" fill="#fecaca" stroke="#000000" stroke-width="1.3"/>`;
  svg += `<ellipse cx="${cx + 55}" cy="${paruY}" rx="55" ry="38" fill="#fecaca" stroke="#000000" stroke-width="1.3"/>`;
  svg += `<text x="${cx.toFixed(1)}" y="${(paruY + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#000000">Paru-paru</text>`;

  // Jantung: kotak 2x2 (serambi atas, bilik bawah), septum tengah memisah
  // kiri (merah)/kanan (biru).
  const hL = cx - 90, hR = cx + 90, hT = 190, hMidY = 255, hB = 320, hMidX = cx;
  svg += `<rect x="${hL}" y="${hT}" width="${hR - hL}" height="${hB - hT}" rx="10" fill="none" stroke="#000000" stroke-width="2"/>`;
  svg += `<line x1="${hMidX}" y1="${hT}" x2="${hMidX}" y2="${hB}" stroke="#000000" stroke-width="1.5"/>`;
  svg += `<line x1="${hL}" y1="${hMidY}" x2="${hR}" y2="${hMidY}" stroke="#000000" stroke-width="1.5"/>`;
  svg += `<rect x="${hL + 2}" y="${hT + 2}" width="${hMidX - hL - 4}" height="${hMidY - hT - 4}" fill="#fee2e2"/>`; // serambi kiri
  svg += `<rect x="${hMidX + 2}" y="${hT + 2}" width="${hR - hMidX - 4}" height="${hMidY - hT - 4}" fill="#dbeafe"/>`; // serambi kanan
  svg += `<rect x="${hL + 2}" y="${hMidY + 2}" width="${hMidX - hL - 4}" height="${hB - hMidY - 4}" fill="#fecaca"/>`; // bilik kiri
  svg += `<rect x="${hMidX + 2}" y="${hMidY + 2}" width="${hR - hMidX - 4}" height="${hB - hMidY - 4}" fill="#bfdbfe"/>`; // bilik kanan
  svg += `<text x="${(hL + (hMidX - hL) / 2).toFixed(1)}" y="${(hT + 18).toFixed(1)}" text-anchor="middle" font-size="9.5" fill="#000000">Serambi Kiri</text>`;
  svg += `<text x="${(hMidX + (hR - hMidX) / 2).toFixed(1)}" y="${(hT + 18).toFixed(1)}" text-anchor="middle" font-size="9.5" fill="#000000">Serambi Kanan</text>`;
  svg += `<text x="${(hL + (hMidX - hL) / 2).toFixed(1)}" y="${(hB - 10).toFixed(1)}" text-anchor="middle" font-size="9.5" fill="#000000">Bilik Kiri</text>`;
  svg += `<text x="${(hMidX + (hR - hMidX) / 2).toFixed(1)}" y="${(hB - 10).toFixed(1)}" text-anchor="middle" font-size="9.5" fill="#000000">Bilik Kanan</text>`;
  svg += `<text x="${hMidX.toFixed(1)}" y="${(hT - 8).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#000000">Jantung</text>`;

  // Internal: serambi -> bilik (katup), tiap sisi.
  const serambiKiriX = hL + (hMidX - hL) / 2, serambiKananX = hMidX + (hR - hMidX) / 2;
  svg += arrowSVG(serambiKiriX, hMidY - 20, serambiKiriX, hMidY + 20, { color: MERAH, strokeWidth: 1.6, headLen: 7 });
  svg += arrowSVG(serambiKananX, hMidY - 20, serambiKananX, hMidY + 20, { color: BIRU, strokeWidth: 1.6, headLen: 7 });

  // Tubuh (kotak jaringan tubuh).
  const tubuhY = 400;
  svg += `<rect x="${cx - 120}" y="${tubuhY - 28}" width="240" height="56" rx="10" fill="#fde68a" stroke="#000000" stroke-width="1.3"/>`;
  svg += `<text x="${cx.toFixed(1)}" y="${(tubuhY + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#000000">Seluruh Tubuh (Jaringan)</text>`;

  // Jalur MERAH (kiri): paru-paru -> serambi kiri -> tubuh.
  svg += elbowArrowSVG([[cx - 55, paruY + 38], [serambiKiriX, hT - 4]], { color: MERAH });
  svg += cellPartLabel(serambiKiriX - 70, (paruY + hT) / 2, 'Vena Pulmonalis', 'start');
  svg += elbowArrowSVG([[serambiKiriX, hB + 4], [cx - 55, tubuhY - 28 - 4]], { color: MERAH });
  svg += cellPartLabel(serambiKiriX - 55, (hB + tubuhY - 28) / 2, 'Aorta', 'start');

  // Jalur BIRU (kanan): tubuh -> serambi kanan -> paru-paru. Keduanya
  // lewat sisi LUAR kanan jantung lewat lorong berbeda (x berbeda) supaya
  // tidak menembus bilik/serambi yang bukan tujuannya — cuma bersilangan
  // satu kali di luar kotak jantung, yang wajar untuk pembuluh nyata.
  svg += elbowArrowSVG([[cx + 55, tubuhY - 28 - 4], [hR + 50, tubuhY - 28 - 4], [hR + 50, hT + 15], [hR - 4, hT + 15]], { color: BIRU });
  svg += cellPartLabel(hR + 54, (hB + tubuhY - 28) / 2, 'Vena Kava', 'start');
  svg += elbowArrowSVG([[hR - 4, hMidY + 22], [hR + 30, hMidY + 22], [hR + 30, paruY + 20], [cx + 55, paruY + 38]], { color: BIRU });
  svg += cellPartLabel(hR + 34, hMidY + 18, 'Arteri', 'start');
  svg += cellPartLabel(hR + 34, hMidY + 32, 'Pulmonalis', 'start');

  return svg + '</svg>';
}

// Sistem pencernaan (jalur tunggal dari mulut ke anus): usus besar digambar
// sebagai bingkai (frame) di sekeliling usus halus yang berkelok-kelok di
// dalamnya — sengaja meniru posisi anatomis asli (usus besar naik di kanan,
// melintang di atas, turun di kiri), bukan cuma dua kotak terpisah, supaya
// tetap dikenali sebagai "organ yang membungkus organ lain".
function renderDigestiveSVG(cfg) {
  const width = 380, height = 560;
  const cx = width / 2;
  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  svg += `<text x="${(width / 2).toFixed(1)}" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#000000">Sistem Pencernaan Manusia</text>`;

  const parts = [];

  // Usus besar (large intestine) — bingkai "U" terbalik di sekeliling usus
  // halus, digambar DULUAN (lapisan bawah) supaya usus halus tampak berada
  // di dalamnya.
  const bL = 75, bR = 305, bT = 205, bB = 460;
  svg += `<path d="M ${bR} ${bB} L ${bR} ${bT} L ${bL} ${bT} L ${bL} ${bB} Q ${bL} ${bB + 30} ${cx} ${bB + 30} L ${cx} ${height - 40}"
    fill="none" stroke="#d97706" stroke-width="17" stroke-linejoin="round" stroke-linecap="round"/>`;
  parts.push({ x: bL, y: (bT + bB) / 2, label: 'Usus Besar', lx: 12, ly: (bT + bB) / 2 - 30, anchor: 'start' });

  // Usus halus (small intestine) — garis berkelok di DALAM bingkai usus besar.
  const rows = 6, rowTop = bT + 30, rowGap = (bB - 30 - rowTop) / (rows - 1);
  const zL = bL + 45, zR = bR - 45;
  let ususPath = `M ${zL} ${rowTop}`;
  for (let i = 0; i < rows; i++) {
    const y = rowTop + i * rowGap;
    const goRight = i % 2 === 0;
    ususPath += ` L ${goRight ? zR : zL} ${y}`;
    if (i < rows - 1) ususPath += ` L ${goRight ? zR : zL} ${y + rowGap}`;
  }
  svg += `<path d="${ususPath}" fill="none" stroke="#f59e0b" stroke-width="9" stroke-linejoin="round" stroke-linecap="round"/>`;
  parts.push({ x: (zL + zR) / 2, y: rowTop + 2 * rowGap, label: 'Usus Halus', lx: cx + 95, ly: rowTop + 2 * rowGap, anchor: 'start' });
  const ususHalusEndY = rowTop + (rows - 1) * rowGap;
  const ususHalusEndX = (rows - 1) % 2 === 0 ? zR : zL;

  // Mulut -> kerongkongan -> lambung -> usus halus.
  svg += `<ellipse cx="${cx}" cy="30" rx="16" ry="9" fill="#fecaca" stroke="#000000" stroke-width="1.3"/>`;
  parts.push({ x: cx, y: 30, label: 'Mulut', lx: cx + 60, ly: 30, anchor: 'start' });
  svg += `<line x1="${cx}" y1="39" x2="${cx}" y2="95" stroke="#000000" stroke-width="4"/>`;
  parts.push({ x: cx, y: 67, label: 'Kerongkongan', lx: cx + 60, ly: 67, anchor: 'start' });
  svg += `<ellipse cx="${cx - 5}" cy="140" rx="48" ry="34" fill="#fda4af" stroke="#000000" stroke-width="1.4" transform="rotate(-18 ${cx - 5} 140)"/>`;
  parts.push({ x: cx - 5, y: 140, label: 'Lambung', lx: cx + 95, ly: 140, anchor: 'start' });
  svg += `<line x1="${cx + 15}" y1="168" x2="${zL}" y2="${rowTop - 4}" stroke="#000000" stroke-width="4"/>`;

  // Usus halus -> usus besar (sambungan sekum, kanan bawah bingkai).
  svg += `<line x1="${ususHalusEndX}" y1="${ususHalusEndY}" x2="${bR - 8}" y2="${bB - 8}" stroke="#000000" stroke-width="2" stroke-dasharray="3,3"/>`;

  // Anus, ujung bawah bingkai.
  svg += `<ellipse cx="${cx}" cy="${height - 40}" rx="10" ry="7" fill="#d97706" stroke="#000000" stroke-width="1.2"/>`;
  parts.push({ x: cx, y: height - 40, label: 'Anus', lx: cx + 55, ly: height - 40, anchor: 'start' });

  parts.forEach((p) => {
    svg += cellLeader(p.x, p.y, p.lx, p.ly);
    svg += cellPartLabel(p.lx + (p.anchor === 'end' ? -3 : 3), p.ly + 3, p.label, p.anchor);
  });

  return svg + '</svg>';
}

// ---------------------------------------------------------------------
// 6d1. Bentuk Gigi (identifikasi jenis gigi)
// ---------------------------------------------------------------------

// Siluet gigi TANPA label teks — dipakai untuk soal "sebutkan nama gigi ini"
// di mana nama jenisnya justru jawaban yang dicari (lihat DIAGRAM_DOCS:
// jangan sampai gambar membocorkan jawaban). Garis putus-putus menandai
// batas mahkota/akar (leher gigi), konvensi umum diagram gigi di buku teks.
const GIGI_BENTUK = {
  seri: {
    d: 'M -18,12 Q -20,2 -10,-2 Q 0,-5 10,-2 Q 20,2 18,12 L 15,56 Q 15,62 12,67 L 7,118 Q 4,128 0,128 Q -4,128 -7,118 L -12,67 Q -15,62 -15,56 Z',
    gumY: 60, gumHalfW: 14, extent: [-20, -5, 20, 128],
  },
  taring: {
    d: 'M 0,-10 Q 14,-3 17,12 L 15,54 Q 15,60 12,65 L 8,108 Q 4,118 0,118 Q -4,118 -8,108 L -12,65 Q -15,60 -15,54 L -17,12 Q -14,-3 0,-10 Z',
    gumY: 58, gumHalfW: 15, extent: [-18, -10, 18, 118],
  },
  'geraham-depan': {
    d: 'M -20,10 Q -22,-1 -13,-5 Q -9,-8 -6,-3 Q -3,1 0,2 Q 3,1 6,-3 Q 9,-8 13,-5 Q 22,-1 20,10 L 16,56 Q 16,63 13,68 L 7,116 Q 4,125 0,125 Q -4,125 -7,116 L -13,68 Q -16,63 -16,56 Z',
    gumY: 61, gumHalfW: 15, extent: [-22, -8, 22, 125],
  },
  geraham: {
    d: 'M -26,14 Q -28,0 -19,-4 Q -15,-8 -11,-3 Q -8,1 -4,-1 Q -1,-3 0,-1 Q 1,-3 4,-1 Q 8,1 11,-3 Q 15,-8 19,-4 Q 28,0 26,14 L 23,58 L -23,58 Z'
      + ' M -19,58 Q -24,90 -17,118 Q -14,127 -10,122 Q -14,92 -9,59 Z'
      + ' M 19,58 Q 24,90 17,118 Q 14,127 10,122 Q 14,92 9,59 Z',
    gumY: 58, gumHalfW: 24, extent: [-28, -8, 28, 127],
  },
};
GIGI_BENTUK.molar = GIGI_BENTUK.geraham;
GIGI_BENTUK.premolar = GIGI_BENTUK['geraham-depan'];
GIGI_BENTUK.canine = GIGI_BENTUK.taring;
GIGI_BENTUK.incisor = GIGI_BENTUK.seri;

function renderGigiSVG(cfg) {
  const tipe = String(cfg.tipe || 'seri').toLowerCase();
  const bentuk = GIGI_BENTUK[tipe] || GIGI_BENTUK.seri;
  const b = kotakBatas();
  const [x0, y0, x1, y1] = bentuk.extent;
  b.titik(x0, y0); b.titik(x1, y1);
  let isi = `<path d="${bentuk.d}" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  isi += `<path d="M ${-bentuk.gumHalfW},${bentuk.gumY} Q 0,${bentuk.gumY + 4} ${bentuk.gumHalfW},${bentuk.gumY}" `
       + `fill="none" stroke="${GAYA.hitam}" stroke-width="0.8" stroke-dasharray="3,2.2"/>`;
  // Label eksplisit (cfg.label) OPT-IN saja — dipakai kalau diagram ini bukan
  // untuk soal "sebutkan nama gigi ini" (mis. soal lain yang kebetulan perlu
  // gigi berlabel). Tanpa cfg.label (kasus biasa), tidak ada teks sama sekali.
  if (cfg.label) {
    const txt = String(cfg.label);
    isi += `<text x="0" y="${y1 + 16}" text-anchor="middle" font-size="${GAYA.teks}" fill="${GAYA.hitam}">${escText(txt)}</text>`;
    b.teks(0, y1 + 16, txt, GAYA.teks, 'middle');
  }
  return bungkusGambarSVG(isi, b, false);
}

// ---------------------------------------------------------------------
// 6d2. IPAS SD/SMP — wajah hewan, lengkung rahang, siklus air, wujud zat,
// pesawat sederhana, tata surya, magnet
// ---------------------------------------------------------------------

// Wajah hewan sederhana (garis hitam-putih, bukan kartun berwarna — tetap
// satu gaya dengan diagram lain) untuk soal "hewan ini makan apa?"
// (herbivora/karnivora/omnivora). TANPA label nama hewan: itu jawabannya.
function renderAnimalFaceSVG(cfg) {
  const tipe = String(cfg.tipe || 'kucing').toLowerCase();
  const b = kotakBatas();
  const R = 50;
  let isi = '';
  const dot = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${GAYA.hitam}"/>`;
  const head = () => `<circle cx="0" cy="0" r="${R}" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  const eyes = () => dot(-17, -8, 4) + dot(17, -8, 4);
  const smile = () => `<path d="M -15,18 Q 0,28 15,18" fill="none" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
  b.titik(-R - 20, -R - 25); b.titik(R + 20, R + 10);

  if (tipe === 'sapi' || tipe === 'cow') {
    isi += `<path d="M -22,-44 Q -30,-60 -18,-62 Q -14,-50 -16,-40 Z" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    isi += `<path d="M 22,-44 Q 30,-60 18,-62 Q 14,-50 16,-40 Z" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    isi += `<ellipse cx="-50" cy="-6" rx="11" ry="15" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    isi += `<ellipse cx="50" cy="-6" rx="11" ry="15" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    isi += head() + eyes();
    isi += `<path d="M -28,38 Q -22,24 0,22 Q 22,24 28,38 Q 22,50 0,50 Q -22,50 -28,38 Z" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    isi += dot(-9, 36, 2.2) + dot(9, 36, 2.2);
    isi += `<path d="M -40,10 Q -44,16 -38,22 Z" fill="${GAYA.hitam}"/><path d="M 30,-30 Q 38,-28 34,-20 Z" fill="${GAYA.hitam}"/>`;
  } else if (tipe === 'singa' || tipe === 'lion') {
    const n = 14, mr = 66;
    let mane = '';
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const mx = mr * 0.76 * Math.cos(a), my = mr * 0.76 * Math.sin(a);
      const degA = (a * 180) / Math.PI;
      mane += `<ellipse cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" rx="12" ry="20" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.1" transform="rotate(${degA.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)})"/>`;
      b.titik(mx, my, 20);
    }
    isi += mane + head() + eyes() + smile();
    isi += `<ellipse cx="0" cy="8" rx="13" ry="9" fill="none" stroke="${GAYA.hitam}" stroke-width="1.1"/>`;
    isi += `<path d="M -4,3 L 0,9 L 4,3 Z" fill="${GAYA.hitam}"/>`;
  } else if (tipe === 'beruang' || tipe === 'bear') {
    isi += `<circle cx="-34" cy="-40" r="15" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    isi += `<circle cx="34" cy="-40" r="15" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    isi += head() + eyes();
    isi += `<ellipse cx="0" cy="18" rx="20" ry="15" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
    isi += `<ellipse cx="0" cy="12" rx="6" ry="4.5" fill="${GAYA.hitam}"/>`;
    isi += `<path d="M 0,16 L 0,24 M 0,24 Q -8,30 -14,26 M 0,24 Q 8,30 14,26" fill="none" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    b.titik(-49, -55); b.titik(49, -55);
  } else if (tipe === 'kelinci' || tipe === 'rabbit') {
    isi += `<path d="M -22,-45 Q -30,-95 -14,-96 Q -8,-50 -10,-40 Z" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    isi += `<path d="M 22,-45 Q 30,-95 14,-96 Q 8,-50 10,-40 Z" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    isi += head() + eyes();
    isi += `<path d="M -3,16 L 3,16 L 0,22 Z" fill="${GAYA.hitam}"/>`;
    isi += `<path d="M 0,22 L 0,28 M 0,28 L -16,22 M 0,28 L -16,32 M 0,28 L 16,22 M 0,28 L 16,32" fill="none" stroke="${GAYA.hitam}" stroke-width="0.9"/>`;
    isi += `<path d="M -8,30 Q 0,38 8,30" fill="none" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    b.titik(-32, -98); b.titik(32, -98);
  } else if (tipe === 'kucing' || tipe === 'cat') {
    isi += `<path d="M -38,-38 L -22,-20 L -42,-14 Z" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    isi += `<path d="M 38,-38 L 22,-20 L 42,-14 Z" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    isi += head() + eyes();
    isi += `<path d="M -3,14 L 3,14 L 0,19 Z" fill="${GAYA.hitam}"/>`;
    isi += `<path d="M -36,10 L -8,8 M -36,18 L -8,14 M -36,26 L -8,20" stroke="${GAYA.hitam}" stroke-width="0.8"/>`;
    isi += `<path d="M 36,10 L 8,8 M 36,18 L 8,14 M 36,26 L 8,20" stroke="${GAYA.hitam}" stroke-width="0.8"/>`;
    isi += `<path d="M -6,20 Q 0,26 6,20" fill="none" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    b.titik(-42, -40); b.titik(42, -40);
  } else { // manusia / child
    isi += `<path d="M -51,-4 Q -56,-46 0,-52 Q 56,-46 51,-4 Q 46,-30 0,-32 Q -46,-30 -51,-4 Z" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    isi += head() + eyes() + smile();
    isi += `<ellipse cx="-50" cy="2" rx="7" ry="10" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.1"/>`;
    isi += `<ellipse cx="50" cy="2" rx="7" ry="10" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.1"/>`;
    isi += `<path d="M 0,-2 L -2,8 L 2,8 Z" fill="none" stroke="${GAYA.hitam}" stroke-width="1"/>`;
    b.titik(-57, -53); b.titik(57, -53);
  }

  if (cfg.label) {
    const txt = String(cfg.label);
    isi += `<text x="0" y="${R + 24}" text-anchor="middle" font-size="${GAYA.teks}" fill="${GAYA.hitam}">${escText(txt)}</text>`;
    b.teks(0, R + 24, txt, GAYA.teks, 'middle');
  }
  return bungkusGambarSVG(isi, b, false);
}

// Lengkung rahang (denah dari atas) — dipakai utk soal "tunjukkan/sebutkan
// nama gigi A/B/C pada gambar". Tiga zona gigi di tiap sisi: depan (seri,
// bulatan kecil), taring-kiri/kanan (tanda "/"), geraham-kiri/kanan (tanda
// "+", dua titik per sisi). tunjuk=Label:zona,... menaruh penunjuk
// berlabel pada zona itu (zona: depan, taring-kiri, taring-kanan,
// geraham-kiri, geraham-kanan).
const GIGI_ZONA = {
  depan: { x: 0, y: -6 },
  'taring-kiri': { x: -56, y: 18 },
  'taring-kanan': { x: 56, y: 18 },
  'geraham-kiri': { x: -68, y: 65 },
  'geraham-kanan': { x: 68, y: 65 },
};
function renderLengkungRahangSVG(cfg) {
  const b = kotakBatas();
  const archD = 'M -70,150 C -70,40 -40,-6 0,-6 C 40,-6 70,40 70,150';
  let isi = `<path d="${archD}" fill="none" stroke="${GAYA.hitam}" stroke-width="40" stroke-linecap="round"/>`;
  isi += `<path d="${archD}" fill="none" stroke="${GAYA.putih}" stroke-width="34" stroke-linecap="round"/>`;
  b.titik(-92, -8); b.titik(92, 170);

  // Zona depan: 4 bulatan kecil (gigi seri) di puncak lengkungan.
  [-18, -6, 6, 18].forEach((dx) => { isi += `<circle cx="${dx}" cy="-6" r="4.5" fill="none" stroke="${GAYA.hitam}" stroke-width="1"/>`; });
  // Taring: satu tanda miring tiap sisi.
  ['taring-kiri', 'taring-kanan'].forEach((z) => {
    const p = GIGI_ZONA[z], s = z.endsWith('kiri') ? -1 : 1;
    isi += `<line x1="${p.x - 5 * s}" y1="${p.y - 6}" x2="${p.x + 5 * s}" y2="${p.y + 6}" stroke="${GAYA.hitam}" stroke-width="1.6"/>`;
  });
  // Geraham: dua tanda "+" tiap sisi, menyusur ke belakang.
  ['geraham-kiri', 'geraham-kanan'].forEach((z) => {
    const p = GIGI_ZONA[z];
    [0, 32].forEach((dy) => {
      const y = p.y + dy;
      isi += `<line x1="${p.x - 5}" y1="${y}" x2="${p.x + 5}" y2="${y}" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
      isi += `<line x1="${p.x}" y1="${y - 5}" x2="${p.x}" y2="${y + 5}" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
    });
  });

  isi += `<text x="0" y="-26" text-anchor="middle" font-size="${GAYA.teksKecil}" fill="${GAYA.abu}" font-style="italic">depan mulut</text>`;
  isi += `<text x="0" y="192" text-anchor="middle" font-size="${GAYA.teksKecil}" fill="${GAYA.abu}" font-style="italic">belakang mulut</text>`;
  b.teks(0, -26, 'depan mulut', GAYA.teksKecil, 'middle');
  b.teks(0, 192, 'belakang mulut', GAYA.teksKecil, 'middle');

  const tunjuk = String(cfg.tunjuk || 'A:depan,B:taring-kanan,C:geraham-kanan')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((tok) => { const [label, zona] = tok.split(':').map((s) => s.trim()); return { label, zona }; });
  tunjuk.forEach(({ label, zona }) => {
    const p = GIGI_ZONA[zona];
    if (!p) return;
    const side = p.x < -2 ? -1 : p.x > 2 ? 1 : 0;
    const lx = p.x + side * 55 || 85, ly = p.y;
    isi += cellLeader(p.x, p.y, lx, ly);
    isi += `<circle cx="${lx}" cy="${ly}" r="11" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    isi += `<text x="${lx}" y="${ly + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="${GAYA.hitam}">${escText(label)}</text>`;
    b.titik(lx - 11, ly - 11); b.titik(lx + 11, ly + 11);
  });

  return bungkusGambarSVG(isi, b, false);
}

// Siklus air: matahari, awan, gunung, laut, dan tiga panah tahapan
// (penguapan/presipitasi/aliran permukaan). Tidak ada parameter — urutannya
// selalu sama, cuma labelnya yang dibaca ulang siswa.
function renderWaterCycleSVG(cfg) {
  const W = 420, H = 320;
  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  svg += `<text x="${W / 2}" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#000">Siklus Air</text>`;

  const seaY = H - 46;
  // Laut: garis gelombang berulang.
  let wave = `M 20,${seaY}`;
  for (let x = 20; x < W - 20; x += 20) wave += ` Q ${x + 10},${seaY - 7} ${x + 20},${seaY}`;
  svg += `<path d="${wave}" fill="none" stroke="#000" stroke-width="1.4"/>`;
  svg += `<line x1="18" y1="${seaY + 10}" x2="${W - 18}" y2="${seaY + 10}" stroke="#000" stroke-width="1.4"/>`;
  svg += `<text x="60" y="${seaY + 28}" text-anchor="middle" font-size="10.5" fill="#000">Laut</text>`;

  // Gunung: segitiga di sisi kanan, kaki menyentuh garis laut.
  const gx = W - 110;
  svg += `<path d="M ${gx - 55},${seaY} L ${gx},${seaY - 100} L ${gx + 55},${seaY} Z" fill="#fff" stroke="#000" stroke-width="1.4"/>`;
  svg += `<path d="M ${gx - 14},${seaY - 76} L ${gx},${seaY - 100} L ${gx + 14},${seaY - 76} L ${gx + 6},${seaY - 80} L ${gx},${seaY - 90} L ${gx - 6},${seaY - 80} Z" fill="#fff" stroke="#000" stroke-width="1"/>`;
  svg += `<text x="${gx}" y="${seaY + 16}" text-anchor="middle" font-size="10.5" fill="#000">Gunung</text>`;

  // Matahari: pojok kiri atas.
  const sx = 55, sy = 50;
  svg += `<circle cx="${sx}" cy="${sy}" r="20" fill="#fff" stroke="#000" stroke-width="1.4"/>`;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    svg += `<line x1="${(sx + 25 * Math.cos(a)).toFixed(1)}" y1="${(sy + 25 * Math.sin(a)).toFixed(1)}" x2="${(sx + 34 * Math.cos(a)).toFixed(1)}" y2="${(sy + 34 * Math.sin(a)).toFixed(1)}" stroke="#000" stroke-width="1.2"/>`;
  }

  // Awan: beberapa lingkaran bertumpuk, di atas gunung.
  const cx2 = gx - 20, cy2 = 56;
  svg += `<circle cx="${cx2 - 22}" cy="${cy2 + 6}" r="16" fill="#fff" stroke="#000" stroke-width="1.3"/>`;
  svg += `<circle cx="${cx2}" cy="${cy2 - 6}" r="22" fill="#fff" stroke="#000" stroke-width="1.3"/>`;
  svg += `<circle cx="${cx2 + 24}" cy="${cy2 + 6}" r="17" fill="#fff" stroke="#000" stroke-width="1.3"/>`;
  svg += `<rect x="${cx2 - 40}" y="${cy2 + 6}" width="80" height="16" fill="#fff" stroke="none"/>`;
  svg += `<line x1="${cx2 - 40}" y1="${cy2 + 20}" x2="${cx2 + 40}" y2="${cy2 + 20}" stroke="#fff" stroke-width="0"/>`;
  svg += `<text x="${cx2}" y="${cy2 - 32}" text-anchor="middle" font-size="10.5" fill="#000">Awan (Kondensasi)</text>`;

  // Panah 1: Penguapan (laut -> awan).
  svg += arrowSVG(sx + 60, seaY - 30, cx2 - 50, cy2 + 40, { strokeWidth: 1.6, dash: '4 3' });
  svg += `<text x="${(sx + cx2) / 2 - 20}" y="${seaY - 60}" text-anchor="middle" font-size="10" fill="#000">Penguapan</text>`;

  // Panah 2: Presipitasi (awan -> gunung), beberapa garis hujan pendek.
  for (let i = -1; i <= 1; i++) {
    svg += arrowSVG(cx2 + i * 14, cy2 + 30, gx + i * 10, seaY - 90, { strokeWidth: 1.3, headLen: 6 });
  }
  svg += `<text x="${cx2 + 50}" y="${(cy2 + seaY - 90) / 2 - 10}" text-anchor="middle" font-size="10" fill="#000">Presipitasi</text>`;

  // Panah 3: Aliran permukaan (gunung -> laut).
  svg += arrowSVG(gx + 40, seaY - 20, gx + 90, seaY - 2, { strokeWidth: 1.6 });
  svg += `<text x="${gx + 70}" y="${seaY - 28}" text-anchor="middle" font-size="9.5" fill="#000">Aliran${' '}permukaan</text>`;

  svg += '</svg>';
  return svg;
}

// Tiga wujud zat (padat/cair/gas) sebagai kotak partikel + panah perubahan
// wujud berlabel di antaranya. Tidak ada parameter.
function renderStatesOfMatterSVG(cfg) {
  const W = 460, H = 230;
  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="#ffffff" stroke="#d8dce1"/>`;

  const boxW = 100, boxH = 100, boxY = 50;
  const boxX = [20, 180, 340];
  const titles = ['Padat', 'Cair', 'Gas'];
  boxX.forEach((x, i) => {
    svg += `<rect x="${x}" y="${boxY}" width="${boxW}" height="${boxH}" fill="#fff" stroke="#000" stroke-width="1.4"/>`;
    svg += `<text x="${x + boxW / 2}" y="${boxY + boxH + 20}" text-anchor="middle" font-size="12" font-weight="700" fill="#000">${titles[i]}</text>`;
    if (i === 0) { // padat: grid rapat
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        svg += `<circle cx="${x + 14 + c * 24}" cy="${boxY + 14 + r * 24}" r="6" fill="#000"/>`;
      }
    } else if (i === 1) { // cair: gerombol longgar di bawah
      const pts = [[14, 70], [34, 82], [54, 68], [74, 84], [20, 92], [86, 70], [50, 50], [70, 56], [30, 56]];
      pts.forEach(([dx, dy]) => { svg += `<circle cx="${x + dx}" cy="${boxY + dy}" r="6" fill="#000"/>`; });
    } else { // gas: tersebar jarang
      const pts = [[12, 14], [60, 24], [85, 60], [30, 50], [70, 85], [15, 80], [50, 65], [90, 15]];
      pts.forEach(([dx, dy]) => { svg += `<circle cx="${x + dx}" cy="${boxY + dy}" r="5" fill="#000"/>`; });
    }
  });

  // Panah dua arah antara tiap pasangan kotak, dua label (naik & turun).
  const pair = (x1, x2, atas, bawah) => {
    const y = boxY + boxH / 2;
    let s = arrowSVG(x1, y - 12, x2, y - 12, { strokeWidth: 1.4, headLen: 7 });
    s += arrowSVG(x2, y + 12, x1, y + 12, { strokeWidth: 1.4, headLen: 7 });
    s += `<text x="${(x1 + x2) / 2}" y="${y - 18}" text-anchor="middle" font-size="9.5" fill="#000">${atas}</text>`;
    s += `<text x="${(x1 + x2) / 2}" y="${y + 28}" text-anchor="middle" font-size="9.5" fill="#000">${bawah}</text>`;
    return s;
  };
  svg += pair(boxX[0] + boxW + 4, boxX[1] - 4, 'Mencair', 'Membeku');
  svg += pair(boxX[1] + boxW + 4, boxX[2] - 4, 'Menguap', 'Mengembun');

  svg += '</svg>';
  return svg;
}

// Pesawat sederhana: tuas/katrol/bidang miring/roda berporos.
// Pesawat sederhana BERNILAI (soal keuntungan mekanis): tuas dengan batu dan
// panjang lengan, bidang miring dengan panjang/tinggi, sistem katrol dengan
// n tali penopang. Dipakai renderSimpleMachineSVG bila tag memuat parameter
// angkanya; tanpa parameter, gambar skema umum yang lama tetap dipakai.
function angkaLabel(t, def) {
  const v = parseFloat(String(t == null ? '' : t).replace(',', '.'));
  return isFinite(v) && v > 0 ? v : def;
}

function renderPesawatBernilaiSVG(cfg, tipe) {
  const b = kotakBatas();
  let isi = '';
  const teks = (x, y, t, anchor, italic) => {
    isi += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor || 'middle'}" font-size="11.5"${italic ? ' font-style="italic"' : ''} fill="${GAYA.hitam}" stroke="${GAYA.putih}" stroke-width="3" paint-order="stroke">${escText(t)}</text>`;
    b.teks(x, y, t, 11.5, anchor || 'middle');
  };
  // "w = 300 N" tetap miring pada "w"; selain itu teks biasa.
  const labelGaya = (x, y, t, anchor) => teks(x, y, t, anchor, /^[wWF]\b/.test(t) || t.length === 1);
  const wLabel = cfg.w != null && cfg.w !== '' ? (/[=]|^[A-Za-z]$/.test(cfg.w) ? cfg.w : `w = ${cfg.w}`) : 'w';
  const fLabel = cfg.f != null && cfg.f !== '' ? cfg.f : 'F';
  const garis = (x1, y1, x2, y2, tebal, dash) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${tebal || GAYA.garis}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

  if (tipe === 'tuas') {
    // Tuas miring: ujung beban rendah (batu), ujung kuasa tinggi; titik tumpu
    // di antaranya. Panjang lengan digambar sebanding dengan angka lb dan lk.
    const lbLabel = cfg.lb || cfg.lenganbeban || '', lkLabel = cfg.lk || cfg.lengankuasa || '';
    const lb = angkaLabel(lbLabel, 1), lk = angkaLabel(lkLabel, 3);
    const total = 250, lbPx = Math.max(45, Math.min(total - 45, (total * lb) / (lb + lk))), lkPx = total - lbPx;
    const th = (13 * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
    const B = [-lbPx * c, lbPx * s], K = [lkPx * c, -lkPx * s];
    const tanah = 26;
    const gKiri = B[0] - 55, gKanan = K[0] + 30;
    isi += garis(gKiri, tanah, gKanan, tanah, 2.2);
    b.titik(gKiri, tanah); b.titik(gKanan, tanah);
    isi += `<path d="M -15,${tanah} L 0,0 L 15,${tanah} Z" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    isi += garis(B[0], B[1], K[0], K[1], 4.5);
    // batu di ujung beban
    isi += `<path d="M ${(B[0] - 38).toFixed(1)},${(B[1] + 2).toFixed(1)} C ${(B[0] - 42).toFixed(1)},${(B[1] - 22).toFixed(1)} ${(B[0] - 10).toFixed(1)},${(B[1] - 34).toFixed(1)} ${(B[0] + 6).toFixed(1)},${(B[1] - 10).toFixed(1)} L ${(B[0] + 6).toFixed(1)},${(B[1] + 1).toFixed(1)} Z" fill="${GAYA.arsir}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    b.titik(B[0] - 42, B[1] - 34);
    labelGaya(B[0] - 20, B[1] - 46, wLabel, 'middle');
    isi += arrowSVG(K[0], K[1] - 40, K[0], K[1] - 4, { strokeWidth: 1.6, headLen: 7 });
    b.titik(K[0], K[1] - 40);
    labelGaya(K[0] + 8, K[1] - 36, fLabel, 'start');
    if (lbLabel) teks(B[0] * 0.55 - 4, B[1] * 0.55 - 12, lbLabel, 'middle');
    if (lkLabel) teks(K[0] * 0.55 + 4, K[1] * 0.55 - 12, lkLabel, 'middle');
  } else if (tipe === 'bidang-miring') {
    const L = angkaLabel(cfg.panjang, 5), H = angkaLabel(cfg.tinggi, 2.5);
    const ratio = Math.min(0.92, H / L);
    const maks = 230, alasPx = maks * Math.sqrt(1 - ratio * ratio), tinggiPx = maks * ratio;
    const A = [0, tinggiPx], Bp = [alasPx, tinggiPx], C = [alasPx, 0];       // kiri-bawah, kanan-bawah, puncak
    isi += `<path d="M ${A[0]},${A[1]} L ${Bp[0].toFixed(1)},${Bp[1]} L ${C[0].toFixed(1)},${C[1]} Z" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}" stroke-linejoin="round"/>`;
    b.titik(0, 0); b.titik(alasPx, tinggiPx);
    isi += rightAngleSVG(Bp[0], Bp[1], A[0], A[1], C[0], C[1], 9);
    const ang = Math.atan2(-(C[1] - A[1]), C[0] - A[0]);                       // arah lereng (y layar ke bawah)
    const deg = (-ang * 180) / Math.PI;                                         // derajat putar layar (negatif = naik ke kanan)
    const ux = Math.cos(ang), uy = -Math.sin(ang);                              // arah sepanjang lereng, ke atas-kanan di layar
    const nx = -uy, ny = ux;                                                    // normal ke atas-kiri
    const tNorm = (nx < 0 || ny < 0) ? [nx, ny] : [-nx, -ny];
    // balok di atas lereng, 30% dari ujung bawah
    const pos = 0.2 * maks, bw = 30, bh = 20;
    const cx = A[0] + ux * pos + tNorm[0] * (bh / 2), cy = A[1] + uy * pos + tNorm[1] * (bh / 2);
    isi += `<g transform="rotate(${(Math.atan2(uy, ux) * 180 / Math.PI).toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)})"><rect x="${(cx - bw / 2).toFixed(1)}" y="${(cy - bh / 2).toFixed(1)}" width="${bw}" height="${bh}" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/></g>`;
    b.titik(cx - 24, cy - 24); b.titik(cx + 24, cy + 24);
    // gaya berat: tegak ke bawah dari pusat balok; gaya tarik F: sepanjang lereng ke atas
    isi += arrowSVG(cx, cy + bh / 2, cx, cy + bh / 2 + 34, { strokeWidth: 1.6, headLen: 7 });
    labelGaya(cx + 6, cy + bh / 2 + 42, wLabel, 'start');
    const fx = cx + ux * 22 + tNorm[0] * 12, fy = cy + uy * 22 + tNorm[1] * 12;
    isi += arrowSVG(fx, fy, fx + ux * 30, fy + uy * 30, { strokeWidth: 1.6, headLen: 7 });
    labelGaya(fx - 2, fy - 4, fLabel, 'end');
    // panjang lereng (di atas sisi miring) dan tinggi (di kanan sisi tegak)
    const mx = A[0] + (C[0] - A[0]) * 0.66 + tNorm[0] * 13, my = A[1] + (C[1] - A[1]) * 0.66 + tNorm[1] * 13;
    if (cfg.panjang) teks(mx, my, cfg.panjang, 'middle');
    if (cfg.tinggi) teks(alasPx + 8, (C[1] + Bp[1]) / 2 + 4, cfg.tinggi, 'start');
    if (cfg.alas) teks(alasPx / 2, tinggiPx + 15, cfg.alas, 'middle');
    if (/^(ya|true|1)$/i.test(String(cfg.titik || ''))) {
      teks(A[0] - 6, A[1] + 16, 'X', 'end', true);
      teks(C[0], C[1] - 8, 'Y', 'middle', true);
    }
  } else { // katrol: n tali penopang
    const n = Math.max(1, Math.min(8, Math.round(angkaLabel(cfg.jumlah || cfg.n, 3))));
    const d = 22, r = 10, yTop = 34, yBot = 34 + 70;
    const xs = (i) => i * d;
    const awalBawah = n % 2 === 0;                    // genap: ujung tali di balok atas
    const busurAtas = (i) => (awalBawah ? i % 2 === 1 : i % 2 === 0);
    // langit-langit
    const lebar = (n + 1) * d;
    isi += garis(-24, 0, lebar + 24, 0, 2.2);
    isi += `<g>${arsirTumpuanSVG(-24, 0, lebar + 24, 0, 0, -1)}</g>`;
    b.titik(-24, -10); b.titik(lebar + 24, 0);
    // tali: kolom vertikal + busur di sekeliling katrol
    const pusat = (i) => (xs(i) + xs(i + 1)) / 2;
    for (let i = 0; i <= n; i++) {
      let y1 = yTop, y2 = yBot;
      if (i === 0 && awalBawah) y1 = 0;        // ujung tali terikat di balok atas (langit-langit)
      if (i === n) { y1 = yTop; y2 = yBot + 52; }
      isi += garis(xs(i), y1, xs(i), y2, 1.4);
    }
    for (let i = 0; i < n; i++) {
      const atas = busurAtas(i), cy = atas ? yTop : yBot, sweepUp = atas;
      isi += `<path d="M ${xs(i)},${cy} A ${r},${r} 0 0 ${sweepUp ? 1 : 0} ${xs(i + 1)},${cy}" fill="none" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
      isi += katrolSVG(pusat(i), cy, r);
    }
    // balok atas menggantung dari langit-langit
    const katAtas = []; for (let i = 0; i < n; i++) if (busurAtas(i)) katAtas.push(pusat(i));
    katAtas.forEach((x) => { isi += garis(x, 0, x, yTop, 1.2); });
    // balok bawah: batang melintang di bawah katrol bawah + gantungan + beban
    const katBawah = []; for (let i = 0; i < n; i++) if (!busurAtas(i)) katBawah.push(pusat(i));
    const bx1 = Math.min(xs(0), katBawah[0] - r) - 2, bx2 = Math.max(xs(n - 1), katBawah[katBawah.length - 1] + r) + 2;
    isi += garis(bx1, yBot + 16, bx2, yBot + 16, 2.4);
    katBawah.forEach((x) => { isi += garis(x, yBot, x, yBot + 16, 1.2); });
    if (!awalBawah) isi += garis(xs(0), yBot, xs(0), yBot + 16, 1.2);
    const hx = (bx1 + bx2) / 2;
    isi += garis(hx, yBot + 16, hx, yBot + 38, 1.4);
    isi += `<rect x="${(hx - 17).toFixed(1)}" y="${yBot + 38}" width="34" height="26" fill="${GAYA.arsir}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    b.titik(hx - 17, yBot + 64);
    labelGaya(hx, yBot + 80, wLabel, 'middle');
    b.titik(hx, yBot + 84);
    // gaya tarik F di ujung bebas
    const fy1 = yBot + 52;
    isi += arrowSVG(xs(n), fy1 - 18, xs(n), fy1 + 8, { strokeWidth: 1.6, headLen: 7 });
    b.titik(xs(n), fy1 + 8);
    labelGaya(xs(n) + 8, fy1 + 4, fLabel, 'start');
  }
  return bungkusGambarSVG(isi, b, false);
}

function renderSimpleMachineSVG(cfg) {
  const tipe = String(cfg.tipe || 'tuas').toLowerCase();
  // Tag yang membawa angka (soal keuntungan mekanis) memakai gambar bernilai.
  if ((tipe === 'tuas' || tipe === 'lever') && (cfg.lb || cfg.lk || cfg.w)) return renderPesawatBernilaiSVG(cfg, 'tuas');
  if ((tipe === 'bidang-miring' || tipe === 'incline') && (cfg.panjang || cfg.tinggi)) return renderPesawatBernilaiSVG(cfg, 'bidang-miring');
  if ((tipe === 'katrol' || tipe === 'pulley') && (cfg.jumlah || cfg.n)) return renderPesawatBernilaiSVG(cfg, 'katrol');
  const b = kotakBatas();
  let isi = '';
  const label = (x, y, t, anchor) => { isi += `<text x="${x}" y="${y}" text-anchor="${anchor || 'middle'}" font-size="${GAYA.teksKecil}" fill="${GAYA.hitam}">${escText(t)}</text>`; b.teks(x, y, t, GAYA.teksKecil, anchor || 'middle'); };

  if (tipe === 'katrol' || tipe === 'pulley') {
    isi += `<line x1="-40" y1="0" x2="40" y2="0" stroke="${GAYA.hitam}" stroke-width="3"/>`;
    isi += arsirTumpuanSVG(-40, 0, 40, 0, 0, -1);
    isi += `<line x1="0" y1="0" x2="0" y2="30" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
    isi += `<circle cx="0" cy="48" r="18" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/><circle cx="0" cy="48" r="2" fill="${GAYA.hitam}"/>`;
    isi += `<path d="M -18,48 A18,18 0 0 1 18,48" fill="none" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    isi += `<line x1="-18" y1="48" x2="-18" y2="130" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    isi += `<line x1="18" y1="48" x2="18" y2="110" stroke="${GAYA.hitam}" stroke-width="1.3"/>`;
    isi += `<rect x="-34" y="130" width="32" height="26" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    isi += arrowSVG(18, 110, 18, 72, { strokeWidth: 1.6 });
    label(-18, 170, 'Beban'); label(26, 94, 'Kuasa', 'start');
    b.titik(-40, -4); b.titik(40, 170);
  } else if (tipe === 'bidang-miring' || tipe === 'incline') {
    isi += `<path d="M -70,70 L 70,70 L 70,-50 Z" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    isi += arsirTumpuanSVG(-70, 70, 70, 70, 0, 1);
    isi += kotakBendaSVG(28, 35, 26, 20, 'B', -33.7);
    isi += arrowSVG(-5, 28, -45, 50, { strokeWidth: 1.6 });
    label(-30, 66, 'Kuasa');
    label(-78, 10, 'tinggi', 'end');
    isi += `<line x1="-70" y1="70" x2="-70" y2="-50" stroke="${GAYA.hitam}" stroke-width="${GAYA.garisBantu}" stroke-dasharray="${GAYA.putusHalus}"/>`;
    b.titik(-85, -55); b.titik(70, 85);
  } else if (tipe === 'roda' || tipe === 'wheel') {
    isi += `<circle cx="0" cy="0" r="46" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    isi += `<circle cx="0" cy="0" r="10" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; isi += `<line x1="${(10 * Math.cos(a)).toFixed(1)}" y1="${(10 * Math.sin(a)).toFixed(1)}" x2="${(46 * Math.cos(a)).toFixed(1)}" y2="${(46 * Math.sin(a)).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1"/>`; }
    isi += `<line x1="10" y1="0" x2="34" y2="0" stroke="${GAYA.hitam}" stroke-width="2.4"/><line x1="34" y1="-10" x2="34" y2="10" stroke="${GAYA.hitam}" stroke-width="2.4"/>`;
    label(0, 70, 'Roda'); label(0, -58, 'Poros (As)');
    b.titik(-46, -62); b.titik(46, 74);
  } else { // tuas
    const kelas = String(cfg.kelas || '1');
    const fx = kelas === '2' ? -60 : kelas === '3' ? 60 : 0;
    isi += `<line x1="-90" y1="0" x2="90" y2="0" stroke="${GAYA.hitam}" stroke-width="4"/>`;
    isi += `<path d="M ${fx - 14},26 L ${fx},0 L ${fx + 14},26 Z" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    const bx = kelas === '2' ? -20 : -90, kx = kelas === '3' ? 20 : 90;
    isi += arrowSVG(bx, -4, bx, -34, { strokeWidth: 1.6 });
    isi += arrowSVG(kx, -4, kx, -34, { strokeWidth: 1.6 });
    label(bx, -40, 'Beban'); label(kx, -40, 'Kuasa');
    label(fx, 42, 'Titik Tumpu');
    b.titik(-90, -40); b.titik(90, 42);
  }
  return bungkusGambarSVG(isi, b, false);
}

// Tata surya: matahari + 8 planet berurut, TANPA nama (soal "urutkan
// planet") kecuali label=ya. Ukuran relatif disederhanakan, bukan skala asli.
const PLANET_URUT = ['Merkurius', 'Venus', 'Bumi', 'Mars', 'Jupiter', 'Saturnus', 'Uranus', 'Neptunus'];
const PLANET_R = [5, 7, 7.5, 6, 16, 14, 10, 9.5];
function renderSolarSystemSVG(cfg) {
  const showLabel = String(cfg.label || 'tidak').toLowerCase() === 'ya';
  const b = kotakBatas();
  let isi = '';
  let x = -170;
  isi += `<circle cx="${x}" cy="0" r="26" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; isi += `<line x1="${(x + 29 * Math.cos(a)).toFixed(1)}" y1="${(29 * Math.sin(a)).toFixed(1)}" x2="${(x + 35 * Math.cos(a)).toFixed(1)}" y2="${(35 * Math.sin(a)).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1"/>`; }
  isi += `<text x="${x}" y="46" text-anchor="middle" font-size="${GAYA.teksKecil}" fill="${GAYA.hitam}">Matahari</text>`;
  b.titik(x - 36, -36); b.titik(x, 56);
  x += 48;
  PLANET_R.forEach((r, i) => {
    isi += `<circle cx="${x}" cy="0" r="${r}" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    if (i === 5) isi += `<ellipse cx="${x}" cy="0" rx="${r + 10}" ry="${r * 0.35}" fill="none" stroke="${GAYA.hitam}" stroke-width="1"/>`;
    const ty = r + (i === 5 ? 14 : 4) + 16;
    isi += `<text x="${x}" y="${ty}" text-anchor="middle" font-size="${GAYA.teksKecil}" fill="${GAYA.hitam}">${showLabel ? escText(PLANET_URUT[i]) : (i + 1)}</text>`;
    b.titik(x - r - 12, -r - 4); b.titik(x + r + 12, ty + 4);
    x += r + 32;
  });
  return bungkusGambarSVG(isi, b, false);
}

// Magnet batang: satu magnet (kutub U/S) atau dua magnet berdekatan
// (konfigurasi=tarik-menarik / tolak-menolak).
function renderMagnetSVG(cfg) {
  const konfig = String(cfg.konfigurasi || '').toLowerCase();
  const b = kotakBatas();
  let isi = '';
  const bar = (cx, flip) => {
    const kiri = flip ? 'S' : 'U', kanan = flip ? 'U' : 'S';
    let s = `<rect x="${cx - 50}" y="-20" width="50" height="40" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    s += `<rect x="${cx}" y="-20" width="50" height="40" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    s += `<text x="${cx - 25}" y="6" text-anchor="middle" font-size="15" font-weight="700" fill="${GAYA.hitam}">${kiri}</text>`;
    s += `<text x="${cx + 25}" y="6" text-anchor="middle" font-size="15" font-weight="700" fill="${GAYA.hitam}">${kanan}</text>`;
    b.titik(cx - 50, -20); b.titik(cx + 50, 20);
    return s;
  };
  if (konfig === 'tarik' || konfig === 'tarik-menarik' || konfig === 'tolak' || konfig === 'tolak-menolak') {
    const tarik = konfig.startsWith('tarik');
    isi += bar(-70, false);
    isi += bar(70, !tarik); // tarik: kutub berhadapan beda (S ketemu U); tolak: sama (S ketemu S)
    if (tarik) {
      isi += arrowSVG(-8, -34, -28, -34, { strokeWidth: 1.4, headLen: 6 });
      isi += arrowSVG(8, -34, 28, -34, { strokeWidth: 1.4, headLen: 6 });
    } else {
      isi += arrowSVG(-28, -34, -8, -34, { strokeWidth: 1.4, headLen: 6 });
      isi += arrowSVG(28, -34, 8, -34, { strokeWidth: 1.4, headLen: 6 });
    }
    isi += `<text x="0" y="40" text-anchor="middle" font-size="${GAYA.teksKecil}" fill="${GAYA.hitam}">${tarik ? 'tarik-menarik' : 'tolak-menolak'}</text>`;
    b.titik(0, 46);
  } else {
    isi += bar(0, false);
  }
  return bungkusGambarSVG(isi, b, false);
}

// ---------------------------------------------------------------------
// 9. Transformasi Geometri (translasi/refleksi/rotasi/dilatasi)
// ---------------------------------------------------------------------

// "A:1:1,B:4:1,C:1:5" -> [{name:'A',x:1,y:1}, ...]
function parseVertexList(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).map((tok) => {
    const bits = tok.split(':').map((s) => s.trim());
    return { name: bits[0] || '', x: parseFloat(bits[1]) || 0, y: parseFloat(bits[2]) || 0 };
  });
}

function applyGeoTransform(points, cfg) {
  const jenis = String(cfg.jenis || 'translasi').toLowerCase();
  if (jenis === 'refleksi') {
    const garis = String(cfg.garis || 'y-axis').toLowerCase();
    return points.map((p) => {
      let nx = p.x, ny = p.y;
      if (garis === 'x-axis' || garis === 'sumbu-x') ny = -p.y;
      else if (garis === 'y-axis' || garis === 'sumbu-y') nx = -p.x;
      else if (garis === 'y=x') { nx = p.y; ny = p.x; }
      else if (garis === 'y=-x') { nx = -p.y; ny = -p.x; }
      else if (garis.startsWith('x=')) nx = 2 * parseFloat(garis.slice(2)) - p.x;
      else if (garis.startsWith('y=')) ny = 2 * parseFloat(garis.slice(2)) - p.y;
      return { name: p.name + '′', x: nx, y: ny };
    });
  }
  if (jenis === 'rotasi') {
    const [px, py] = String(cfg.pusat || '0,0').split(',').map(Number);
    let sudut = numOrDefault(cfg.sudut, 90);
    if (String(cfg.arah || '').toLowerCase().startsWith('searah')) sudut = -sudut;
    const rad = (sudut * Math.PI) / 180;
    return points.map((p) => {
      const dx = p.x - px, dy = p.y - py;
      return { name: p.name + '′', x: px + dx * Math.cos(rad) - dy * Math.sin(rad), y: py + dx * Math.sin(rad) + dy * Math.cos(rad) };
    });
  }
  if (jenis === 'dilatasi') {
    const [px, py] = String(cfg.pusat || '0,0').split(',').map(Number);
    const k = numOrDefault(cfg.faktor, 2);
    return points.map((p) => ({ name: p.name + '′', x: px + (p.x - px) * k, y: py + (p.y - py) * k }));
  }
  // translasi (default)
  const [dx, dy] = String(cfg.vektor || '2,2').split(',').map(Number);
  return points.map((p) => ({ name: p.name + '′', x: p.x + dx, y: p.y + dy }));
}

function renderTransformSVG(cfg) {
  const orig = parseVertexList(cfg.titik);
  const points = orig.length ? orig : [{ name: 'A', x: 1, y: 1 }, { name: 'B', x: 4, y: 1 }, { name: 'C', x: 1, y: 5 }];
  const image = applyGeoTransform(points, cfg);
  const jenis = String(cfg.jenis || 'translasi').toLowerCase();
  const pusat = String(cfg.pusat || '0,0').split(',').map(Number);
  const garis = String(cfg.garis || 'y-axis').toLowerCase();
  const allPts = points.concat(image);
  const xs = allPts.map((p) => p.x), ys = allPts.map((p) => p.y);
  // Pusat rotasi/dilatasi dan cermin x=k / y=k ikut dihitung dalam jangkauan
  // sumbu: unsur yang menentukan transformasi harus terlihat di gambar.
  if (jenis === 'rotasi' || jenis === 'dilatasi') { xs.push(pusat[0]); ys.push(pusat[1]); }
  if (jenis === 'refleksi' && /^[xy]=-?[\d.]+$/.test(garis)) {
    const k = parseFloat(garis.slice(2));
    if (garis[0] === 'x') xs.push(k); else ys.push(k);
  }
  const xmin = Math.floor(numOrDefault(cfg.xmin, Math.min(0, ...xs) - 1)), xmax = Math.ceil(numOrDefault(cfg.xmax, Math.max(0, ...xs) + 1));
  const ymin = Math.floor(numOrDefault(cfg.ymin, Math.min(0, ...ys) - 1)), ymax = Math.ceil(numOrDefault(cfg.ymax, Math.max(0, ...ys) + 1));
  // Satu satuan = kotak grid; ukuran kotak dibatasi supaya grid 6 satuan
  // tidak raksasa dan grid 30 satuan tidak mengecil sampai angkanya bertumpuk.
  const unit = Math.max(11, Math.min(24, 240 / Math.max(xmax - xmin, ymax - ymin, 1)));
  const toPx = (x, y) => [(x - xmin) * unit, (ymax - y) * unit];
  const [X0, Y0] = toPx(xmin, ymax), [X1, Y1] = toPx(xmax, ymin);
  const step = niceStep(Math.max(xmax - xmin, ymax - ymin)) >= 2 ? 2 : 1;

  const b = kotakBatas();
  let isi = '';
  b.titik(X0, Y0); b.titik(X1, Y1);
  for (let gx = xmin; gx <= xmax; gx++) {
    const [px] = toPx(gx, 0);
    isi += `<line x1="${px.toFixed(1)}" y1="${Y0.toFixed(1)}" x2="${px.toFixed(1)}" y2="${Y1.toFixed(1)}" stroke="${GAYA.abuMuda}" stroke-width="0.7"/>`;
  }
  for (let gy = ymin; gy <= ymax; gy++) {
    const [, py] = toPx(0, gy);
    isi += `<line x1="${X0.toFixed(1)}" y1="${py.toFixed(1)}" x2="${X1.toFixed(1)}" y2="${py.toFixed(1)}" stroke="${GAYA.abuMuda}" stroke-width="0.7"/>`;
  }
  // Sumbu berpanah lewat titik asal (atau tepi grid bila 0 di luar jangkauan),
  // angka di tiap kotak (tiap 2 kotak bila grid lebar), O di titik asal.
  const ox = Math.min(Math.max(0, xmin), xmax), oy = Math.min(Math.max(0, ymin), ymax);
  const [axX, axY] = toPx(ox, oy);
  isi += sumbuSVG({ x0: axX, y0: axY, xEnd: X1 + 14, yEnd: Y0 - 14, labelX: 'x', labelY: 'y', strokeWidth: 1.2, xMulai: X0, yMulai: Y1 });
  b.titik(X1 + 16, axY + 16); b.titik(axX - 4, Y0 - 24);
  // Kotak angka sumbu: huruf titik yang menimpanya dipindah (lihat gambarPoligon).
  const kotakTeks = (x, y, t, size, anchor) => {
    const w = lebarTeksKira(t, size), x1 = anchor === 'end' ? x - w : anchor === 'start' ? x : x - w / 2;
    return { x1: x1 - 1, x2: x1 + w + 1, y1: y - size * 0.85, y2: y + size * 0.3 };
  };
  const terpakai = [];
  for (let gx = Math.ceil(xmin / step) * step; gx <= xmax; gx += step) {
    if (gx === ox) continue;
    const [px] = toPx(gx, 0);
    isi += `<text x="${px.toFixed(1)}" y="${(axY + 12).toFixed(1)}" font-size="${GAYA.teksKecil}" text-anchor="middle" fill="${GAYA.hitam}">${gx}</text>`;
    b.teks(px, axY + 12, String(gx), GAYA.teksKecil, 'middle');
    terpakai.push(kotakTeks(px, axY + 12, String(gx), GAYA.teksKecil, 'middle'));
  }
  for (let gy = Math.ceil(ymin / step) * step; gy <= ymax; gy += step) {
    if (gy === oy) continue;
    const [, py] = toPx(0, gy);
    isi += `<text x="${(axX - 5).toFixed(1)}" y="${(py + 3.5).toFixed(1)}" font-size="${GAYA.teksKecil}" text-anchor="end" fill="${GAYA.hitam}">${gy}</text>`;
    b.teks(axX - 5, py + 3.5, String(gy), GAYA.teksKecil, 'end');
    terpakai.push(kotakTeks(axX - 5, py + 3.5, String(gy), GAYA.teksKecil, 'end'));
  }
  isi += `<text x="${(axX - 5).toFixed(1)}" y="${(axY + 12).toFixed(1)}" font-size="${GAYA.teksKecil}" font-style="italic" text-anchor="end" fill="${GAYA.hitam}">O</text>`;
  terpakai.push(kotakTeks(axX - 5, axY + 12, 'O', GAYA.teksKecil, 'end'));

  if (jenis === 'refleksi') {
    // Cermin: garis putus-putus berlabel persamaannya. Cermin berupa sumbu
    // tidak digambar ulang — sumbunya sendiri sudah ada.
    let p = null, q = null, label = '';
    if (garis === 'y=x') { p = toPx(Math.max(xmin, ymin), Math.max(xmin, ymin)); q = toPx(Math.min(xmax, ymax), Math.min(xmax, ymax)); label = 'y = x'; }
    else if (garis === 'y=-x') { p = toPx(Math.max(xmin, -ymax), -Math.max(xmin, -ymax)); q = toPx(Math.min(xmax, -ymin), -Math.min(xmax, -ymin)); label = 'y = −x'; }
    else if (/^x=-?[\d.]+$/.test(garis)) { const k = parseFloat(garis.slice(2)); p = toPx(k, ymin); q = toPx(k, ymax); label = `x = ${k}`; }
    else if (/^y=-?[\d.]+$/.test(garis)) { const k = parseFloat(garis.slice(2)); p = toPx(xmin, k); q = toPx(xmax, k); label = `y = ${k}`; }
    if (p && q) {
      isi += `<line x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${q[0].toFixed(1)}" y2="${q[1].toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garisBantu + 0.2}" stroke-dasharray="${GAYA.putus}"/>`;
      const pos = letakTeksLuar(q[0], q[1], q[0] > p[0] ? 0.7 : 0, q[1] < p[1] ? -0.7 : -1, 8, GAYA.teksKecil);
      isi += teksGeoSVG(pos, label, GAYA.teksKecil, false, true);
      b.teks(pos.x, pos.y, label, GAYA.teksKecil, pos.anchor);
    }
  }
  if (jenis === 'rotasi' || jenis === 'dilatasi') {
    const [cx, cy] = toPx(pusat[0], pusat[1]);
    if (jenis === 'dilatasi') {
      // Garis bantu dari pusat lewat tiap titik ke bayangannya — cara
      // enlargement diperiksa di ujian (pusat, titik, bayangan segaris).
      points.forEach((p, i) => {
        const [x2, y2] = toPx(image[i].x, image[i].y), [x1, y1] = toPx(p.x, p.y);
        const jauh = Math.hypot(x2 - cx, y2 - cy) > Math.hypot(x1 - cx, y1 - cy) ? [x2, y2] : [x1, y1];
        isi += `<line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${jauh[0].toFixed(1)}" y2="${jauh[1].toFixed(1)}" stroke="${GAYA.abu}" stroke-width="${GAYA.garisBantu}" stroke-dasharray="${GAYA.putusHalus}"/>`;
      });
    }
    isi += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="2.4" fill="${GAYA.hitam}"/>`;
    if (pusat[0] !== 0 || pusat[1] !== 0) {
      const label = `(${pusat[0]}, ${pusat[1]})`;
      const pos = letakTeksLuar(cx, cy, 0.7, 0.7, 6, GAYA.teksKecil);
      isi += teksGeoSVG(pos, label, GAYA.teksKecil, false, true);
      b.teks(pos.x, pos.y, label, GAYA.teksKecil, pos.anchor);
    }
  }

  // Bangun asal padat, bayangan putus-putus; huruf titik di sisi luar bangun
  // (menjauhi pusat bangun) dengan halo putih supaya terbaca di atas grid.
  const gambarPoligon = (pts, putus) => {
    const d = pts.map((p, i) => { const [px, py] = toPx(p.x, p.y); return (i === 0 ? 'M' : 'L') + px.toFixed(1) + ' ' + py.toFixed(1); }).join(' ') + ' Z';
    isi += `<path d="${d}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}" stroke-linejoin="round"${putus ? ` stroke-dasharray="${GAYA.putus}"` : ''}/>`;
    const c = pts.reduce((s, p) => [s[0] + p.x / pts.length, s[1] + p.y / pts.length], [0, 0]);
    pts.forEach((p) => {
      const [px, py] = toPx(p.x, p.y);
      const dx = p.x - c[0], dy = -(p.y - c[1]), len = Math.hypot(dx, dy) || 1;
      // Arah keluar bangun dulu; kalau hurufnya menimpa angka sumbu atau huruf
      // titik lain, putar arahnya (±45°, ±90°, ...) sampai ada tempat kosong.
      let pos = null, kotak = null;
      for (const putar of [0, 45, -45, 90, -90, 135, -135, 180]) {
        const r = (putar * Math.PI) / 180, ux = dx / len, uy = dy / len;
        const cand = letakTeksLuar(px, py, ux * Math.cos(r) - uy * Math.sin(r), ux * Math.sin(r) + uy * Math.cos(r), 6, 11.5);
        const kt = kotakTeks(cand.x, cand.y, p.name, 11.5, cand.anchor);
        if (!pos) { pos = cand; kotak = kt; }
        if (!terpakai.some((o) => kt.x1 < o.x2 && kt.x2 > o.x1 && kt.y1 < o.y2 && kt.y2 > o.y1)) { pos = cand; kotak = kt; break; }
      }
      terpakai.push(kotak);
      isi += teksGeoSVG(pos, p.name, 11.5, true, true);
      b.teks(pos.x, pos.y, p.name, 11.5, pos.anchor);
    });
  };
  gambarPoligon(points, false);
  gambarPoligon(image, true);

  return bungkusGambarSVG(isi, b, false);
}

// ---------------------------------------------------------------------
// 10. Diagram Pohon Peluang (probability tree)
// ---------------------------------------------------------------------

// "Merah:2/5,Biru:3/5" -> [{label:'Merah', fracTxt:'2/5', p:0.4}, ...]
function parseProbBranches(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).map((tok) => {
    const bits = tok.split(':');
    const label = (bits[0] || '').trim();
    const fracTxt = (bits[1] || '').trim();
    let p = NaN;
    if (fracTxt.includes('/')) {
      const [n, d] = fracTxt.split('/').map(Number);
      p = d ? n / d : NaN;
    } else {
      p = parseFloat(fracTxt);
    }
    return { label, fracTxt, p: isFinite(p) ? p : 0 };
  });
}

function renderProbTreeSVG(cfg) {
  const L1raw = parseProbBranches(cfg.level1);
  const L2raw = parseProbBranches(cfg.level2);
  const L3raw = cfg.level3 ? parseProbBranches(cfg.level3) : null;
  const L1 = L1raw.length ? L1raw : [{ label: 'A', fracTxt: '1/2', p: 0.5 }, { label: 'B', fracTxt: '1/2', p: 0.5 }];
  const L2 = L2raw.length ? L2raw : L1;
  const levels = L3raw ? [L1, L2, L3raw] : [L1, L2];

  // Tata letak naskah ujian: nama kejadian ditulis di UJUNG cabang, dan
  // cabang tahap berikutnya baru mulai di sebelah kanan nama itu — jadi
  // nama simpul tidak pernah tertimpa pecahan cabang berikutnya.
  const branchLen = 96;
  const labelW = levels.map((lv) => Math.max.apply(null, lv.map((b) => lebarTeksKira(b.label, GAYA.teks)).concat([12])) + 14);
  const rootX = 12;
  const xNode = [];
  let x = rootX;
  levels.forEach((lv, k) => { x += branchLen; xNode.push(x); x += labelW[k]; });
  const rowH = 24;
  const leavesPerL1 = L2.length * (L3raw ? L3raw.length : 1);
  const totalLeaves = L1.length * leavesPerL1;
  const height = totalLeaves * rowH + 20;
  const width = xNode[xNode.length - 1] + labelW[levels.length - 1] + 52;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width.toFixed(0)} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  const branch = (x1, y1, x2, y2, frac) => {
    let s = `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    // Pecahan di tengah cabang, digeser tegak lurus ke sisi luar (atas untuk
    // cabang yang naik, bawah untuk yang turun) supaya tidak menempel garis.
    const naik = y2 <= y1;
    s += teksHaloSVG((x1 + x2) / 2, (y1 + y2) / 2 + (naik ? -5 : 12), frac, { size: GAYA.teks });
    return s;
  };
  const nodeLabel = (xn, y, teks) => `<text x="${(xn + 5).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="${GAYA.teks}" fill="${GAYA.hitam}">${escText(teks)}</text>`;

  const rootY = height / 2;
  svg += `<circle cx="${rootX}" cy="${rootY.toFixed(1)}" r="2.2" fill="${GAYA.hitam}"/>`;
  let cursor = 10;
  L1.forEach((b1) => {
    const y1 = cursor + (leavesPerL1 * rowH) / 2;
    cursor += leavesPerL1 * rowH;
    svg += branch(rootX, rootY, xNode[0], y1, b1.fracTxt);
    svg += `<circle cx="${xNode[0]}" cy="${y1.toFixed(1)}" r="2.2" fill="${GAYA.hitam}"/>`;
    svg += nodeLabel(xNode[0], y1, b1.label);
    const start2 = xNode[0] + labelW[0];

    let subCursor = y1 - (leavesPerL1 * rowH) / 2;
    L2.forEach((b2) => {
      const rows2 = L3raw ? L3raw.length : 1;
      const y2 = subCursor + (rows2 * rowH) / 2;
      subCursor += rows2 * rowH;
      svg += branch(start2, y1, xNode[1], y2, b2.fracTxt);
      svg += `<circle cx="${xNode[1]}" cy="${y2.toFixed(1)}" r="2.2" fill="${GAYA.hitam}"/>`;
      svg += nodeLabel(xNode[1], y2, b2.label);

      if (L3raw) {
        const start3 = xNode[1] + labelW[1];
        let subCursor3 = y2 - (L3raw.length * rowH) / 2;
        L3raw.forEach((b3) => {
          const y3 = subCursor3 + rowH / 2;
          subCursor3 += rowH;
          svg += branch(start3, y2, xNode[2], y3, b3.fracTxt);
          svg += `<circle cx="${xNode[2]}" cy="${y3.toFixed(1)}" r="2.2" fill="${GAYA.hitam}"/>`;
          svg += nodeLabel(xNode[2], y3, b3.label);
          const totalP = b1.p * b2.p * b3.p;
          svg += `<text x="${(xNode[2] + labelW[2]).toFixed(1)}" y="${(y3 + 4).toFixed(1)}" font-size="${GAYA.teksKecil}" fill="${GAYA.hitam}">P = ${Math.round(totalP * 1000) / 1000}</text>`;
        });
      } else {
        const totalP = b1.p * b2.p;
        svg += `<text x="${(xNode[1] + labelW[1]).toFixed(1)}" y="${(y2 + 4).toFixed(1)}" font-size="${GAYA.teksKecil}" fill="${GAYA.hitam}">P = ${Math.round(totalP * 1000) / 1000}</text>`;
      }
    });
  });

  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 11. Diagram Vektor & Bearing (arah mata angin)
// ---------------------------------------------------------------------

// "OA:4,2|OB:-2,3" -> [{name:'OA', dx:4, dy:2}, ...]
function parseVectorList(raw) {
  return String(raw || '').split('|').map((s) => s.trim()).filter(Boolean).map((tok) => {
    const [name, comp] = tok.split(':');
    const [dx, dy] = String(comp || '0,0').split(',').map(Number);
    return { name: (name || 'v').trim(), dx: dx || 0, dy: dy || 0 };
  });
}

function renderVectorSVG(cfg) {
  const vecs = parseVectorList(cfg.v);
  const list = vecs.length ? vecs : [{ name: 'a', dx: 4, dy: 2 }, { name: 'b', dx: -2, dy: 3 }];
  const showResultant = cfg.resultan !== 'tidak';

  const points = [{ x: 0, y: 0 }];
  let cx = 0, cy = 0;
  const segs = [];
  list.forEach((v) => {
    segs.push({ x1: cx, y1: cy, x2: cx + v.dx, y2: cy + v.dy, name: v.name });
    cx += v.dx; cy += v.dy;
    points.push({ x: cx, y: cy });
  });
  if (showResultant) segs.push({ x1: 0, y1: 0, x2: cx, y2: cy, name: 'R', resultant: true });

  // Skala SAMA di kedua sumbu supaya sudut yang tergambar benar (busur
  // sudut diberi nilai derajat), kanvas dipotong pas di sekeliling vektor.
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const xmin = Math.min(0, ...xs) - 1, xmax = Math.max(0, ...xs) + 1;
  const ymin = Math.min(0, ...ys) - 1, ymax = Math.max(0, ...ys) + 1;
  const skala = Math.min(300 / (xmax - xmin), 240 / (ymax - ymin), 60);
  const pad = 22;
  const width = (xmax - xmin) * skala + 2 * pad, height = (ymax - ymin) * skala + 2 * pad;
  const toPx = (x, y) => [pad + (x - xmin) * skala, height - pad - (y - ymin) * skala];

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${(width - 1).toFixed(1)}" height="${(height - 1).toFixed(1)}" fill="#ffffff" stroke="#d8dce1"/>`;
  // grid halus abu-abu muda (komponen dibaca dari kotak), sumbu abu-abu tipis
  const step = niceStep(Math.max(xmax - xmin, ymax - ymin));
  for (let gx = Math.ceil(xmin / step) * step; gx <= xmax; gx += step) { const [px] = toPx(gx, 0); svg += `<line x1="${px.toFixed(1)}" y1="${pad}" x2="${px.toFixed(1)}" y2="${(height - pad).toFixed(1)}" stroke="${GAYA.abuMuda}" stroke-width="0.6"/>`; }
  for (let gy = Math.ceil(ymin / step) * step; gy <= ymax; gy += step) { const [, py] = toPx(0, gy); svg += `<line x1="${pad}" y1="${py.toFixed(1)}" x2="${(width - pad).toFixed(1)}" y2="${py.toFixed(1)}" stroke="${GAYA.abuMuda}" stroke-width="0.6"/>`; }
  const [ox, oy] = toPx(0, 0);
  svg += `<line x1="${pad}" y1="${oy.toFixed(1)}" x2="${(width - pad).toFixed(1)}" y2="${oy.toFixed(1)}" stroke="${GAYA.abu}" stroke-width="${GAYA.garisBantu}"/>`;
  svg += `<line x1="${ox.toFixed(1)}" y1="${pad}" x2="${ox.toFixed(1)}" y2="${(height - pad).toFixed(1)}" stroke="${GAYA.abu}" stroke-width="${GAYA.garisBantu}"/>`;

  segs.forEach((s) => {
    const [px1, py1] = toPx(s.x1, s.y1), [px2, py2] = toPx(s.x2, s.y2);
    // Sudut terhadap arah mendatar (+x) di pangkal tiap vektor komponen:
    // busur kecil + nilai derajat, dengan garis acuan mendatar putus-putus
    // pendek. Resultan tidak diberi sudut — itu yang dihitung siswa.
    if (!s.resultant) {
      const theta = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const deg = Math.round(Math.abs(theta) * 1800 / Math.PI) / 10;
      if (deg > 2 && deg < 178) {
        const r = 16;
        const P = (phi, rr) => [px1 + rr * Math.cos(phi), py1 - rr * Math.sin(phi)];
        const [ax, ay] = P(0, r), [bx, by] = P(theta, r);
        svg += `<line x1="${px1.toFixed(1)}" y1="${py1.toFixed(1)}" x2="${(px1 + r + 8).toFixed(1)}" y2="${py1.toFixed(1)}" stroke="${GAYA.abu}" stroke-width="${GAYA.garisBantu}" stroke-dasharray="${GAYA.putusHalus}"/>`;
        svg += `<path d="M${ax.toFixed(1)},${ay.toFixed(1)} A${r},${r} 0 0 ${theta > 0 ? 0 : 1} ${bx.toFixed(1)},${by.toFixed(1)}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garisBantu}"/>`;
        const [lx, ly] = P(theta / 2, r + 13);
        svg += `<text x="${lx.toFixed(1)}" y="${(ly + 3.5).toFixed(1)}" font-size="${GAYA.teksKecil}" text-anchor="middle" fill="${GAYA.hitam}">${deg % 1 === 0 ? deg : deg.toFixed(1)}°</text>`;
      }
    }
    svg += arrowSVG(px1, py1, px2, py2, { dash: s.resultant ? GAYA.putus : null, strokeWidth: GAYA.garis, headLen: 9 });
    // label tebal di tengah vektor, didorong ke sisi kiri arah vektor
    const len = Math.hypot(px2 - px1, py2 - py1) || 1;
    const nx = (py2 - py1) / len, ny = -(px2 - px1) / len;
    const mx = (px1 + px2) / 2 + nx * 9, my = (py1 + py2) / 2 + ny * 9;
    svg += `<text x="${mx.toFixed(1)}" y="${(my + 4).toFixed(1)}" font-size="${GAYA.teks}" font-weight="700" text-anchor="middle" fill="${GAYA.hitam}">${escText(s.name)}</text>`;
  });

  svg += '</svg>';
  return svg;
}

function renderBearingSVG(cfg) {
  const legs = String(cfg.jalur || '').split('|').map((s) => s.trim()).filter(Boolean).map((tok) => {
    const bits = tok.split(':');
    return { label: (bits[0] || '').trim(), sudut: numOrDefault(bits[1], 0), jarak: numOrDefault(bits[2], 5) };
  });
  const list = legs.length ? legs : [{ label: 'B', sudut: 65, jarak: 8 }];
  const satuan = String(cfg.satuan || 'km').trim();

  let x = 0, y = 0;
  const pts = [{ x, y, label: cfg.titikAwal || 'A' }];
  list.forEach((leg) => {
    const rad = (leg.sudut * Math.PI) / 180;
    x += Math.sin(rad) * leg.jarak;
    y += Math.cos(rad) * leg.jarak;
    pts.push({ x, y, label: leg.label });
  });

  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const spanX = Math.max(Math.max(...xs) - Math.min(...xs), 1e-6), spanY = Math.max(Math.max(...ys) - Math.min(...ys), 1e-6);
  const scale = Math.min(220 / spanX, 220 / spanY, 60);
  const toPx = (px, py) => [(px - Math.min(...xs)) * scale, (Math.max(...ys) - py) * scale];
  const P = pts.map((p) => toPx(p.x, p.y));

  const b = kotakBatas();
  let isi = '';
  const utaraLen = 46, rBusur = 20;
  // Tiap titik pangkal kaki perjalanan: garis utara berpanah berlabel N,
  // busur bearing searah jarum jam dari utara dengan nilai tiga digit —
  // persis cara naskah Cambridge menggambar bearing.
  list.forEach((leg, i) => {
    const [x1, y1] = P[i], [x2, y2] = P[i + 1];
    isi += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    b.titik(x1, y1); b.titik(x2, y2);
    isi += arrowSVG(x1, y1, x1, y1 - utaraLen, { headLen: 7, strokeWidth: 1.1 });
    isi += `<text x="${x1.toFixed(1)}" y="${(y1 - utaraLen - 5).toFixed(1)}" font-size="${GAYA.teks}" text-anchor="middle" fill="${GAYA.hitam}">N</text>`;
    b.teks(x1, y1 - utaraLen - 5, 'N', GAYA.teks, 'middle');

    const rad = (leg.sudut * Math.PI) / 180;
    const large = leg.sudut > 180 ? 1 : 0;
    isi += `<path d="M${x1.toFixed(1)} ${(y1 - rBusur).toFixed(1)} A${rBusur} ${rBusur} 0 ${large} 1 ${(x1 + rBusur * Math.sin(rad)).toFixed(1)} ${(y1 - rBusur * Math.cos(rad)).toFixed(1)}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garisBantu + 0.2}"/>`;
    const tengah = rad / 2;
    const teksSudut = String(Math.round(leg.sudut)).padStart(3, '0') + '°';
    const pos = letakTeksLuar(x1, y1, Math.sin(tengah), -Math.cos(tengah), rBusur + 6, GAYA.teksKecil);
    isi += teksGeoSVG(pos, teksSudut, GAYA.teksKecil, false, true);
    b.teks(pos.x, pos.y, teksSudut, GAYA.teksKecil, pos.anchor);

    // Jarak di sisi kaki yang berlawanan dengan utara (menjauhi busur & N).
    const ux = (x2 - x1) / (Math.hypot(x2 - x1, y2 - y1) || 1), uy = (y2 - y1) / (Math.hypot(x2 - x1, y2 - y1) || 1);
    let nx = -uy, ny = ux;
    if (ny < 0) { nx = -nx; ny = -ny; }
    if (Math.abs(ny) < 1e-6) { nx = 0; ny = 1; }
    const jarak = `${leg.jarak} ${satuan}`;
    const posJ = letakTeksLuar((x1 + x2) / 2, (y1 + y2) / 2, nx, ny, 7, GAYA.teks);
    isi += teksGeoSVG(posJ, jarak, GAYA.teks, false, true);
    b.teks(posJ.x, posJ.y, jarak, GAYA.teks, posJ.anchor);
  });

  pts.forEach((p, i) => {
    const [px, py] = P[i];
    isi += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.2" fill="${GAYA.hitam}"/>`;
    // Huruf titik menjauhi semua garis yang bertemu di situ (kaki sebelum,
    // kaki sesudah, garis utara): arah = kebalikan jumlah vektor satuannya.
    let sx = 0, sy = 0;
    const tambah = (qx, qy) => { const d = Math.hypot(qx - px, qy - py) || 1; sx += (qx - px) / d; sy += (qy - py) / d; };
    if (i > 0) tambah(P[i - 1][0], P[i - 1][1]);
    if (i < list.length) { tambah(P[i + 1][0], P[i + 1][1]); tambah(px, py - 1); }
    let dir = [0.7, 0.7];
    if (Math.hypot(sx, sy) > 1e-3) dir = [-sx / Math.hypot(sx, sy), -sy / Math.hypot(sx, sy)];
    const pos = letakTeksLuar(px, py, dir[0], dir[1], 8, 12.5);
    isi += teksGeoSVG(pos, p.label, 12.5, true, true);
    b.teks(pos.x, pos.y, p.label, 12.5, pos.anchor);
  });

  return bungkusGambarSVG(isi, b, true);
}

// ---------------------------------------------------------------------
// 12. Ogive (kurva frekuensi kumulatif) & Boxplot
// ---------------------------------------------------------------------

function computeOgivePoints(cfg) {
  if (cfg.data) {
    const nums = String(cfg.data).split(',').map((s) => parseFloat(s.trim())).filter(isFinite).sort((a, b) => a - b);
    const pts = [{ x: nums[0], y: 0 }];
    nums.forEach((v, i) => pts.push({ x: v, y: i + 1 }));
    return { pts, n: nums.length };
  }
  const batas = String(cfg.batas || '').split(',').map(Number);
  const kumulatif = String(cfg.kumulatif || '').split(',').map(Number);
  const firstStep = (batas[1] - batas[0]) || 10;
  const pts = [{ x: (batas[0] !== undefined ? batas[0] - firstStep : 0), y: 0 }];
  batas.forEach((b, i) => pts.push({ x: b, y: kumulatif[i] || 0 }));
  return { pts, n: kumulatif[kumulatif.length - 1] || 0 };
}

function renderOgiveSVG(cfg) {
  const { pts, n } = computeOgivePoints(cfg);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
  const ymax = Math.max.apply(null, ys.concat([1]));
  const xStep = niceStep((xmax - xmin) || 1), yStep = niceStep(ymax);
  const yTop = Math.ceil(ymax / yStep) * yStep;
  const xTicks = [], yTicks = [];
  for (let gx = Math.ceil(xmin / xStep) * xStep; gx <= xmax + 1e-9; gx += xStep) xTicks.push(Math.round(gx * 1e6) / 1e6);
  for (let gy = 0; gy <= yTop + 1e-9; gy += yStep) yTicks.push(Math.round(gy * 1e6) / 1e6);
  const yTickW = Math.max.apply(null, yTicks.map((v) => lebarTeksKira(formatTick(v), GAYA.teksKecil)).concat([0]));

  const plotW = 300, plotH = 210;
  const padL = yTickW + 16, padR = 26, padT = 30, padB = 44;
  const width = padL + plotW + padR, height = padT + plotH + padB;
  const xAxisY = padT + plotH, yAxisX = padL;
  const sx = plotW / ((xmax - xmin) || 1), sy = plotH / (yTop || 1);
  const toPx = (x, y) => [padL + (x - xmin) * sx, xAxisY - y * sy];

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width.toFixed(0)} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  xTicks.forEach((gx) => { const [px] = toPx(gx, 0); svg += `<line x1="${px.toFixed(1)}" y1="${padT}" x2="${px.toFixed(1)}" y2="${xAxisY}" stroke="${GAYA.abuMuda}" stroke-width="0.6"/>`; });
  yTicks.forEach((gy) => { const [, py] = toPx(xmin, gy); svg += `<line x1="${padL}" y1="${py.toFixed(1)}" x2="${padL + plotW}" y2="${py.toFixed(1)}" stroke="${GAYA.abuMuda}" stroke-width="0.6"/>`; });

  // Kuartil: garis bantu putus-putus abu-abu dari n/4, n/2, 3n/4 di sumbu y
  // ke kurva lalu turun ke sumbu x — cara membaca kuartil dari ogive.
  function interpX(targetY) {
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].y >= targetY) {
        const p0 = pts[i - 1], p1 = pts[i];
        if (p1.y === p0.y) return p1.x;
        const t = (targetY - p0.y) / (p1.y - p0.y);
        return p0.x + t * (p1.x - p0.x);
      }
    }
    return pts[pts.length - 1].x;
  }
  const kuartil = ['Q1', 'Q2', 'Q3'].map((label, i) => {
    const targetY = (n * (i + 1)) / 4;
    return { label, y: targetY, x: interpX(targetY) };
  });
  kuartil.forEach((q) => {
    const [px, py] = toPx(q.x, q.y);
    svg += `<line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${px.toFixed(1)}" y2="${xAxisY}" stroke="${GAYA.abu}" stroke-width="${GAYA.garisBantu}" stroke-dasharray="${GAYA.putus}"/>`;
    svg += `<line x1="${padL}" y1="${py.toFixed(1)}" x2="${px.toFixed(1)}" y2="${py.toFixed(1)}" stroke="${GAYA.abu}" stroke-width="${GAYA.garisBantu}" stroke-dasharray="${GAYA.putus}"/>`;
  });

  let d = '';
  pts.forEach((p, i) => { const [px, py] = toPx(p.x, p.y); d += (i === 0 ? 'M' : 'L') + px.toFixed(1) + ' ' + py.toFixed(1) + ' '; });
  svg += `<path d="${d}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  pts.forEach((p) => { const [px, py] = toPx(p.x, p.y); svg += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.2" fill="${GAYA.hitam}"/>`; });

  svg += sumbuALevelSVG({ xAxisY, yAxisX, xFrom: padL, xTo: padL + plotW + 10, yFrom: xAxisY, yTo: padT - 10, labelY: 'frekuensi kumulatif' });
  xTicks.forEach((gx) => { svg += tickXSVG(toPx(gx, 0)[0], xAxisY, formatTick(gx)); });
  yTicks.forEach((gy) => { svg += tickYSVG(yAxisX, toPx(xmin, gy)[1], formatTick(gy)); });
  // Nama kuartil di kaki garis bantunya; nilainya dalam satu baris di bawah
  // grafik supaya tidak saling tumpang tindih saat kuartil berdekatan.
  kuartil.forEach((q) => { svg += teksHaloSVG(toPx(q.x, 0)[0] + 3, xAxisY - 4, q.label, { anchor: 'start', italic: true }); });
  // (Tiga <text> terpisah: spasi beruntun di dalam satu <text> SVG dilebur
  // jadi satu, sehingga jaraknya tidak bisa diatur lewat spasi.)
  let rx = padL;
  kuartil.forEach((q) => {
    const t = `${q.label} ≈ ${formatTick(Math.round(q.x * 100) / 100)}`;
    svg += `<text x="${rx.toFixed(1)}" y="${(height - 6).toFixed(1)}" font-size="${GAYA.teksKecil}" fill="${GAYA.hitam}">${escText(t)}</text>`;
    rx += lebarTeksKira(t, GAYA.teksKecil) + 22;
  });
  svg += '</svg>';
  return svg;
}

function computeFiveNumberSummary(cfg) {
  if (cfg.data) {
    const nums = String(cfg.data).split(',').map((s) => parseFloat(s.trim())).filter(isFinite).sort((a, b) => a - b);
    const q = (p) => { const idx = (nums.length - 1) * p; const lo = Math.floor(idx), hi = Math.ceil(idx); return nums[lo] + (nums[hi] - nums[lo]) * (idx - lo); };
    return { min: nums[0], q1: q(0.25), median: q(0.5), q3: q(0.75), max: nums[nums.length - 1] };
  }
  return {
    min: numOrDefault(cfg.min, 5), q1: numOrDefault(cfg.q1, 12), median: numOrDefault(cfg.median, 18),
    q3: numOrDefault(cfg.q3, 25), max: numOrDefault(cfg.max, 35),
  };
}

function renderBoxplotSVG(cfg) {
  const s = computeFiveNumberSummary(cfg);
  const plotW = 300, padL = 30, padR = 30;
  const width = plotW + padL + padR, height = 128;
  const vmin = numOrDefault(cfg.xmin, s.min - (s.max - s.min) * 0.1);
  const vmax = numOrDefault(cfg.xmax, s.max + (s.max - s.min) * 0.1);
  const sx = plotW / ((vmax - vmin) || 1);
  const toX = (v) => padL + (v - vmin) * sx;
  const midY = 60, boxH = 34;
  const axisY = height - 30;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  // Skala bernomor di bawah kotak, seperti box-and-whisker di naskah ujian:
  // siswa membaca kuartil dari skalanya, bukan dari angka yang dicetak.
  const step = niceStep(vmax - vmin);
  svg += arrowSVG(padL - 6, axisY, padL + plotW + 10, axisY, { headLen: 7, strokeWidth: 1.2 });
  for (let v = Math.ceil(vmin / step) * step; v <= vmax + 1e-9; v += step) {
    const rv = Math.round(v * 1e6) / 1e6;
    svg += tickXSVG(toX(rv), axisY, formatTick(rv));
  }

  svg += `<line x1="${toX(s.min).toFixed(1)}" y1="${midY.toFixed(1)}" x2="${toX(s.q1).toFixed(1)}" y2="${midY.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  svg += `<line x1="${toX(s.q3).toFixed(1)}" y1="${midY.toFixed(1)}" x2="${toX(s.max).toFixed(1)}" y2="${midY.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  [s.min, s.max].forEach((v) => { svg += `<line x1="${toX(v).toFixed(1)}" y1="${(midY - boxH / 4).toFixed(1)}" x2="${toX(v).toFixed(1)}" y2="${(midY + boxH / 4).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`; });
  svg += `<rect x="${toX(s.q1).toFixed(1)}" y="${(midY - boxH / 2).toFixed(1)}" width="${(toX(s.q3) - toX(s.q1)).toFixed(1)}" height="${boxH}" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
  svg += `<line x1="${toX(s.median).toFixed(1)}" y1="${(midY - boxH / 2).toFixed(1)}" x2="${toX(s.median).toFixed(1)}" y2="${(midY + boxH / 2).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;

  // Nama lima serangkai di atas kotak; kalau dua nama bertetangga terlalu
  // rapat (data yang sempit), nama yang belakangan dinaikkan satu baris.
  let prevRight = -Infinity, prevRow = 0;
  [['Min', s.min], ['Q1', s.q1], ['Median', s.median], ['Q3', s.q3], ['Max', s.max]].forEach(([label, v]) => {
    const x = toX(v), w = lebarTeksKira(label, GAYA.teksKecil);
    let row = 0;
    if (x - w / 2 < prevRight + 4) row = prevRow === 0 ? 1 : 0;
    if (row === 0) prevRight = x + w / 2;
    prevRow = row;
    svg += `<text x="${x.toFixed(1)}" y="${(midY - boxH / 2 - 7 - row * 12).toFixed(1)}" font-size="${GAYA.teksKecil}" text-anchor="middle" fill="${GAYA.hitam}">${label}</text>`;
  });

  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 13. Diagram Sinar (ray diagram — lensa cembung/cekung)
// ---------------------------------------------------------------------

// Mata panah kecil terisi, berpusat di (x,y), menghadap sudut `rad`
// (radian, kerangka SVG: y ke bawah). Dipakai DI TENGAH garis sinar dan
// garis medan untuk menunjukkan arah tanpa memutus garisnya — konvensi
// buku ujian, bukan panah di ujung garis.
function kepalaPanahSVG(x, y, rad, size) {
  size = size || 7;
  const ux = Math.cos(rad), uy = Math.sin(rad);
  const px = -uy, py = ux;
  const tx = x + ux * size * 0.5, ty = y + uy * size * 0.5;
  const bx = x - ux * size * 0.5, by = y - uy * size * 0.5;
  return `<polygon points="${tx.toFixed(1)},${ty.toFixed(1)} ${(bx + px * size * 0.45).toFixed(1)},${(by + py * size * 0.45).toFixed(1)} ${(bx - px * size * 0.45).toFixed(1)},${(by - py * size * 0.45).toFixed(1)}" fill="${GAYA.hitam}"/>`;
}

// Garis tipis hitam dengan mata panah di tengahnya (posisi 0..1 sepanjang
// garis, bawaan setengah). dash: pola putus-putus untuk perpanjangan sinar
// maya; panah=false untuk perpanjangan tanpa arah.
function garisBerarahSVG(x1, y1, x2, y2, opts) {
  opts = opts || {};
  const dash = opts.dash ? ` stroke-dasharray="${opts.dash}"` : '';
  let s = `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${opts.strokeWidth || 1}"${dash}/>`;
  if (opts.panah !== false && Math.hypot(x2 - x1, y2 - y1) > 14) {
    const t = opts.posisi == null ? 0.5 : opts.posisi;
    s += kepalaPanahSVG(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, Math.atan2(y2 - y1, x2 - x1), opts.headLen || 7);
  }
  return s;
}

function renderRaySVG(cfg) {
  const alat = String(cfg.alat || 'cembung').toLowerCase();
  const isConverging = alat === 'cembung' || alat === 'converging';
  const f = Math.max(0.5, numOrDefault(cfg.f, 3));
  const doV = Math.max(0.5, numOrDefault(cfg.objek_jarak, 6));
  const hoV = Math.max(0.2, Math.abs(numOrDefault(cfg.objek_tinggi, 2)));
  const fSigned = isConverging ? f : -f;
  // Benda tepat di F: sinar bias sejajar, bayangan di tak hingga — tidak
  // ada bayangan yang bisa digambar, sinar tetap ditelusuri.
  const adaBayangan = Math.abs(doV - fSigned) > 1e-9;
  const di = adaBayangan ? 1 / (1 / fSigned - 1 / doV) : NaN;
  const hi = isFinite(di) ? -(di / doV) * hoV : NaN;
  const nyata = isFinite(di) && di > 0;

  // Rentang mendatar dalam satuan soal: cukup untuk benda, 2F kedua sisi,
  // bayangan (nyata di kanan / maya di kiri), lalu skala dipilih agar
  // gambar ~420 px lebar. Bayangan yang membesar liar (benda dekat F)
  // dibatasi 3,5× tinggi benda saat menghitung skala supaya gambar tidak
  // menjadi kerdil; bagian yang berlebih boleh terpotong.
  const xKiri = Math.min(-doV, -2 * f, isFinite(di) && di < 0 ? di : 0);
  const xKanan = Math.max(2 * f, nyata ? di : 0) + 0.8 * f;
  const hMaks = Math.max(hoV, isFinite(hi) ? Math.min(Math.abs(hi), 3.5 * hoV) : 0);
  let skala = 400 / (xKanan - xKiri);
  skala = Math.min(skala, 110 / hMaks);
  const marKiri = 48, marKanan = 58, marAtas = 22, marBawah = 42;
  const lensX = marKiri + (-xKiri) * skala;
  const axisY = marAtas + hMaks * skala + 10;
  const width = lensX + xKanan * skala + marKanan;
  const height = axisY + hMaks * skala + marBawah;
  const X = (x) => lensX + x * skala;
  const Y = (y) => axisY - y * skala;
  const yBatas = hMaks * 1.15 + 8 / skala; // sinar dipotong di sini (satuan soal)

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${(width - 1).toFixed(1)}" height="${(height - 1).toFixed(1)}" fill="#ffffff" stroke="#d8dce1"/>`;
  // sumbu utama: garis tipis hitam sepanjang gambar
  svg += `<line x1="6" y1="${axisY.toFixed(1)}" x2="${(width - 6).toFixed(1)}" y2="${axisY.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="0.9"/>`;

  // Lensa: garis tegak tipis dengan mata panah di kedua ujung — ke luar
  // untuk cembung, ke dalam untuk cekung (simbol lensa tipis di naskah ujian).
  const lensH2 = hMaks * skala + 16;
  svg += `<line x1="${lensX.toFixed(1)}" y1="${(axisY - lensH2).toFixed(1)}" x2="${lensX.toFixed(1)}" y2="${(axisY + lensH2).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
  const kepala = (yUjung, arahKeluar) => {
    const s = 10, arah = arahKeluar ? 1 : -1;
    const tipY = yUjung, baseY = yUjung + arah * (yUjung < axisY ? s : -s);
    if (arahKeluar) return `<polygon points="${lensX.toFixed(1)},${tipY.toFixed(1)} ${(lensX - 5).toFixed(1)},${baseY.toFixed(1)} ${(lensX + 5).toFixed(1)},${baseY.toFixed(1)}" fill="${GAYA.hitam}"/>`;
    return `<polygon points="${lensX.toFixed(1)},${baseY.toFixed(1)} ${(lensX - 5).toFixed(1)},${tipY.toFixed(1)} ${(lensX + 5).toFixed(1)},${tipY.toFixed(1)}" fill="${GAYA.hitam}"/>`;
  };
  svg += kepala(axisY - lensH2, isConverging) + kepala(axisY + lensH2, isConverging);

  // F dan 2F di kedua sisi: tanda tik pendek + label di bawah sumbu.
  [[-2 * f, '2F'], [-f, 'F'], [f, 'F'], [2 * f, '2F']].forEach(([x, nama]) => {
    const px = X(x);
    svg += `<line x1="${px.toFixed(1)}" y1="${(axisY - 4).toFixed(1)}" x2="${px.toFixed(1)}" y2="${(axisY + 4).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1"/>`;
    svg += `<text x="${px.toFixed(1)}" y="${(axisY + 15).toFixed(1)}" font-size="${GAYA.teksKecil}" text-anchor="middle" fill="${GAYA.hitam}">${nama}</text>`;
  });

  // Tiga sinar istimewa, dihitung dalam satuan soal (y positif ke atas).
  // Setiap segmen: [x1,y1,x2,y2,maya]. Segmen maya (perpanjangan ke
  // belakang) digambar putus-putus tanpa panah.
  const seg = [];
  const potong = (x1, y1, x2, y2) => {
    // potong ujung sinar supaya tidak keluar dari tinggi gambar
    if (Math.abs(y2) > yBatas) {
      const t = (Math.sign(y2) * yBatas - y1) / (y2 - y1);
      return [x1, y1, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
    }
    return [x1, y1, x2, y2];
  };
  // Bayangan nyata: sinar bias berhenti di ujung bayangan (konvensi buku);
  // bayangan maya / tak ada bayangan: sinar bias diteruskan ke tepi kanan.
  const xUjung = nyata ? di : xKanan - 0.15 * f;
  const tx = -doV, ty = hoV;

  // Sinar 1: sejajar sumbu, dibiaskan lewat F (cembung) atau seolah dari F
  // sisi benda (cekung).
  seg.push([tx, ty, 0, ty, false]);
  const arah1 = isConverging ? [f, -ty] : [f, ty];
  const t1 = xUjung / arah1[0];
  seg.push(potong(0, ty, arah1[0] * t1, ty + arah1[1] * t1).concat(false));
  if (isFinite(di) && !nyata) {
    if (isConverging) seg.push([0, ty, di, hi, true]);
    else seg.push([0, ty, -f, 0, true]);
  }

  // Sinar 2: lewat pusat optik, tidak dibelokkan.
  seg.push([tx, ty, 0, 0, false]);
  const t2 = xUjung / doV;
  seg.push(potong(0, 0, doV * t2, -ty * t2).concat(false));
  if (isFinite(di) && !nyata && isConverging) seg.push([tx, ty, di, hi, true]);

  // Sinar 3: lewat F sisi benda (cembung) / menuju F sisi jauh (cekung),
  // keluar sejajar sumbu. Tinggi titik potong di lensa = tinggi bayangan.
  const yL = isConverging ? (Math.abs(f - doV) > 1e-9 ? ty * f / (f - doV) : NaN) : ty * f / (f + doV);
  if (isFinite(yL) && Math.abs(yL) <= yBatas) {
    seg.push([tx, ty, 0, yL, false]);
    seg.push([0, yL, xUjung, yL, false]);
    if (isFinite(di) && !nyata) {
      seg.push([0, yL, di, yL, true]);
      if (!isConverging) seg.push([0, yL, f, 0, true]);
    }
  }

  seg.forEach(([x1, y1, x2, y2, maya]) => {
    svg += garisBerarahSVG(X(x1), Y(y1), X(x2), Y(y2), maya ? { dash: GAYA.putus, panah: false, strokeWidth: 0.9 } : { headLen: 7 });
  });

  // Benda: panah tegak hitam padat, label di bawah pangkalnya (baris kedua,
  // di bawah baris F/2F supaya tidak bertumpuk saat benda tepat di 2F).
  svg += arrowSVG(X(tx), Y(0), X(tx), Y(ty), { headLen: 8, strokeWidth: 1.8 });
  svg += `<text x="${X(tx).toFixed(1)}" y="${(axisY + 28).toFixed(1)}" font-size="${GAYA.teksKecil}" text-anchor="middle" fill="${GAYA.hitam}">benda</text>`;

  // Bayangan: padat kalau nyata, putus-putus kalau maya. Bayangan nyata
  // terbalik (ujung di bawah sumbu) diberi label di bawah ujungnya — paling
  // tidak di baris kedua supaya tidak menabrak label F/2F di baris pertama;
  // bayangan maya tegak diberi label di bawah pangkalnya seperti benda.
  if (isFinite(di)) {
    const hiGambar = Math.sign(hi) * Math.min(Math.abs(hi), yBatas);
    svg += arrowSVG(X(di), Y(0), X(di), Y(hiGambar), { headLen: 8, strokeWidth: 1.8, dash: nyata ? null : '4 3' });
    if (nyata) {
      const ly = Math.max(Y(hiGambar) + 15, axisY + 28);
      svg += `<text x="${X(di).toFixed(1)}" y="${ly.toFixed(1)}" font-size="${GAYA.teksKecil}" text-anchor="middle" fill="${GAYA.hitam}">bayangan</text>`;
    } else {
      svg += `<text x="${X(di).toFixed(1)}" y="${(axisY + 28).toFixed(1)}" font-size="${GAYA.teksKecil}" text-anchor="middle" fill="${GAYA.hitam}">bayangan</text>`;
    }
  }

  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 14. Grafik Gerak (kinematika: jarak-waktu / kecepatan-waktu)
// ---------------------------------------------------------------------

function parsePiecewisePoints(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).map((tok) => {
    const [x, y] = tok.split(':').map(Number);
    return { x, y };
  });
}

function renderKinematicsSVG(cfg) {
  const tipe = String(cfg.tipe || 'kecepatan-waktu').toLowerCase();
  const parsed = parsePiecewisePoints(cfg.titik).filter((p) => isFinite(p.x) && isFinite(p.y));
  const list = parsed.length ? parsed : [{ x: 0, y: 0 }, { x: 2, y: 10 }, { x: 5, y: 10 }, { x: 8, y: 0 }];
  const xs = list.map((p) => p.x), ys = list.map((p) => p.y);
  const xmin = 0, xmax = Math.max(...xs, 0) || 1;
  const ymin = Math.min(0, ...ys);
  let ymax = Math.max(0, ...ys);
  if (ymax === ymin) ymax = ymin + 1;

  // Label sumbu gaya A-Level: huruf besaran / satuan berpangkat negatif.
  // Label pemakai "v (km/jam)" dibawa ke bentuk yang sama oleh labelSumbuALevel.
  const bawaan = tipe.startsWith('jarak') ? ['x', 'm', 'm/s']
    : tipe.startsWith('percepat') ? ['a', 'm/s^2', 'm/s^3']
      : ['v', 'm/s', 'm/s^2'];
  const yLabel = cfg.sumbuy ? labelSumbuALevel(cfg.sumbuy) : labelSatuan(bawaan[0], bawaan[1]);
  const xLabel = cfg.sumbux ? labelSumbuALevel(cfg.sumbux) : labelSatuan('t', 's');
  const textW = (t) => String(t).length * 6.2;

  // Bidang gambar tetap ~260×170 px; kanvas dipotong pas di sekeliling
  // sumbu + label supaya tidak ada ruang kosong.
  const plotW = 260, plotH = 170;
  const x0 = 44;                         // sumbu y
  const yTop = 30;                       // atas bidang gambar
  const sx = plotW / (xmax - xmin), sy = plotH / (ymax - ymin);
  const toPx = (x, y) => [x0 + (x - xmin) * sx, yTop + (ymax - y) * sy];
  const [, y0] = toPx(0, 0);             // sumbu x (di y = 0)
  const yBawah = toPx(0, ymin)[1];
  const xEnd = x0 + plotW + 26, yEnd = yTop - 24;
  const width = xEnd + 8 + textW(xLabel) + 6;
  const height = yBawah + 30;

  let svg = '';
  let minX = 0; // digeser ke kiri bila label gradien menjulur melewati sumbu y

  // Daerah di bawah grafik: arsiran miring abu-abu tipis (bukan isian
  // warna) supaya "luas yang diarsir" tetap terlihat di fotokopi hitam-putih.
  if (cfg.arsir !== 'tidak') {
    svg += `<defs><pattern id="arsir-gerak" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#a6a6a6" stroke-width="0.8"/></pattern></defs>`;
    let d = `M${toPx(list[0].x, 0).map((v) => v.toFixed(1)).join(',')} `;
    list.forEach((p) => { d += `L${toPx(p.x, p.y).map((v) => v.toFixed(1)).join(',')} `; });
    d += `L${toPx(list[list.length - 1].x, 0).map((v) => v.toFixed(1)).join(',')} Z`;
    svg += `<path d="${d}" fill="url(#arsir-gerak)" stroke="none"/>`;
  }

  // Sumbu berpanah dari titik asal, label di ujung panah.
  svg += arrowSVG(x0, y0, xEnd, y0, { headLen: 7, strokeWidth: 1.2 });
  svg += arrowSVG(x0, yBawah, x0, yEnd, { headLen: 7, strokeWidth: 1.2 });
  svg += `<text x="${(xEnd + 6).toFixed(1)}" y="${(y0 + 4).toFixed(1)}" font-size="${GAYA.teks}" fill="${GAYA.hitam}">${escText(xLabel)}</text>`;
  svg += `<text x="${(x0 + 8).toFixed(1)}" y="${(yEnd + 4).toFixed(1)}" font-size="${GAYA.teks}" fill="${GAYA.hitam}">${escText(yLabel)}</text>`;

  // Nilai tiap titik sudut dicetak di kedua sumbu (grafik v–t dibaca dari
  // nilainya di sumbu, bukan dari kemiringan). Label yang berjarak kurang
  // dari satu tinggi huruf dari yang sudah ada dilewati supaya tidak
  // bertumpuk. "0" cukup sekali, di pojok titik asal.
  const tik = (x, y, anchor, teks) => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${GAYA.teksKecil}" text-anchor="${anchor}" fill="${GAYA.hitam}">${teks}</text>`;
  const yDrawn = [];
  [...new Set(ys)].sort((a, b) => b - a).forEach((y) => {
    const [, py] = toPx(0, y);
    if (yDrawn.some((q) => Math.abs(q - py) < 11)) return;
    yDrawn.push(py);
    svg += `<line x1="${(x0 - 4).toFixed(1)}" y1="${py.toFixed(1)}" x2="${x0}" y2="${py.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1"/>`;
    svg += tik(x0 - 6, y === 0 ? py + 12 : py + 3.5, 'end', formatTick(y));
  });
  const xDrawn = [];
  [...new Set(xs)].sort((a, b) => a - b).forEach((x) => {
    if (x === 0) return;
    const [px] = toPx(x, 0);
    if (xDrawn.some((q) => Math.abs(q - px) < 14)) return;
    xDrawn.push(px);
    svg += `<line x1="${px.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${px.toFixed(1)}" y2="${(y0 + 4).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1"/>`;
    svg += tik(px, y0 + 15, 'middle', formatTick(x));
  });

  // Garis bantu putus-putus abu-abu tipis dari tiap titik sudut ke kedua sumbu.
  if (cfg.bantu !== 'tidak') {
    list.forEach((p) => {
      if (p.y === 0) return;
      const [px, py] = toPx(p.x, p.y);
      svg += `<line x1="${x0}" y1="${py.toFixed(1)}" x2="${px.toFixed(1)}" y2="${py.toFixed(1)}" stroke="${GAYA.abu}" stroke-width="${GAYA.garisBantu}" stroke-dasharray="3,3"/>`;
      svg += `<line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${px.toFixed(1)}" y2="${y0.toFixed(1)}" stroke="${GAYA.abu}" stroke-width="${GAYA.garisBantu}" stroke-dasharray="3,3"/>`;
    });
  }

  let d = '';
  list.forEach((p, i) => { const [px, py] = toPx(p.x, p.y); d += (i === 0 ? 'M' : 'L') + px.toFixed(1) + ' ' + py.toFixed(1) + ' '; });
  svg += `<path d="${d}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}" stroke-linejoin="round"/>`;
  list.forEach((p) => {
    const [px, py] = toPx(p.x, p.y);
    svg += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.2" fill="${GAYA.hitam}"/>`;
  });

  // Gradien TIDAK dicetak otomatis: di naskah ujian gradien (percepatan /
  // kecepatan) adalah yang harus dihitung siswa, jadi "m=5" di gambar
  // membocorkan jawaban. Hanya bila diminta tegas (gradien=ya) ditulis
  // gaya buku, "gradien = 5 m s⁻²", dengan satuan turunan dari sumbu.
  if (cfg.gradien === 'ya') {
    const satuanGrad = cfg.sumbuy || cfg.sumbux ? '' : ' ' + satuanALevel(bawaan[2]);
    for (let i = 1; i < list.length; i++) {
      const p0 = list[i - 1], p1 = list[i];
      if (p1.x === p0.x) continue;
      const grad = Math.round(((p1.y - p0.y) / (p1.x - p0.x)) * 100) / 100;
      const [ax, ay] = toPx(p0.x, p0.y), [bx, by] = toPx(p1.x, p1.y);
      const px = (ax + bx) / 2, py = (ay + by) / 2;
      // label didorong ke sisi atas segmen sepanjang normalnya
      const len = Math.hypot(bx - ax, by - ay) || 1;
      let nx = -(by - ay) / len, ny = (bx - ax) / len;
      if (ny > 0) { nx = -nx; ny = -ny; }
      const anchor = nx > 0.3 ? 'start' : nx < -0.3 ? 'end' : 'middle';
      const teks = `gradien = ${grad}${grad === 0 ? '' : satuanGrad}`;
      const lx = px + nx * 9;
      if (anchor === 'end') minX = Math.min(minX, lx - textW(teks) - 4);
      svg += `<text x="${lx.toFixed(1)}" y="${(py + ny * 9 + 3.5).toFixed(1)}" font-size="${GAYA.teksKecil}" text-anchor="${anchor}" fill="${GAYA.hitam}">${teks}</text>`;
    }
  }

  const kepala = `<svg class="ws-diagram-svg" viewBox="${minX.toFixed(1)} 0 ${(width - minX).toFixed(1)} ${height.toFixed(1)}" xmlns="http://www.w3.org/2000/svg">`
    + `<rect x="${(minX + 0.5).toFixed(1)}" y="0.5" width="${(width - minX - 1).toFixed(1)}" height="${(height - 1).toFixed(1)}" fill="#ffffff" stroke="#d8dce1"/>`;
  return kepala + svg + '</svg>';
}

// ---------------------------------------------------------------------
// 15. Diagram Gelombang (transversal / longitudinal)
// ---------------------------------------------------------------------

// Garis dimensi berpanah dua arah, tipis hitam (tanda amplitudo A dan
// panjang gelombang λ pada gambar gelombang).
function garisDimensiDuaPanahSVG(x1, y1, x2, y2) {
  const rad = Math.atan2(y2 - y1, x2 - x1);
  let s = `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garisBantu}"/>`;
  s += kepalaPanahSVG(x2 - Math.cos(rad) * 3.5, y2 - Math.sin(rad) * 3.5, rad, 7);
  s += kepalaPanahSVG(x1 + Math.cos(rad) * 3.5, y1 + Math.sin(rad) * 3.5, rad + Math.PI, 7);
  return s;
}


function renderWaveSVG(cfg) {
  const jenis = String(cfg.jenis || 'transversal').toLowerCase();
  const amp = Math.min(90, Math.max(8, Math.abs(numOrDefault(cfg.amplitudo, 20))));
  const wavelength = Math.max(24, numOrDefault(cfg.panjanggelombang, 60));
  const jumlah = Math.max(1, Math.round(numOrDefault(cfg.jumlah, 2)));
  const panjang = wavelength * jumlah;
  const x0 = 46;
  const teksKecil = GAYA.teksKecil;
  const putus = (x1, y1, x2, y2) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${GAYA.abu}" stroke-width="${GAYA.garisBantu}" stroke-dasharray="${GAYA.putusHalus}"/>`;
  let svg = '';
  let width, height;

  if (jenis === 'transversal') {
    // Sumbu simpangan (tegak, berpanah) dan jarak (mendatar, berpanah)
    // dari titik asal di awal gelombang; kurva sinus hitam tebal.
    const midY = 26 + amp + 12;
    const yEnd = midY - amp - 24, xEnd = x0 + panjang + 26;
    svg += arrowSVG(x0, midY, xEnd, midY, { headLen: 7, strokeWidth: 1.2 });
    svg += arrowSVG(x0, midY, x0, yEnd, { headLen: 7, strokeWidth: 1.2 });
    svg += `<text x="${(xEnd + 6).toFixed(1)}" y="${(midY + 4).toFixed(1)}" font-size="${GAYA.teks}" fill="${GAYA.hitam}">jarak</text>`;
    svg += `<text x="${(x0 + 8).toFixed(1)}" y="${(yEnd + 4).toFixed(1)}" font-size="${GAYA.teks}" fill="${GAYA.hitam}">simpangan</text>`;

    let d = '';
    const steps = 60 * jumlah;
    for (let s = 0; s <= steps; s++) {
      const x = x0 + (panjang * s) / steps;
      const y = midY - amp * Math.sin((2 * Math.PI * (x - x0)) / wavelength);
      d += (s === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    }
    svg += `<path d="${d}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}" stroke-linejoin="round"/>`;

    // Amplitudo: garis putus-putus dari puncak pertama ke sumbu, garis
    // dimensi dua panah di sampingnya berlabel A.
    const puncak1 = x0 + wavelength * 0.25;
    const puncak2 = puncak1 + wavelength;
    const yDim = midY + amp + 24;
    svg += putus(puncak1, midY - amp, puncak1, jumlah >= 2 ? yDim : midY);
    const xA = puncak1 + 11;
    svg += garisDimensiDuaPanahSVG(xA, midY, xA, midY - amp);
    svg += `<text x="${(xA + 5).toFixed(1)}" y="${(midY - amp / 2 + 4).toFixed(1)}" font-size="${GAYA.teks}" font-style="italic" fill="${GAYA.hitam}">A</text>`;

    // Panjang gelombang: puncak ke puncak bila ada dua gelombang, kalau
    // tidak dari titik asal ke satu gelombang penuh; garis dimensi di bawah.
    let l1 = x0, l2 = x0 + wavelength;
    if (jumlah >= 2) {
      l1 = puncak1; l2 = puncak2;
      svg += putus(puncak2, midY - amp, puncak2, yDim);
    } else {
      svg += putus(l2, midY, l2, yDim);
      svg += putus(l1, midY, l1, yDim);
    }
    svg += garisDimensiDuaPanahSVG(l1, yDim, l2, yDim);
    svg += `<text x="${((l1 + l2) / 2).toFixed(1)}" y="${(yDim + 15).toFixed(1)}" font-size="${GAYA.teks}" font-style="italic" text-anchor="middle" fill="${GAYA.hitam}">λ</text>`;
    width = xEnd + 6 + 34;
    height = yDim + 22;
  } else {
    // Longitudinal: garis tegak berjarak sama diberi geseran sinus, sehingga
    // otomatis mengumpul jadi rapatan (di λ/2, 3λ/2, ...) dan merenggang
    // jadi renggangan (di 0, λ, 2λ, ...).
    const tinggi = 30, midY = 22 + tinggi;
    const n = Math.max(12, Math.round(panjang / 4));
    const spacing = panjang / n;
    for (let i = 0; i <= n; i++) {
      const baseX = x0 + i * spacing;
      const x = baseX + Math.min(amp, 20) * 0.45 * Math.sin((2 * Math.PI * (baseX - x0)) / wavelength);
      svg += `<line x1="${x.toFixed(1)}" y1="${(midY - tinggi).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(midY + tinggi).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
    }
    // arah rambat
    svg += arrowSVG(x0, midY - tinggi - 12, x0 + 40, midY - tinggi - 12, { headLen: 6, strokeWidth: 1 });
    svg += `<text x="${(x0 + 46).toFixed(1)}" y="${(midY - tinggi - 8).toFixed(1)}" font-size="${teksKecil}" fill="${GAYA.hitam}">arah rambat</text>`;

    const rapat1 = x0 + wavelength / 2, rapat2 = rapat1 + wavelength;
    const renggang = jumlah >= 2 ? x0 + wavelength : x0 + wavelength;
    // Label rapatan dan renggangan hanya berjarak λ/2, jadi ditulis di dua
    // baris berselang dengan garis penunjuk pendek supaya tidak bertabrakan.
    const yLabel = midY + tinggi + 14;
    svg += `<line x1="${rapat1.toFixed(1)}" y1="${(midY + tinggi + 2).toFixed(1)}" x2="${rapat1.toFixed(1)}" y2="${(yLabel - 9).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="0.8"/>`;
    svg += `<text x="${rapat1.toFixed(1)}" y="${yLabel}" font-size="${teksKecil}" text-anchor="middle" fill="${GAYA.hitam}">rapatan</text>`;
    svg += `<line x1="${renggang.toFixed(1)}" y1="${(midY + tinggi + 2).toFixed(1)}" x2="${renggang.toFixed(1)}" y2="${(yLabel + 4).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="0.8"/>`;
    svg += `<text x="${renggang.toFixed(1)}" y="${yLabel + 13}" font-size="${teksKecil}" text-anchor="middle" fill="${GAYA.hitam}">renggangan</text>`;
    // satu λ: rapatan ke rapatan berikutnya (atau dari sumbu bila cuma satu)
    const yDim = yLabel + 34;
    const l1 = rapat1, l2 = jumlah >= 2 ? rapat2 : x0 + wavelength * 1.0;
    if (jumlah >= 2) {
      svg += putus(l1, yLabel + 5, l1, yDim);
      svg += putus(l2, yLabel + 18, l2, yDim);
      svg += garisDimensiDuaPanahSVG(l1, yDim, l2, yDim);
      svg += `<text x="${((l1 + l2) / 2).toFixed(1)}" y="${(yDim + 15).toFixed(1)}" font-size="${GAYA.teks}" font-style="italic" text-anchor="middle" fill="${GAYA.hitam}">λ</text>`;
    } else {
      svg += putus(x0, midY + tinggi + 4, x0, yDim);
      svg += putus(l2, yLabel + 18, l2, yDim);
      svg += garisDimensiDuaPanahSVG(x0, yDim, l2, yDim);
      svg += `<text x="${((x0 + l2) / 2).toFixed(1)}" y="${(yDim + 15).toFixed(1)}" font-size="${GAYA.teks}" font-style="italic" text-anchor="middle" fill="${GAYA.hitam}">λ</text>`;
    }
    width = x0 + panjang + 40;
    height = yDim + 22;
  }

  const kepala = `<svg class="ws-diagram-svg" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}" xmlns="http://www.w3.org/2000/svg">`
    + `<rect x="0.5" y="0.5" width="${(width - 1).toFixed(1)}" height="${(height - 1).toFixed(1)}" fill="#ffffff" stroke="#d8dce1"/>`;
  return kepala + svg + '</svg>';
}

// ---------------------------------------------------------------------
// 16. Medan Listrik / Medan Magnet
// ---------------------------------------------------------------------

function renderFieldSVG(cfg) {
  const jenis = String(cfg.jenis || 'positif').toLowerCase();
  let width = 260, height = 260;
  let svg = '';
  const teks = (x, y, t, size, bold) => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="${size || GAYA.teks}"${bold ? ' font-weight="700"' : ''} fill="${GAYA.hitam}">${t}</text>`;

  if (jenis === 'positif' || jenis === 'negatif') {
    // Muatan titik: lingkaran bertanda, garis medan radial tipis dengan
    // mata panah di tengah tiap garis (ke luar untuk +, ke dalam untuk −).
    const outward = jenis === 'positif';
    const cx = width / 2, cy = height / 2;
    const n = 8, r0 = 14, r1 = 112;
    for (let i = 0; i < n; i++) {
      const ang = (2 * Math.PI * i) / n;
      const x0 = cx + r0 * Math.cos(ang), y0 = cy + r0 * Math.sin(ang);
      const x1 = cx + r1 * Math.cos(ang), y1 = cy + r1 * Math.sin(ang);
      svg += outward ? garisBerarahSVG(x0, y0, x1, y1, { headLen: 8 }) : garisBerarahSVG(x1, y1, x0, y0, { headLen: 8 });
    }
    svg += `<circle cx="${cx}" cy="${cy}" r="${r0}" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    svg += teks(cx, cy + 5.5, outward ? '+' : '−', 16, true);
  } else if (jenis === 'kawat') {
    // Kawat berarus tegak lurus bidang gambar: titik = arus ke luar, silang
    // = arus masuk. Kaidah tangan kanan: arus ke luar → medan berlawanan
    // arah jarum jam (dilihat pembaca), arus masuk → searah jarum jam.
    const arah = String(cfg.arus || 'keluar').toLowerCase();
    const cx = width / 2, cy = height / 2;
    const keluar = arah !== 'masuk';
    [34, 60, 86, 112].forEach((r, i) => {
      svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${GAYA.hitam}" stroke-width="1"/>`;
      // mata panah berselang-seling di atas dan bawah lingkaran
      const ang = i % 2 ? Math.PI / 2 : -Math.PI / 2;
      const tangen = keluar ? ang - Math.PI / 2 : ang + Math.PI / 2;
      svg += kepalaPanahSVG(cx + r * Math.cos(ang), cy + r * Math.sin(ang), tangen, 8);
    });
    svg += `<circle cx="${cx}" cy="${cy}" r="9" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    if (keluar) svg += `<circle cx="${cx}" cy="${cy}" r="2.6" fill="${GAYA.hitam}"/>`;
    else svg += `<line x1="${cx - 5.5}" y1="${cy - 5.5}" x2="${cx + 5.5}" y2="${cy + 5.5}" stroke="${GAYA.hitam}" stroke-width="1.6"/><line x1="${cx - 5.5}" y1="${cy + 5.5}" x2="${cx + 5.5}" y2="${cy - 5.5}" stroke="${GAYA.hitam}" stroke-width="1.6"/>`;
    svg += `<text x="${(cx + 13).toFixed(1)}" y="${(cy - 11).toFixed(1)}" font-size="${GAYA.teks}" font-style="italic" fill="${GAYA.hitam}">I</text>`;
  } else if (jenis === 'solenoida') {
    // Solenoida: lilitan sebagai elips, garis medan lurus rapat di dalam
    // (kiri → kanan), melengkung balik di luar dari ujung N ke ujung S.
    width = 330; height = 250;
    const cx = width / 2, cy = height / 2;
    const coilW = 170, coilH = 80, turns = 6, x0 = cx - coilW / 2;
    for (let k = -2; k <= 2; k++) {
      const y = cy + k * 14;
      svg += garisBerarahSVG(x0 - 40, y, x0 + coilW + 40, y, { headLen: 8, strokeWidth: 1 });
    }
    for (let i = 0; i <= turns; i++) {
      const x = x0 + i * (coilW / turns);
      svg += `<ellipse cx="${x.toFixed(1)}" cy="${cy}" rx="7" ry="${coilH / 2}" fill="none" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    }
    // lengkung luar: busur elips dari ujung kanan (N) memutar ke ujung kiri (S)
    [0, 1].forEach((k) => {
      const dy = 14 + k * 14, ry = coilH / 2 + 20 + k * 22, rx = coilW / 2 + 40;
      [-1, 1].forEach((sisi) => {
        const y = cy + sisi * dy;
        svg += `<path d="M${(x0 + coilW + 40).toFixed(1)},${y.toFixed(1)} A${rx.toFixed(1)},${(ry - dy).toFixed(1)} 0 0 ${sisi < 0 ? 0 : 1} ${(x0 - 40).toFixed(1)},${y.toFixed(1)}" fill="none" stroke="${GAYA.hitam}" stroke-width="1"/>`;
        svg += kepalaPanahSVG(cx, cy + sisi * ry, Math.PI, 8);
      });
    });
    svg += teks(x0 - 44 - 8, cy + 4, 'S', 12, true);
    svg += teks(x0 + coilW + 44 + 8, cy + 4, 'N', 12, true);
  } else if (jenis === 'pelat' || jenis === 'seragam' || jenis === 'kapasitor') {
    // Medan seragam antara dua pelat sejajar: garis medan sejajar berjarak
    // sama dari pelat + ke pelat −, panah di tengah tiap garis.
    width = 300; height = 200;
    const px1 = 40, px2 = width - 40, yAtas = 46, yBawah = height - 46;
    svg += `<line x1="${px1}" y1="${yAtas}" x2="${px2}" y2="${yAtas}" stroke="${GAYA.hitam}" stroke-width="2.4"/>`;
    svg += `<line x1="${px1}" y1="${yBawah}" x2="${px2}" y2="${yBawah}" stroke="${GAYA.hitam}" stroke-width="2.4"/>`;
    const n = 7;
    for (let i = 0; i < n; i++) {
      const x = px1 + 20 + ((px2 - px1 - 40) * i) / (n - 1);
      svg += garisBerarahSVG(x, yAtas + 1, x, yBawah - 1, { headLen: 8, strokeWidth: 1 });
      const xt = px1 + 20 + ((px2 - px1 - 40) * (i + 0.5)) / (n - 1);
      if (i < n - 1) {
        svg += teks(xt, yAtas - 8, '+', 12, true);
        svg += teks(xt, yBawah + 17, '−', 12, true);
      }
    }
  } else if (jenis === 'magnet' || jenis === 'batang') {
    // Magnet batang: kotak N/S, garis medan keluar dari N masuk ke S.
    width = 330; height = 250;
    const cx = width / 2, cy = height / 2;
    const w = 120, h = 34;
    // Tiap garis medan: kurva Bezier kubik dari muka N (kanan) melengkung
    // ke muka S (kiri); titik kendali di luar dan di atas/bawah magnet
    // supaya garis keluar menyamping dari kutub, bukan tegak lurus.
    // Puncak lengkung (t = 0,5) ada di 0,75·tinggi kendali — di situ mata
    // panahnya, mendatar ke kiri.
    for (let k = 0; k < 3; k++) {
      const dy = 5 + k * 5, ex = 34 + k * 22, hk = 40 + k * 34;
      [-1, 1].forEach((sisi) => {
        const y = cy + sisi * dy, yk = y + sisi * hk;
        svg += `<path d="M${(cx + w / 2).toFixed(1)},${y.toFixed(1)} C${(cx + w / 2 + ex).toFixed(1)},${yk.toFixed(1)} ${(cx - w / 2 - ex).toFixed(1)},${yk.toFixed(1)} ${(cx - w / 2).toFixed(1)},${y.toFixed(1)}" fill="none" stroke="${GAYA.hitam}" stroke-width="1"/>`;
        svg += kepalaPanahSVG(cx, y + sisi * hk * 0.75, Math.PI, 8);
      });
    }
    svg += garisBerarahSVG(cx + w / 2, cy, cx + w / 2 + 44, cy, { headLen: 8, strokeWidth: 1 });
    svg += garisBerarahSVG(cx - w / 2 - 44, cy, cx - w / 2, cy, { headLen: 8, strokeWidth: 1 });
    svg += `<rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - h / 2).toFixed(1)}" width="${w}" height="${h}" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="${GAYA.garis}"/>`;
    svg += `<line x1="${cx}" y1="${(cy - h / 2).toFixed(1)}" x2="${cx}" y2="${(cy + h / 2).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1"/>`;
    svg += teks(cx - w / 4, cy + 5, 'S', 13, true);
    svg += teks(cx + w / 4, cy + 5, 'N', 13, true);
  }

  const kepala = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`
    + `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  return kepala + svg + '</svg>';
}

// ---------------------------------------------------------------------
// 17. Diagram Kulit Elektron (model Bohr — kimia)
// ---------------------------------------------------------------------

function computeShellFilling(z) {
  const capacities = [2, 8, 8, 18, 32];
  let remaining = z;
  const shells = [];
  for (let i = 0; i < capacities.length && remaining > 0; i++) {
    const take = Math.min(remaining, capacities[i]);
    shells.push(take);
    remaining -= take;
  }
  return shells;
}

// Muatan ion dari teks: "+", "2+", "-", "2-", "3+" -> bilangan bertanda (+1, +2, -1, -2, +3).
function parseMuatanIon(t) {
  const x = String(t == null ? '' : t).trim().replace(/[−–]/g, '-');
  let m = x.match(/^(\d*)\s*([+-])$/);
  if (m) return (m[2] === '-' ? -1 : 1) * (m[1] ? parseInt(m[1], 10) : 1);
  m = x.match(/^([+-])\s*(\d*)$/);
  if (m) return (m[1] === '-' ? -1 : 1) * (m[2] ? parseInt(m[2], 10) : 1);
  return 0;
}

// Model atom/ion gaya dot-and-cross (Cambridge): kulit konsentris, elektron
// berpasangan, atom asal bertanda `tanda` (titik/silang) dan elektron yang
// DITERIMA ion negatif bertanda sebaliknya; ion dikurung [ ] bermuatan.
// kosong=ya menggambar kulitnya saja (murid melengkapi elektron dan muatan).
function renderAtomIonSVG(cfg) {
  const z = Math.max(1, Math.round(numOrDefault(cfg.nomor, 11)));
  const muatan = parseMuatanIon(cfg.ion);
  const kosong = /^(ya|true|1)$/i.test(String(cfg.kosong || ''));
  const silangAsal = /^silang|cross|x$/i.test(String(cfg.tanda || ''));
  const e = Math.max(0, z - muatan);
  const kulitIon = cfg.kulit ? String(cfg.kulit).split(',').map(Number) : computeShellFilling(e);
  const kulitAtom = computeShellFilling(z);
  const r0 = 14, step = 21;
  const R = r0 + kulitIon.length * step;
  const cx = 0, cy = 0;
  let body = '';
  body += `<circle cx="0" cy="0" r="9.5" fill="${GAYA.putih}" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
  body += `<text x="0" y="3.6" text-anchor="middle" font-size="10" font-weight="700" fill="${GAYA.hitam}">${escText(cfg.unsur || '+' + z)}</text>`;
  kulitIon.forEach((jumlah, i) => {
    const r = r0 + (i + 1) * step;
    body += `<circle cx="0" cy="0" r="${r}" fill="none" stroke="${GAYA.hitam}" stroke-width="1.1"/>`;
    if (kosong) return;
    const asal = Math.min(jumlah, kulitAtom[i] || 0);      // elektron milik atom asal di kulit ini
    const pasang = Math.ceil(jumlah / 2);
    let k = 0;
    for (let q = 0; q < pasang; q++) {
      const ang = -Math.PI / 2 + (2 * Math.PI * q) / pasang;
      const dalam = Math.min(2, jumlah - q * 2);
      for (let t = 0; t < dalam; t++, k++) {
        const geser = dalam === 2 ? (t === 0 ? -4.6 : 4.6) : 0;
        const ex = r * Math.cos(ang) - Math.sin(ang) * geser, ey = r * Math.sin(ang) + Math.cos(ang) * geser;
        const silang = k < asal ? silangAsal : !silangAsal;   // asal: tanda pilihan; diterima: kebalikan
        body += elektronSVG(ex, ey, silang);
      }
    }
  });
  let minX = -R - 4, maxX = R + 4, minY = -R - 4, maxY = R + 4;
  if (muatan !== 0 || cfg.ion) {
    body += kurungIonSVG(cx, cy, R);
    const t = R + 7;
    const tulis = kosong ? '.....' : (Math.abs(muatan) > 1 ? String(Math.abs(muatan)) : '') + (muatan < 0 ? '−' : '+');
    body += `<text x="${(t + 4).toFixed(1)}" y="${(-t + 8).toFixed(1)}" font-size="${GAYA.teks}" fill="${GAYA.hitam}">${escText(tulis)}</text>`;
    minX = -t - 3; maxX = t + 12 + tulis.length * 6; minY = -t - 3; maxY = t + 3;
  }
  if (cfg.judul) {
    body += `<text x="0" y="${(minY - 6).toFixed(1)}" text-anchor="middle" font-size="${GAYA.teks}" fill="${GAYA.hitam}">${escText(cfg.judul)}</text>`;
    minY -= 18;
  }
  const pad = 6, width = maxX - minX + 2 * pad, height = maxY - minY + 2 * pad;
  return svgPas(width, height, `<g transform="translate(${(pad - minX).toFixed(1)},${(pad - minY).toFixed(1)})">${body}</g>`, cfg);
}

function renderElectronShellSVG(cfg) {
  const z = Math.max(1, Math.round(numOrDefault(cfg.nomor, 11)));
  if (cfg.ion || cfg.kosong || cfg.tanda || cfg.judul) return renderAtomIonSVG(cfg);
  const unsur = cfg.unsur || '';
  const shells = cfg.kulit ? String(cfg.kulit).split(',').map(Number) : computeShellFilling(z);

  const width = 300, height = 300, cx = width / 2, cy = width / 2 - 6;
  const r0 = 16, step = 32;
  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  svg += `<circle cx="${cx}" cy="${cy}" r="12" fill="#fef3c7" stroke="#000000" stroke-width="1.6"/>`;
  svg += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="10" font-weight="700" fill="#000000">${escText(unsur || '+' + z)}</text>`;

  shells.forEach((count, i) => {
    const r = r0 + (i + 1) * step;
    if (r > Math.min(width, height) / 2 - 14) return;
    svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#94a3b8" stroke-width="1.2"/>`;
    for (let e = 0; e < count; e++) {
      const ang = (2 * Math.PI * e) / count - Math.PI / 2;
      const ex = cx + r * Math.cos(ang), ey = cy + r * Math.sin(ang);
      svg += `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3.2" fill="#000000"/>`;
    }
  });

  svg += `<text x="${cx}" y="${height - 16}" text-anchor="middle" font-size="11" fill="#000000">${escText(unsur)}${unsur ? ' ' : ''}(Z=${z}): ${shells.join(', ')}</text>`;

  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 18. Kurva Titrasi (pH vs volume titran — kimia)
// ---------------------------------------------------------------------

function renderTitrationSVG(cfg) {
  const jenis = String(cfg.jenis || 'kuat-kuat').toLowerCase();
  const vAwal = numOrDefault(cfg.volume_awal, 25);
  const vEq = vAwal;
  const vMax = vEq * 2;
  const width = 380, height = 280, pad = 42;
  const toPx = (v, ph) => [pad + (v / vMax) * (width - 2 * pad), height - pad - (ph / 14) * (height - 2 * pad)];

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  svg += `<line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#94a3b8" stroke-width="1.2"/>`;
  svg += `<line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="#94a3b8" stroke-width="1.2"/>`;
  svg += `<text x="${pad}" y="16" font-size="10" fill="#475569">pH</text>`;
  svg += `<text x="${width - pad}" y="${height - pad + 30}" font-size="10" text-anchor="end" fill="#475569">Volume titran (mL)</text>`;

  let phStart, phEnd, steepness;
  if (jenis === 'lemah-kuat') { phStart = 3; phEnd = 12; steepness = 6; }
  else if (jenis === 'kuat-lemah') { phStart = 1; phEnd = 11; steepness = 6; }
  else if (jenis === 'lemah-lemah') { phStart = 3; phEnd = 10; steepness = 4; }
  else { phStart = 1; phEnd = 13; steepness = 8; } // kuat-kuat (default)

  let d = '';
  const steps = 100;
  for (let s = 0; s <= steps; s++) {
    const v = (vMax * s) / steps;
    const ph = phStart + (phEnd - phStart) / (1 + Math.exp((-steepness * 4 * (v - vEq)) / vMax));
    const [px, py] = toPx(v, ph);
    d += (s === 0 ? 'M' : 'L') + px.toFixed(1) + ' ' + py.toFixed(1) + ' ';
  }
  svg += `<path d="${d}" fill="none" stroke="#000000" stroke-width="2"/>`;

  const [eqx] = toPx(vEq, 0);
  svg += `<line x1="${eqx.toFixed(1)}" y1="${pad}" x2="${eqx.toFixed(1)}" y2="${(height - pad).toFixed(1)}" stroke="#b91c1c" stroke-width="1" stroke-dasharray="3,3"/>`;
  svg += `<text x="${(eqx + 4).toFixed(1)}" y="${pad + 12}" font-size="9.5" fill="#b91c1c">Titik ekuivalen</text>`;

  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 19. Kurva Katalis (perbandingan Ea dengan/tanpa katalis — kimia)
// ---------------------------------------------------------------------

function renderCatalystSVG(cfg) {
  const eReaktan = numOrDefault(cfg.reaktan, 0);
  const eProduk = numOrDefault(cfg.produk, -40);
  const eaTanpa = numOrDefault(cfg.ea_tanpa, 80);
  const eaDengan = numOrDefault(cfg.ea_dengan, 40);
  const satuan = cfg.satuan || 'kJ/mol';

  const width = 380, height = 260, padTop = 24, padBottom = 44, padX = 50;
  const chartH = height - padTop - padBottom;
  const vmin = Math.min(eReaktan, eProduk);
  const vmax = Math.max(eReaktan + eaTanpa, eReaktan + eaDengan);
  const toY = (v) => padTop + chartH - ((v - vmin) / ((vmax - vmin) || 1)) * chartH;
  const x0 = padX, x1 = width - padX, xm = (x0 + x1) / 2;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;

  function hump(peakE, color, dash) {
    const yStart = toY(eReaktan), yPeak = toY(eReaktan + peakE), yEnd = toY(eProduk);
    svg += `<path d="M${x0},${yStart.toFixed(1)} Q${xm},${yPeak.toFixed(1)} ${x1},${yEnd.toFixed(1)}" fill="none" stroke="${color}" stroke-width="2"${dash ? ' stroke-dasharray="' + dash + '"' : ''}/>`;
    return yPeak;
  }
  const yPeakTanpa = hump(eaTanpa, '#b91c1c', '5,3');
  const yPeakDengan = hump(eaDengan, '#16a34a', null);

  svg += `<line x1="${x0 - 10}" y1="${toY(eReaktan).toFixed(1)}" x2="${x0 + 14}" y2="${toY(eReaktan).toFixed(1)}" stroke="#000000" stroke-width="2.2"/>`;
  svg += `<line x1="${x1 - 14}" y1="${toY(eProduk).toFixed(1)}" x2="${x1 + 10}" y2="${toY(eProduk).toFixed(1)}" stroke="#000000" stroke-width="2.2"/>`;
  svg += `<text x="${x0}" y="${(toY(eReaktan) + 16).toFixed(1)}" font-size="10.5" fill="#000000">Reaktan</text>`;
  svg += `<text x="${(x1 - 40).toFixed(1)}" y="${(toY(eProduk) + 16).toFixed(1)}" font-size="10.5" fill="#000000">Produk</text>`;
  svg += `<text x="${xm.toFixed(1)}" y="${(yPeakTanpa - 6).toFixed(1)}" text-anchor="middle" font-size="9.5" fill="#b91c1c">Ea tanpa katalis = ${eaTanpa} ${escText(satuan)}</text>`;
  svg += `<text x="${xm.toFixed(1)}" y="${(yPeakDengan - 6).toFixed(1)}" text-anchor="middle" font-size="9.5" fill="#16a34a">Ea dengan katalis = ${eaDengan} ${escText(satuan)}</text>`;

  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 20. Struktur Kristal / Kisi (ionik & kovalen raksasa — kimia)
// ---------------------------------------------------------------------

function renderLatticeSVG(cfg) {
  const jenis = String(cfg.jenis || 'ionik').toLowerCase();
  const width = 320, height = 280;
  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;

  if (jenis === 'logam' || jenis === 'metalik' || jenis === 'metal') {
    // Ikatan logam: kation tersusun rapi di "lautan" elektron terdelokalisasi.
    const q = String(cfg.muatan || '+'), baris = 3, kolom = 5, cell = 44, x0 = 54, y0 = 56;
    for (let row = 0; row < baris; row++) {
      for (let col = 0; col < kolom; col++) {
        const x = x0 + col * cell, y = y0 + row * cell;
        svg += `<circle cx="${x}" cy="${y}" r="13" fill="#ffffff" stroke="#000000" stroke-width="1.2"/>`;
        svg += `<text x="${x}" y="${y + 3.8}" text-anchor="middle" font-size="10.5" fill="#000000">${escText(q)}</text>`;
        // elektron di sela kation: di tengah antar-kolom dan antar-baris
        if (col < kolom - 1) svg += `<circle cx="${x + cell / 2}" cy="${y + (row % 2 ? 6 : -6)}" r="2" fill="#000000"/>`;
        if (row < baris - 1) svg += `<circle cx="${x + (col % 2 ? 6 : -6)}" cy="${y + cell / 2}" r="2" fill="#000000"/>`;
      }
    }
    svg += `<circle cx="22" cy="${height - 42}" r="6" fill="#ffffff" stroke="#000000" stroke-width="1"/><text x="34" y="${height - 38}" font-size="10" fill="#000000">= ion positif</text>`;
    svg += `<circle cx="22" cy="${height - 24}" r="2" fill="#000000"/><text x="34" y="${height - 20}" font-size="10" fill="#000000">= elektron terdelokalisasi</text>`;
  } else if (jenis === 'ionik') {
    // Kisi ionik gaya buku: ion negatif besar (putih) saling berdekatan, ion positif kecil (hitam) di sela-selanya.
    const n = 4, cell = 30, x0 = 90, y0 = 52;
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const x = x0 + col * cell, y = y0 + row * cell;
        const isPos = (row + col) % 2 === 0;
        svg += isPos
          ? `<circle cx="${x}" cy="${y}" r="7" fill="#000000" stroke="#000000" stroke-width="1"/>`
          : `<circle cx="${x}" cy="${y}" r="14.5" fill="#ffffff" stroke="#000000" stroke-width="1.2"/>`;
      }
    }
    svg += `<text x="20" y="${height - 40}" font-size="10" fill="#000000">● ion positif</text>`;
    svg += `<text x="20" y="${height - 24}" font-size="10" fill="#000000">◯ ion negatif</text>`;
    svg += `<text x="${width / 2}" y="${height - 8}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#000000">${escText(cfg.formula || 'Kisi Ionik')}</text>`;
  } else {
    const bentuk = String(cfg.bentuk || 'intan').toLowerCase();
    if (bentuk === 'grafit' || bentuk === 'graphite') {
      const rows = 3, cols = 5, x0 = 50, y0 = 60, dx = 34, dy = 30;
      for (let layer = 0; layer < 2; layer++) {
        const ly = y0 + layer * 90;
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            const cxp = x0 + col * dx + (row % 2 ? dx / 2 : 0), cyp = ly + row * dy;
            svg += `<circle cx="${cxp.toFixed(1)}" cy="${cyp.toFixed(1)}" r="3" fill="#000000"/>`;
          }
        }
      }
      svg += `<text x="${width / 2}" y="${height - 8}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#000000">Grafit (lapisan heksagonal)</text>`;
    } else {
      const cx = width / 2, cy = height / 2 - 10;
      const positions = [[0, -60], [52, -20], [-52, -20], [32, 55], [-32, 55]];
      positions.forEach(([dx, dy]) => {
        svg += `<line x1="${cx}" y1="${cy}" x2="${(cx + dx).toFixed(1)}" y2="${(cy + dy).toFixed(1)}" stroke="#000000" stroke-width="1.4"/>`;
        svg += `<circle cx="${(cx + dx).toFixed(1)}" cy="${(cy + dy).toFixed(1)}" r="6" fill="#e2e8f0" stroke="#000000" stroke-width="1.2"/>`;
      });
      svg += `<circle cx="${cx}" cy="${cy}" r="7" fill="#e2e8f0" stroke="#000000" stroke-width="1.4"/>`;
      svg += `<text x="${width / 2}" y="${height - 8}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#000000">Intan (struktur tetrahedral)</text>`;
    }
  }

  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 21. Piramida Ekologi (biologi)
// ---------------------------------------------------------------------

function renderEcoPyramidSVG(cfg) {
  const levels = parseEnergyLevelList(cfg.tingkat);
  const list = levels.length ? levels : [{ name: 'Produsen', value: 500 }, { name: 'Konsumen I', value: 50 }, { name: 'Konsumen II', value: 5 }, { name: 'Konsumen III', value: 1 }];
  const tipe = cfg.tipe || 'jumlah';

  const width = 340, rowH = 44, padTop = 20, padBottom = 26;
  const height = padTop + padBottom + list.length * rowH;
  const maxW = width - 60;
  const maxVal = Math.max(...list.map((l) => l.value || 1), 1);
  const logMax = Math.log10(maxVal + 1) || 1;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;

  list.forEach((lv, i) => {
    const w = Math.max(30, (Math.log10((lv.value || 0) + 1) / logMax) * maxW);
    const y = height - padBottom - (i + 1) * rowH;
    const x = (width - w) / 2;
    svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${rowH - 4}" fill="#ecfccb" stroke="#000000" stroke-width="1.4"/>`;
    svg += `<text x="${(width / 2).toFixed(1)}" y="${(y + rowH / 2).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="#000000">${escText(lv.name)} (${lv.value})</text>`;
  });

  svg += `<text x="${(width / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="9.5" fill="#64748b">Piramida ${escText(tipe)}</text>`;

  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 7. Tabel Data
// ---------------------------------------------------------------------

// Rows use "|" between rows and "," between cells (not SVG — plain HTML
// <table>, since a data/frequency table is text, not a coordinate drawing).
function renderTableHTML(cfg) {
  const headers = pisahKolom(String(cfg.header || ''));
  const rows = String(cfg.baris || '')
    .split('|')
    .map((r) => r.split(',').map((c) => c.trim()))
    .filter((r) => !(r.length === 1 && r[0] === ''));

  let html = '';
  if (cfg.judul) html += `<div class="ws-table-title">${escText(cfg.judul)}</div>`;
  html += '<table class="ws-table">';
  if (headers.length) {
    // "element*2" = judul kolom yang membentang dua kolom
    html += '<thead><tr>' + headers.map((h) => { const m = h.match(/^(.*)\*(\d+)$/); return m ? `<th colspan="${m[2]}">${escText(m[1].trim())}</th>` : `<th>${escText(h)}</th>`; }).join('') + '</tr></thead>';
  }
  html += '<tbody>';
  rows.forEach((r) => {
    html += '<tr>' + r.map((c) => `<td>${escText(c)}</td>`).join('') + '</tr>';
  });
  html += '</tbody></table>';
  return html;
}

// ---------------------------------------------------------------------
// 6y. Biologi lanjutan — Punnett, kunci determinasi, jaring makanan
// ---------------------------------------------------------------------

// Splits a genotype into its gene pairs: "AaBb" -> [['A','a'], ['B','b']].
// Alleles of one gene are always the same letter in different cases, which
// is what lets a plain string be read without any extra separator.
function splitGenotype(raw) {
  const letters = String(raw || '').replace(/[^A-Za-z]/g, '').split('');
  const genes = [];
  for (let i = 0; i < letters.length; i += 2) {
    if (letters[i + 1] == null) break;
    genes.push([letters[i], letters[i + 1]]);
  }
  return genes;
}

// Every gamete a parent can make: one allele from each gene, in all
// combinations (2^n for n genes).
function gametesOf(genes) {
  let out = [''];
  genes.forEach(([a, b]) => {
    const next = [];
    out.forEach((prefix) => {
      next.push(prefix + a);
      if (b !== a) next.push(prefix + b);
      else next.push(prefix + b);
    });
    out = next;
  });
  // Identical gametes still occupy their own row/column: a 2x2 grid for
  // "AA x Aa" is what makes the 1:1 ratio visible.
  return out;
}

// Offspring genotype, written the conventional way — dominant (capital)
// allele first within each gene pair.
function combineGametes(g1, g2) {
  let out = '';
  for (let i = 0; i < g1.length; i++) {
    const pair = [g1[i], g2[i]].sort((a, b) => {
      if (a.toLowerCase() !== b.toLowerCase()) return 0;
      return a === a.toUpperCase() ? -1 : 1;
    });
    out += pair.join('');
  }
  return out;
}

function phenotypeOf(genotype) {
  // "Dominant if at least one capital allele in the pair" — the phenotype
  // rule a school-level cross assumes.
  let out = '';
  for (let i = 0; i < genotype.length; i += 2) {
    const a = genotype[i], b = genotype[i + 1];
    const dom = a === a.toUpperCase() || b === b.toUpperCase();
    out += dom ? a.toUpperCase() + '_' : a.toLowerCase() + b.toLowerCase();
  }
  return out;
}

function ratioString(counts) {
  const keys = Object.keys(counts).sort();
  const values = keys.map((k) => counts[k]);
  // Reduce by the greatest common divisor so "4:8:4" reads as "1:2:1".
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = values.reduce((acc, v) => gcd(acc, v), 0) || 1;
  return keys.map((k, i) => k + ' ' + (values[i] / g)).join(' : ');
}

function renderPunnettSVG(cfg) {
  const genes1 = splitGenotype(cfg.induk1 || 'Aa');
  const genes2 = splitGenotype(cfg.induk2 || 'Aa');
  if (!genes1.length || !genes2.length) throw new Error('punnett perlu induk1= dan induk2= (mis. Aa)');
  if (genes1.length !== genes2.length) throw new Error('punnett: kedua induk harus punya jumlah gen yang sama');
  const cols = gametesOf(genes1);
  const rows = gametesOf(genes2);

  const cell = Math.max(34, Math.min(58, 220 / Math.max(cols.length, rows.length)));
  const head = cell;
  const pad = 14;
  const gridW = head + cols.length * cell;
  const gridH = head + rows.length * cell;
  const showRatio = String(cfg.rasio || 'ya').toLowerCase() !== 'tidak';
  const ratioH = showRatio ? 42 : 8;
  const W = Math.max(260, gridW + pad * 2);
  const H = gridH + pad * 2 + ratioH;
  const blank = String(cfg.jawaban || 'lengkap').toLowerCase() === 'kosong';

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  const ox = (W - gridW) / 2, oy = pad;

  const genoCounts = {}, phenoCounts = {};
  cols.forEach((cg, i) => {
    svg += `<text x="${(ox + head + i * cell + cell / 2).toFixed(1)}" y="${(oy + head / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="#000000">${escText(cg)}</text>`;
  });
  rows.forEach((rg, j) => {
    svg += `<text x="${(ox + head / 2).toFixed(1)}" y="${(oy + head + j * cell + cell / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="#000000">${escText(rg)}</text>`;
    cols.forEach((cg, i) => {
      const x = ox + head + i * cell, y = oy + head + j * cell;
      svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.3"/>`;
      const geno = combineGametes(cg, rg);
      genoCounts[geno] = (genoCounts[geno] || 0) + 1;
      const pheno = phenotypeOf(geno);
      phenoCounts[pheno] = (phenoCounts[pheno] || 0) + 1;
      if (!blank) {
        svg += `<text x="${(x + cell / 2).toFixed(1)}" y="${(y + cell / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="11.5" fill="#000000">${escText(geno)}</text>`;
      }
    });
  });
  svg += `<line x1="${ox.toFixed(1)}" y1="${(oy + head).toFixed(1)}" x2="${(ox + gridW).toFixed(1)}" y2="${(oy + head).toFixed(1)}" stroke="#000000" stroke-width="1.5"/>`;
  svg += `<line x1="${(ox + head).toFixed(1)}" y1="${oy.toFixed(1)}" x2="${(ox + head).toFixed(1)}" y2="${(oy + gridH).toFixed(1)}" stroke="#000000" stroke-width="1.5"/>`;

  if (showRatio && !blank) {
    svg += `<text x="${(W / 2).toFixed(1)}" y="${(oy + gridH + 18).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="#000000">Genotipe — ${escText(ratioString(genoCounts))}</text>`;
    svg += `<text x="${(W / 2).toFixed(1)}" y="${(oy + gridH + 33).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="#000000">Fenotipe — ${escText(ratioString(phenoCounts))}</text>`;
  }
  svg += '</svg>';
  return svg;
}

// Dichotomous key: each step offers two mutually exclusive statements, and
// each statement either names an organism or sends the reader on to
// another step. "1a:Berdaun jarum:Pinus | 1b:Berdaun lebar:2 | ..."
function renderDichotomousKeySVG(cfg) {
  const steps = String(cfg.langkah || '').split('|').map((s) => s.trim()).filter(Boolean).map((chunk) => {
    const parts = chunk.split(':').map((x) => x.trim());
    return { label: parts[0] || '', text: parts[1] || '', result: parts[2] || '' };
  });
  if (!steps.length) throw new Error('kuncideterminasi perlu langkah= (mis. 1a:Berdaun jarum:Pinus)');

  const rowH = 22, padL = 16, padT = 22, resultX = 260;
  const W = 420;
  const H = padT + steps.length * rowH + 16;
  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  if (cfg.judul) {
    svg += `<text x="${(W / 2).toFixed(1)}" y="15" text-anchor="middle" font-size="12" font-weight="700" fill="#000000">${escText(cfg.judul)}</text>`;
  }
  steps.forEach((step, i) => {
    const y = padT + i * rowH + 12;
    // A new numbered step is separated from the previous pair by a rule,
    // so the two branches of one step read as belonging together.
    const num = (step.label.match(/^\d+/) || [''])[0];
    const prevNum = i ? (steps[i - 1].label.match(/^\d+/) || [''])[0] : num;
    if (i && num !== prevNum) {
      svg += `<line x1="${padL}" y1="${(y - 15).toFixed(1)}" x2="${(W - padL).toFixed(1)}" y2="${(y - 15).toFixed(1)}" stroke="#e5e9ef" stroke-width="1"/>`;
    }
    svg += `<text x="${padL}" y="${y.toFixed(1)}" font-size="11" font-weight="700" fill="#000000">${escText(step.label)}</text>`;
    svg += `<text x="${(padL + 30).toFixed(1)}" y="${y.toFixed(1)}" font-size="11" fill="#000000">${escText(step.text)}</text>`;
    if (step.result) {
      const goesToStep = /^\d+$/.test(step.result);
      svg += `<text x="${(W - padL).toFixed(1)}" y="${y.toFixed(1)}" text-anchor="end" font-size="11" font-style="${goesToStep ? 'normal' : 'italic'}" fill="#000000">${escText(goesToStep ? 'lanjut ke ' + step.result : step.result)}</text>`;
      svg += `<line x1="${(padL + 34 + step.text.length * 5.4).toFixed(1)}" y1="${(y - 3).toFixed(1)}" x2="${(W - padL - Math.max(40, step.result.length * 5.6)).toFixed(1)}" y2="${(y - 3).toFixed(1)}" stroke="#cbd5e1" stroke-width="0.8" stroke-dasharray="2,3"/>`;
    }
  });
  svg += '</svg>';
  return svg;
}

// Food WEB (as opposed to the existing linear food chain): a set of
// "eaten>eater" links, laid out in trophic levels worked out from how far
// each organism sits from a producer.
function renderFoodWebSVG(cfg) {
  const links = String(cfg.hubungan || '').split(',').map((s) => s.trim()).filter(Boolean).map((chunk) => {
    const [from, to] = chunk.split('>').map((x) => (x || '').trim());
    return from && to ? { from, to } : null;
  }).filter(Boolean);
  if (!links.length) throw new Error('jaringmakanan perlu hubungan= (mis. Rumput>Belalang, Belalang>Katak)');

  const names = [];
  links.forEach((l) => {
    if (names.indexOf(l.from) === -1) names.push(l.from);
    if (names.indexOf(l.to) === -1) names.push(l.to);
  });
  // Trophic level = longest chain of "is eaten by" steps reaching this
  // organism. Iterating to a fixed point handles links given in any order;
  // the pass cap also stops a cyclic web from looping forever.
  const level = {};
  names.forEach((n) => { level[n] = 0; });
  for (let pass = 0; pass < names.length + 1; pass++) {
    let changed = false;
    links.forEach((l) => {
      if (level[l.to] < level[l.from] + 1) { level[l.to] = level[l.from] + 1; changed = true; }
    });
    if (!changed) break;
  }
  const maxLevel = Math.max.apply(null, names.map((n) => level[n]));
  const byLevel = [];
  for (let i = 0; i <= maxLevel; i++) byLevel.push(names.filter((n) => level[n] === i));

  const boxW = 86, boxH = 34, gapY = 62, padX = 18, padY = 18;
  const widest = Math.max.apply(null, byLevel.map((row) => row.length));
  const W = Math.max(320, padX * 2 + widest * (boxW + 18) - 18);
  const H = padY * 2 + (maxLevel + 1) * boxH + maxLevel * (gapY - boxH);

  const pos = {};
  byLevel.forEach((row, i) => {
    // Producers at the bottom, top predators at the top — the way an
    // ecology diagram is always drawn.
    const y = H - padY - boxH - i * gapY;
    const rowW = row.length * boxW + (row.length - 1) * 18;
    const x0 = (W - rowW) / 2;
    row.forEach((n, k) => { pos[n] = { x: x0 + k * (boxW + 18), y }; });
  });

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  links.forEach((l) => {
    const a = pos[l.from], b = pos[l.to];
    if (!a || !b) return;
    // Arrows point from the eaten to the eater — the direction energy
    // flows, which is exactly what these questions test.
    svg += arrowSVG(a.x + boxW / 2, a.y, b.x + boxW / 2, b.y + boxH);
  });
  names.forEach((n) => {
    const p = pos[n];
    svg += `<rect x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" width="${boxW}" height="${boxH}" fill="#ffffff" stroke="#000000" stroke-width="1.5"/>`;
    svg += `<text x="${(p.x + boxW / 2).toFixed(1)}" y="${(p.y + boxH / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="#000000">${escText(n)}</text>`;
  });
  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 6z. Geometri lanjutan — teorema lingkaran, jaring-jaring, pandangan
// ---------------------------------------------------------------------

// Point on a circle at a bearing measured in ordinary maths degrees
// (0 = east, counter-clockwise). SVG's y axis points down, so the sine is
// negated — every circle-theorem diagram below is placed through here.
function circlePoint(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
}

// Small arc marking the angle at vertex V between rays VA and VB, with an
// optional label just outside it — the notation a geometry question is
// answered in.
function angleArcSVG(vx, vy, ax, ay, bx, by, r, text) {
  const a1 = Math.atan2(ay - vy, ax - vx);
  const a2 = Math.atan2(by - vy, bx - vx);
  let diff = a2 - a1;
  while (diff <= -Math.PI) diff += 2 * Math.PI;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  const sweep = diff > 0 ? 1 : 0;
  const p1 = [vx + r * Math.cos(a1), vy + r * Math.sin(a1)];
  const p2 = [vx + r * Math.cos(a2), vy + r * Math.sin(a2)];
  let s = `<path d="M${p1[0].toFixed(1)} ${p1[1].toFixed(1)} A${r} ${r} 0 0 ${sweep} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.2"/>`;
  if (text) {
    const mid = a1 + diff / 2;
    const lx = vx + (r + 13) * Math.cos(mid);
    const ly = vy + (r + 13) * Math.sin(mid);
    s += annotText(lx, ly + 3.5, text);
  }
  return s;
}

// Right-angle square at vertex V, drawn towards A and B.
function rightAngleSVG(vx, vy, ax, ay, bx, by, size) {
  const n = (px, py) => {
    const d = Math.hypot(px - vx, py - vy) || 1;
    return [(px - vx) / d, (py - vy) / d];
  };
  const [ux, uy] = n(ax, ay);
  const [wx, wy] = n(bx, by);
  const k = size || 9;
  return `<path d="M${(vx + ux * k).toFixed(1)} ${(vy + uy * k).toFixed(1)} L${(vx + ux * k + wx * k).toFixed(1)} ${(vy + uy * k + wy * k).toFixed(1)} L${(vx + wx * k).toFixed(1)} ${(vy + wy * k).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.2"/>`;
}

function ptLabel(x, y, cx, cy, name) {
  // Pushed radially outward from the circle's centre so a vertex label
  // never sits on top of the shape it belongs to.
  const d = Math.hypot(x - cx, y - cy) || 1;
  return annotText(x + ((x - cx) / d) * 12, y + ((y - cy) / d) * 12 + 3.5, name);
}

const CIRCLE_THEOREMS = {
  'sudut-pusat': function (cx, cy, r, ang) {
    const a = ang || 110;
    const A = circlePoint(cx, cy, r, 200), B = circlePoint(cx, cy, r, 340);
    const P = circlePoint(cx, cy, r, 90);
    let s = `<line x1="${cx}" y1="${cy}" x2="${A[0].toFixed(1)}" y2="${A[1].toFixed(1)}" stroke="#000000" stroke-width="1.5"/>`;
    s += `<line x1="${cx}" y1="${cy}" x2="${B[0].toFixed(1)}" y2="${B[1].toFixed(1)}" stroke="#000000" stroke-width="1.5"/>`;
    s += `<line x1="${P[0].toFixed(1)}" y1="${P[1].toFixed(1)}" x2="${A[0].toFixed(1)}" y2="${A[1].toFixed(1)}" stroke="#000000" stroke-width="1.5"/>`;
    s += `<line x1="${P[0].toFixed(1)}" y1="${P[1].toFixed(1)}" x2="${B[0].toFixed(1)}" y2="${B[1].toFixed(1)}" stroke="#000000" stroke-width="1.5"/>`;
    s += angleArcSVG(cx, cy, A[0], A[1], B[0], B[1], 24, a + '°');
    s += angleArcSVG(P[0], P[1], A[0], A[1], B[0], B[1], 20, 'x');
    s += `<circle cx="${cx}" cy="${cy}" r="2.4" fill="#000000"/>` + annotText(cx + 10, cy + 14, 'O');
    s += ptLabel(A[0], A[1], cx, cy, 'A') + ptLabel(B[0], B[1], cx, cy, 'B') + ptLabel(P[0], P[1], cx, cy, 'P');
    return s;
  },
  'sudut-keliling': function (cx, cy, r) {
    const A = circlePoint(cx, cy, r, 205), B = circlePoint(cx, cy, r, 335);
    const P = circlePoint(cx, cy, r, 75), Q = circlePoint(cx, cy, r, 120);
    let s = '';
    [P, Q].forEach((V, i) => {
      s += `<line x1="${V[0].toFixed(1)}" y1="${V[1].toFixed(1)}" x2="${A[0].toFixed(1)}" y2="${A[1].toFixed(1)}" stroke="#000000" stroke-width="1.5"/>`;
      s += `<line x1="${V[0].toFixed(1)}" y1="${V[1].toFixed(1)}" x2="${B[0].toFixed(1)}" y2="${B[1].toFixed(1)}" stroke="#000000" stroke-width="1.5"/>`;
      s += angleArcSVG(V[0], V[1], A[0], A[1], B[0], B[1], 18, i ? 'y' : 'x');
    });
    s += ptLabel(A[0], A[1], cx, cy, 'A') + ptLabel(B[0], B[1], cx, cy, 'B');
    s += ptLabel(P[0], P[1], cx, cy, 'P') + ptLabel(Q[0], Q[1], cx, cy, 'Q');
    return s;
  },
  'semilingkaran': function (cx, cy, r) {
    const A = circlePoint(cx, cy, r, 180), B = circlePoint(cx, cy, r, 0);
    const P = circlePoint(cx, cy, r, 65);
    let s = `<line x1="${A[0].toFixed(1)}" y1="${A[1].toFixed(1)}" x2="${B[0].toFixed(1)}" y2="${B[1].toFixed(1)}" stroke="#000000" stroke-width="1.5"/>`;
    s += `<line x1="${P[0].toFixed(1)}" y1="${P[1].toFixed(1)}" x2="${A[0].toFixed(1)}" y2="${A[1].toFixed(1)}" stroke="#000000" stroke-width="1.5"/>`;
    s += `<line x1="${P[0].toFixed(1)}" y1="${P[1].toFixed(1)}" x2="${B[0].toFixed(1)}" y2="${B[1].toFixed(1)}" stroke="#000000" stroke-width="1.5"/>`;
    s += rightAngleSVG(P[0], P[1], A[0], A[1], B[0], B[1], 10);
    s += `<circle cx="${cx}" cy="${cy}" r="2.4" fill="#000000"/>` + annotText(cx, cy + 16, 'O');
    s += ptLabel(A[0], A[1], cx, cy, 'A') + ptLabel(B[0], B[1], cx, cy, 'B') + ptLabel(P[0], P[1], cx, cy, 'P');
    return s;
  },
  'segiempat-talibusur': function (cx, cy, r) {
    const pts = [140, 40, 315, 220].map((d) => circlePoint(cx, cy, r, d));
    let s = `<polygon points="${pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}" fill="none" stroke="#000000" stroke-width="1.5"/>`;
    s += angleArcSVG(pts[0][0], pts[0][1], pts[3][0], pts[3][1], pts[1][0], pts[1][1], 18, 'a');
    s += angleArcSVG(pts[2][0], pts[2][1], pts[1][0], pts[1][1], pts[3][0], pts[3][1], 18, 'c');
    'ABCD'.split('').forEach((n, i) => { s += ptLabel(pts[i][0], pts[i][1], cx, cy, n); });
    return s;
  },
  'tangen-jari': function (cx, cy, r) {
    const T = circlePoint(cx, cy, r, 55);
    const dx = Math.cos((55 * Math.PI) / 180), dy = -Math.sin((55 * Math.PI) / 180);
    // Tangent runs perpendicular to OT, so its direction is OT turned 90°.
    const tx = -dy, ty = dx;
    const P1 = [T[0] - tx * 62, T[1] - ty * 62], P2 = [T[0] + tx * 62, T[1] + ty * 62];
    let s = `<line x1="${cx}" y1="${cy}" x2="${T[0].toFixed(1)}" y2="${T[1].toFixed(1)}" stroke="#000000" stroke-width="1.5"/>`;
    s += `<line x1="${P1[0].toFixed(1)}" y1="${P1[1].toFixed(1)}" x2="${P2[0].toFixed(1)}" y2="${P2[1].toFixed(1)}" stroke="#000000" stroke-width="1.5"/>`;
    s += rightAngleSVG(T[0], T[1], cx, cy, P2[0], P2[1], 10);
    s += `<circle cx="${cx}" cy="${cy}" r="2.4" fill="#000000"/>` + annotText(cx - 12, cy + 4, 'O');
    s += ptLabel(T[0], T[1], cx, cy, 'T');
    s += annotText(P2[0], P2[1] + 12, 'garis singgung');
    return s;
  },
  'dua-tangen': function (cx, cy, r) {
    const P = [cx + r * 2.1, cy];
    const d = Math.hypot(P[0] - cx, P[1] - cy);
    const alpha = Math.acos(r / d);
    const base = Math.atan2(cy - P[1], cx - P[0]);
    const T1 = [cx + r * Math.cos(base + Math.PI - alpha), cy + r * Math.sin(base + Math.PI - alpha)];
    const T2 = [cx + r * Math.cos(base + Math.PI + alpha), cy + r * Math.sin(base + Math.PI + alpha)];
    let s = '';
    [T1, T2].forEach((T) => {
      s += `<line x1="${P[0].toFixed(1)}" y1="${P[1].toFixed(1)}" x2="${T[0].toFixed(1)}" y2="${T[1].toFixed(1)}" stroke="#000000" stroke-width="1.5"/>`;
      s += `<line x1="${cx}" y1="${cy}" x2="${T[0].toFixed(1)}" y2="${T[1].toFixed(1)}" stroke="#000000" stroke-width="1.2" stroke-dasharray="4,3"/>`;
      s += rightAngleSVG(T[0], T[1], cx, cy, P[0], P[1], 9);
    });
    s += `<circle cx="${cx}" cy="${cy}" r="2.4" fill="#000000"/>` + annotText(cx - 12, cy + 4, 'O');
    s += ptLabel(T1[0], T1[1], cx, cy, 'A') + ptLabel(T2[0], T2[1], cx, cy, 'B');
    s += annotText(P[0] + 14, P[1] + 4, 'P');
    return s;
  }
};

function renderCircleTheoremSVG(cfg) {
  const key = String(cfg.jenis || 'sudut-pusat').toLowerCase().trim();
  const build = CIRCLE_THEOREMS[key];
  if (!build) throw new Error('jenis teorema lingkaran tidak dikenal: "' + key + '"');
  const W = 320, H = 300, r = 96;
  const cx = key === 'dua-tangen' ? 128 : W / 2;
  const cy = H / 2;
  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#000000" stroke-width="1.6"/>`;
  svg += build(cx, cy, r, numOrDefault(cfg.sudut, null));
  svg += '</svg>';
  return svg;
}

// --- Jaring-jaring (nets of solids) ------------------------------------
const SOLID_NETS = {
  kubus: function (u) {
    const cells = [[1, 0], [0, 1], [1, 1], [2, 1], [3, 1], [1, 2]];
    return { cols: 4, rows: 3, rects: cells.map(([c, r]) => [c * u, r * u, u, u]), extra: '' };
  },
  balok: function (u) {
    // p x l x t drawn as a cross: the classic "which net folds into this
    // cuboid" figure, with each face proportioned differently.
    const p = u * 1.6, l = u, t = u * 0.7;
    const rects = [
      [t, 0, p, t], [0, t, t, l], [t, t, p, l], [t + p, t, t, l],
      [t + p + t, t, p, l], [t, t + l, p, t]
    ];
    return { cols: (t + p + t + p) / u, rows: (t + l + t) / u, rects, extra: '' };
  },
  'prisma-segitiga': function (u) {
    const w = u * 1.4, h = u * 1.2, tri = u * 1.2;
    const rects = [[tri, 0, w, h], [tri, h, w, h], [tri, 2 * h, w, h]];
    const extra = `<polygon points="${tri},0 ${tri},${h} 0,${(h / 2).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.5"/>`
      + `<polygon points="${tri + w},0 ${tri + w},${h} ${(tri + w + tri).toFixed(1)},${(h / 2).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.5"/>`;
    return { cols: (tri * 2 + w) / u, rows: (3 * h) / u, rects, extra };
  },
  'limas-segiempat': function (u) {
    const a = u * 1.3, h = u * 1.1;
    const x0 = h, y0 = h;
    const rects = [[x0, y0, a, a]];
    const extra = [
      `<polygon points="${x0},${y0} ${x0 + a},${y0} ${(x0 + a / 2).toFixed(1)},${(y0 - h).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.5"/>`,
      `<polygon points="${x0},${y0 + a} ${x0 + a},${y0 + a} ${(x0 + a / 2).toFixed(1)},${(y0 + a + h).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.5"/>`,
      `<polygon points="${x0},${y0} ${x0},${y0 + a} ${(x0 - h).toFixed(1)},${(y0 + a / 2).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.5"/>`,
      `<polygon points="${x0 + a},${y0} ${x0 + a},${y0 + a} ${(x0 + a + h).toFixed(1)},${(y0 + a / 2).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.5"/>`
    ].join('');
    return { cols: (a + 2 * h) / u, rows: (a + 2 * h) / u, rects, extra };
  },
  tabung: function (u) {
    const w = u * 3, h = u * 1.4, r = u * 0.48;
    const rects = [[r * 2, r * 2, w, h]];
    const extra = `<circle cx="${(r * 2 + w / 2).toFixed(1)}" cy="${r}" r="${r}" fill="none" stroke="#000000" stroke-width="1.5"/>`
      + `<circle cx="${(r * 2 + w / 2).toFixed(1)}" cy="${(r * 2 + h + r).toFixed(1)}" r="${r}" fill="none" stroke="#000000" stroke-width="1.5"/>`;
    return { cols: (r * 4 + w) / u, rows: (r * 4 + h) / u, rects, extra };
  },
  kerucut: function (u) {
    const R = u * 1.5, r = u * 0.6;
    const cx = R + r * 2, cy = R + 6;
    // 240° sector: the lateral surface of a cone whose base radius is two
    // thirds of its slant height.
    const p1 = [cx + R * Math.cos(-Math.PI / 1.5), cy + R * Math.sin(-Math.PI / 1.5)];
    const p2 = [cx + R * Math.cos(Math.PI / 1.5), cy + R * Math.sin(Math.PI / 1.5)];
    const extra = `<path d="M${cx} ${cy} L${p1[0].toFixed(1)} ${p1[1].toFixed(1)} A${R} ${R} 0 1 1 ${p2[0].toFixed(1)} ${p2[1].toFixed(1)} Z" fill="none" stroke="#000000" stroke-width="1.5"/>`
      + `<circle cx="${cx}" cy="${(cy + R + r + 8).toFixed(1)}" r="${r}" fill="none" stroke="#000000" stroke-width="1.5"/>`;
    return { cols: (R * 2 + r * 4) / u, rows: (R + R + r * 2 + 20) / u, rects: [], extra };
  }
};

function renderNetSVG(cfg) {
  const key = String(cfg.bentuk || 'kubus').toLowerCase().trim();
  const build = SOLID_NETS[key];
  if (!build) throw new Error('bentuk jaring-jaring tidak dikenal: "' + key + '"');
  const u = 52;
  const net = build(u);
  const pad = 18;
  const W = Math.round(net.cols * u) + pad * 2;
  const H = Math.round(net.rows * u) + pad * 2;
  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  svg += `<g transform="translate(${pad},${pad})">`;
  net.rects.forEach(([x, y, w, h]) => {
    svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.5"/>`;
  });
  svg += net.extra;
  svg += '</g></svg>';
  return svg;
}

// --- Pandangan (plan and elevations) -----------------------------------
// Front / side / plan views of a solid, the "gambar tampak" question. Each
// view is a simple outline, drawn in its own labelled box.
const SOLID_VIEWS = {
  kubus: { depan: 'persegi', samping: 'persegi', atas: 'persegi' },
  balok: { depan: 'lebar', samping: 'sempit', atas: 'lebar' },
  tabung: { depan: 'lebar', samping: 'lebar', atas: 'lingkaran' },
  kerucut: { depan: 'segitiga', samping: 'segitiga', atas: 'lingkaran-titik' },
  'limas-segiempat': { depan: 'segitiga', samping: 'segitiga', atas: 'persegi-diagonal' },
  'prisma-segitiga': { depan: 'segitiga', samping: 'lebar', atas: 'persegi' },
  bola: { depan: 'lingkaran', samping: 'lingkaran', atas: 'lingkaran' }
};

function viewShapeSVG(shape, x, y, w, h) {
  const mid = x + w / 2;
  switch (shape) {
    case 'persegi':
      return `<rect x="${(mid - h / 2).toFixed(1)}" y="${y}" width="${h}" height="${h}" fill="none" stroke="#000000" stroke-width="1.6"/>`;
    case 'lebar':
      return `<rect x="${x}" y="${(y + h * 0.15).toFixed(1)}" width="${w}" height="${(h * 0.7).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.6"/>`;
    case 'sempit':
      return `<rect x="${(mid - w * 0.22).toFixed(1)}" y="${(y + h * 0.15).toFixed(1)}" width="${(w * 0.44).toFixed(1)}" height="${(h * 0.7).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.6"/>`;
    case 'segitiga':
      return `<polygon points="${x},${y + h} ${(x + w).toFixed(1)},${y + h} ${mid.toFixed(1)},${y}" fill="none" stroke="#000000" stroke-width="1.6"/>`;
    case 'lingkaran':
      return `<circle cx="${mid.toFixed(1)}" cy="${(y + h / 2).toFixed(1)}" r="${(h / 2).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.6"/>`;
    case 'lingkaran-titik':
      return `<circle cx="${mid.toFixed(1)}" cy="${(y + h / 2).toFixed(1)}" r="${(h / 2).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.6"/>`
        + `<circle cx="${mid.toFixed(1)}" cy="${(y + h / 2).toFixed(1)}" r="2.2" fill="#000000"/>`;
    case 'persegi-diagonal':
      return `<rect x="${(mid - h / 2).toFixed(1)}" y="${y}" width="${h}" height="${h}" fill="none" stroke="#000000" stroke-width="1.6"/>`
        + `<line x1="${(mid - h / 2).toFixed(1)}" y1="${y}" x2="${(mid + h / 2).toFixed(1)}" y2="${y + h}" stroke="#000000" stroke-width="1.1"/>`
        + `<line x1="${(mid + h / 2).toFixed(1)}" y1="${y}" x2="${(mid - h / 2).toFixed(1)}" y2="${y + h}" stroke="#000000" stroke-width="1.1"/>`;
    default:
      return '';
  }
}

function renderViewsSVG(cfg) {
  const key = String(cfg.bentuk || 'kubus').toLowerCase().trim();
  const views = SOLID_VIEWS[key];
  if (!views) throw new Error('bentuk pandangan tidak dikenal: "' + key + '"');
  const boxW = 116, boxH = 106, gap = 14, pad = 16, capH = 20;
  const W = pad * 2 + boxW * 3 + gap * 2;
  const H = pad * 2 + boxH + capH;
  const blank = String(cfg.jawaban || 'lengkap').toLowerCase() === 'kosong';
  const order = [['depan', 'Tampak Depan'], ['samping', 'Tampak Samping'], ['atas', 'Tampak Atas']];

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  order.forEach(([slot, caption], i) => {
    const x = pad + i * (boxW + gap);
    svg += `<rect x="${x}" y="${pad}" width="${boxW}" height="${boxH}" fill="none" stroke="#b8c0cc" stroke-width="1" stroke-dasharray="4,3"/>`;
    // "jawaban=kosong" leaves the three boxes empty for the student to draw
    // the views into — the form the question is usually asked in.
    if (!blank) {
      svg += viewShapeSVG(views[slot], x + 18, pad + 16, boxW - 36, boxH - 32);
    }
    svg += `<text x="${(x + boxW / 2).toFixed(1)}" y="${(pad + boxH + 15).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="#000000">${caption}</text>`;
  });
  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 7. Alat Laboratorium (kimia/fisika)
// ---------------------------------------------------------------------
// Apparatus diagrams — the thing every IGCSE/A-Level practical question is
// built around, and the one subject area this file had nothing at all for.
// Drawn as plain outlines with leader-line labels, because that is how an
// exam paper draws them: the student has to be able to name the parts.

// Leader line from a label to the thing it names, with a dot at the target.
function labelLead(x1, y1, x2, y2, text, anchorPos) {
  let s = `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#64748b" stroke-width="0.9"/>`;
  s += `<circle cx="${x2.toFixed(1)}" cy="${y2.toFixed(1)}" r="1.6" fill="#64748b"/>`;
  s += `<text x="${x1.toFixed(1)}" y="${(y1 + 3).toFixed(1)}" font-size="9.5" text-anchor="${anchorPos || 'end'}" fill="#000000">${escText(text)}</text>`;
  return s;
}

function bunsenSVG(cx, baseY) {
  let s = '';
  s += `<line x1="${(cx - 22).toFixed(1)}" y1="${baseY}" x2="${(cx + 22).toFixed(1)}" y2="${baseY}" stroke="#000000" stroke-width="1.6"/>`;
  s += `<path d="M${(cx - 18).toFixed(1)} ${baseY} L${(cx - 5).toFixed(1)} ${(baseY - 26).toFixed(1)} L${(cx + 5).toFixed(1)} ${(baseY - 26).toFixed(1)} L${(cx + 18).toFixed(1)} ${baseY} Z" fill="none" stroke="#000000" stroke-width="1.4"/>`;
  s += `<rect x="${(cx - 5).toFixed(1)}" y="${(baseY - 50).toFixed(1)}" width="10" height="24" fill="none" stroke="#000000" stroke-width="1.4"/>`;
  // Flame
  s += `<path d="M${(cx - 6).toFixed(1)} ${(baseY - 50).toFixed(1)} Q${cx.toFixed(1)} ${(baseY - 72).toFixed(1)} ${(cx + 6).toFixed(1)} ${(baseY - 50).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.2"/>`;
  return s;
}

function conicalFlaskSVG(cx, baseY, w, h, liquidFrac) {
  const halfTop = 7, halfBase = w / 2;
  let s = `<path d="M${(cx - halfTop).toFixed(1)} ${(baseY - h).toFixed(1)} L${(cx - halfTop).toFixed(1)} ${(baseY - h + 14).toFixed(1)} L${(cx - halfBase).toFixed(1)} ${baseY} L${(cx + halfBase).toFixed(1)} ${baseY} L${(cx + halfTop).toFixed(1)} ${(baseY - h + 14).toFixed(1)} L${(cx + halfTop).toFixed(1)} ${(baseY - h).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.6"/>`;
  if (liquidFrac > 0) {
    const ly = baseY - (h - 14) * liquidFrac;
    const halfAtY = halfBase - (halfBase - halfTop) * ((baseY - ly) / (h - 14));
    s += `<path d="M${(cx - halfAtY).toFixed(1)} ${ly.toFixed(1)} L${(cx - halfBase).toFixed(1)} ${baseY} L${(cx + halfBase).toFixed(1)} ${baseY} L${(cx + halfAtY).toFixed(1)} ${ly.toFixed(1)} Z" fill="#000000" fill-opacity="0.10" stroke="#000000" stroke-width="1"/>`;
  }
  return s;
}

function beakerSVG(x, baseY, w, h, liquidFrac) {
  let s = `<path d="M${x.toFixed(1)} ${(baseY - h).toFixed(1)} L${x.toFixed(1)} ${baseY} L${(x + w).toFixed(1)} ${baseY} L${(x + w).toFixed(1)} ${(baseY - h).toFixed(1)}" fill="none" stroke="#000000" stroke-width="1.6"/>`;
  if (liquidFrac > 0) {
    const ly = baseY - h * liquidFrac;
    s += `<rect x="${(x + 1).toFixed(1)}" y="${ly.toFixed(1)}" width="${(w - 2).toFixed(1)}" height="${(baseY - ly - 1).toFixed(1)}" fill="#000000" fill-opacity="0.10" stroke="none"/>`;
    s += `<line x1="${x.toFixed(1)}" y1="${ly.toFixed(1)}" x2="${(x + w).toFixed(1)}" y2="${ly.toFixed(1)}" stroke="#000000" stroke-width="1"/>`;
  }
  return s;
}

const LAB_APPARATUS = {
  destilasi: function () {
    const W = 420, H = 300;
    let s = '';
    // Round-bottom flask over a Bunsen burner
    s += `<circle cx="80" cy="196" r="30" fill="none" stroke="#000000" stroke-width="1.6"/>`;
    s += `<path d="M74 168 L74 128 M86 168 L86 128" fill="none" stroke="#000000" stroke-width="1.6"/>`;
    s += `<path d="M52 200 A30 30 0 0 0 108 200" fill="#000000" fill-opacity="0.10" stroke="none"/>`;
    s += bunsenSVG(80, 288);
    // Thermometer in the neck
    s += `<line x1="80" y1="124" x2="80" y2="176" stroke="#000000" stroke-width="1.2"/>`;
    s += `<circle cx="80" cy="178" r="3" fill="#000000"/>`;
    // Liebig condenser, sloping down to the right
    s += `<path d="M88 132 L232 176" stroke="#000000" stroke-width="1.6" fill="none"/>`;
    s += `<path d="M84 146 L228 190" stroke="#000000" stroke-width="1.6" fill="none"/>`;
    s += `<path d="M104 120 L248 164 L244 196 L100 152 Z" fill="none" stroke="#000000" stroke-width="1.6"/>`;
    s += `<line x1="120" y1="128" x2="112" y2="106" stroke="#000000" stroke-width="1.4"/>`;
    s += `<line x1="236" y1="186" x2="244" y2="208" stroke="#000000" stroke-width="1.4"/>`;
    // Receiver
    s += conicalFlaskSVG(292, 268, 54, 70, 0.25);
    s += `<line x1="248" y1="180" x2="292" y2="200" stroke="#000000" stroke-width="1.6"/>`;
    s += labelLead(70, 96, 80, 130, 'Termometer');
    s += labelLead(196, 84, 176, 140, 'Kondensor Liebig');
    s += labelLead(340, 118, 300, 200, 'Distilat', 'start');
    s += labelLead(30, 250, 62, 210, 'Labu didih', 'start');
    s += labelLead(120, 240, 106, 118, 'Air keluar', 'start');
    s += labelLead(268, 232, 246, 206, 'Air masuk', 'start');
    return { W, H, s };
  },
  titrasi: function () {
    // W=360, bukan 300: label terpanjang ("Buret berisi titran" dari x=250)
    // dulu tercetak sampai x≈356 dan terpotong di tepi kanvas.
    const W = 360, H = 320;
    let s = '';
    // Burette with a tap and graduations
    s += `<rect x="132" y="24" width="22" height="170" fill="none" stroke="#000000" stroke-width="1.6"/>`;
    for (let i = 1; i <= 8; i++) {
      const y = 34 + i * 18;
      s += `<line x1="132" y1="${y}" x2="${i % 2 ? 141 : 146}" y2="${y}" stroke="#000000" stroke-width="0.9"/>`;
    }
    s += `<rect x="136" y="30" width="14" height="70" fill="#000000" fill-opacity="0.10" stroke="none"/>`;
    s += `<path d="M132 194 L143 210 L154 194 Z" fill="none" stroke="#000000" stroke-width="1.6"/>`;
    s += `<circle cx="143" cy="200" r="5" fill="#ffffff" stroke="#000000" stroke-width="1.4"/>`;
    s += `<line x1="143" y1="210" x2="143" y2="226" stroke="#000000" stroke-width="1.6"/>`;
    s += `<circle cx="143" cy="234" r="2.4" fill="#000000"/>`;
    // Clamp and stand
    s += `<line x1="60" y1="24" x2="60" y2="300" stroke="#000000" stroke-width="2"/>`;
    s += `<rect x="34" y="300" width="120" height="8" fill="none" stroke="#000000" stroke-width="1.6"/>`;
    s += `<line x1="60" y1="110" x2="132" y2="110" stroke="#000000" stroke-width="2"/>`;
    // Conical flask on a white tile
    s += conicalFlaskSVG(143, 292, 76, 74, 0.35);
    s += `<rect x="96" y="292" width="94" height="8" fill="none" stroke="#000000" stroke-width="1.4"/>`;
    s += labelLead(250, 60, 156, 90, 'Buret berisi titran', 'start');
    s += labelLead(250, 200, 152, 200, 'Kran', 'start');
    s += labelLead(258, 258, 176, 268, 'Labu erlenmeyer', 'start');
    s += labelLead(258, 302, 192, 296, 'Ubin putih', 'start');
    return { W, H, s };
  },
  elektrolisis: function () {
    const W = 360, H = 280;
    let s = '';
    s += beakerSVG(90, 240, 180, 120, 0.8);
    // Electrodes dipping into the electrolyte
    s += `<rect x="130" y="96" width="12" height="120" fill="#ffffff" stroke="#000000" stroke-width="1.6"/>`;
    s += `<rect x="218" y="96" width="12" height="120" fill="#ffffff" stroke="#000000" stroke-width="1.6"/>`;
    // Bubbles at each electrode
    [0, 1, 2].forEach((k) => {
      s += `<circle cx="${124 - k * 0}" cy="${170 - k * 22}" r="3" fill="none" stroke="#000000" stroke-width="1"/>`;
      s += `<circle cx="${236}" cy="${162 - k * 22}" r="3" fill="none" stroke="#000000" stroke-width="1"/>`;
    });
    // Cell and leads
    s += `<line x1="136" y1="96" x2="136" y2="46" stroke="#000000" stroke-width="1.6"/>`;
    s += `<line x1="224" y1="96" x2="224" y2="46" stroke="#000000" stroke-width="1.6"/>`;
    s += `<line x1="136" y1="46" x2="166" y2="46" stroke="#000000" stroke-width="1.6"/>`;
    s += `<line x1="194" y1="46" x2="224" y2="46" stroke="#000000" stroke-width="1.6"/>`;
    s += `<line x1="166" y1="34" x2="166" y2="58" stroke="#000000" stroke-width="1.6"/>`;
    s += `<line x1="174" y1="40" x2="174" y2="52" stroke="#000000" stroke-width="3"/>`;
    s += `<line x1="184" y1="34" x2="184" y2="58" stroke="#000000" stroke-width="1.6"/>`;
    s += `<line x1="194" y1="40" x2="194" y2="52" stroke="#000000" stroke-width="3"/>`;
    s += `<text x="156" y="28" text-anchor="middle" font-size="11" fill="#000000">+</text>`;
    s += `<text x="204" y="28" text-anchor="middle" font-size="11" fill="#000000">−</text>`;
    s += labelLead(60, 110, 130, 120, 'Anoda (+)', 'start');
    s += labelLead(320, 110, 230, 120, 'Katoda (−)');
    s += labelLead(320, 200, 250, 200, 'Larutan elektrolit');
    return { W, H, s };
  },
  tabunggas: function () {
    const W = 420, H = 240;
    let s = '';
    s += conicalFlaskSVG(84, 200, 76, 86, 0.4);
    s += `<ellipse cx="84" cy="114" rx="9" ry="6" fill="none" stroke="#000000" stroke-width="1.4"/>`;
    s += `<path d="M84 108 L84 84 L200 84" fill="none" stroke="#000000" stroke-width="1.6"/>`;
    // Gas syringe with a graduated barrel and plunger
    s += `<rect x="200" y="66" width="150" height="36" fill="none" stroke="#000000" stroke-width="1.6"/>`;
    for (let i = 1; i < 6; i++) {
      s += `<line x1="${200 + i * 25}" y1="66" x2="${200 + i * 25}" y2="74" stroke="#000000" stroke-width="0.9"/>`;
    }
    s += `<line x1="272" y1="66" x2="272" y2="102" stroke="#000000" stroke-width="1.8"/>`;
    s += `<line x1="272" y1="84" x2="378" y2="84" stroke="#000000" stroke-width="1.6"/>`;
    s += `<line x1="378" y1="72" x2="378" y2="96" stroke="#000000" stroke-width="1.8"/>`;
    s += `<rect x="200" y="67" width="71" height="34" fill="#000000" fill-opacity="0.08" stroke="none"/>`;
    s += labelLead(40, 60, 76, 130, 'Labu reaksi', 'start');
    s += labelLead(150, 44, 150, 84, 'Tabung penyalur', 'start');
    s += labelLead(300, 140, 260, 102, 'Tabung suntik gas', 'start');
    s += labelLead(60, 224, 74, 186, 'Campuran reaksi', 'start');
    return { W, H, s };
  },
  penyaringan: function () {
    const W = 300, H = 300;
    let s = '';
    // Funnel with folded filter paper
    s += `<path d="M74 44 L216 44 L152 132 L138 132 Z" fill="none" stroke="#000000" stroke-width="1.6"/>`;
    s += `<path d="M86 52 L204 52 L150 128 L140 128 Z" fill="none" stroke="#000000" stroke-width="1.1" stroke-dasharray="4,3"/>`;
    s += `<line x1="138" y1="132" x2="138" y2="168" stroke="#000000" stroke-width="1.6"/>`;
    s += `<line x1="152" y1="132" x2="152" y2="168" stroke="#000000" stroke-width="1.6"/>`;
    s += `<path d="M92 60 L198 60 L150 122 L140 122 Z" fill="#000000" fill-opacity="0.10" stroke="none"/>`;
    // Receiving conical flask
    s += conicalFlaskSVG(145, 276, 92, 116, 0.22);
    s += `<circle cx="145" cy="190" r="2.4" fill="#000000"/>`;
    s += labelLead(272, 40, 200, 48, 'Corong');
    s += labelLead(272, 78, 186, 66, 'Kertas saring');
    s += labelLead(272, 118, 168, 92, 'Residu');
    s += labelLead(272, 250, 176, 262, 'Filtrat');
    return { W, H, s };
  },
  pemanasan: function () {
    const W = 320, H = 300;
    let s = '';
    // Tripod and gauze
    s += `<line x1="70" y1="176" x2="250" y2="176" stroke="#000000" stroke-width="1.6"/>`;
    s += `<line x1="84" y1="176" x2="70" y2="264" stroke="#000000" stroke-width="1.6"/>`;
    s += `<line x1="236" y1="176" x2="250" y2="264" stroke="#000000" stroke-width="1.6"/>`;
    s += `<line x1="160" y1="176" x2="160" y2="264" stroke="#000000" stroke-width="1.2" stroke-dasharray="4,3"/>`;
    s += `<rect x="92" y="168" width="136" height="8" fill="none" stroke="#000000" stroke-width="1.3"/>`;
    s += beakerSVG(108, 168, 104, 82, 0.6);
    s += bunsenSVG(160, 288);
    s += labelLead(292, 96, 212, 116, 'Gelas kimia');
    s += labelLead(292, 172, 232, 172, 'Kasa asbes');
    s += labelLead(60, 200, 84, 200, 'Kaki tiga', 'start');
    s += labelLead(292, 248, 178, 252, 'Pembakar Bunsen');
    return { W, H, s };
  }
};

const LAB_ALIASES = {
  destilasi: 'destilasi', distilasi: 'destilasi', distillation: 'destilasi',
  titrasi: 'titrasi', titration: 'titrasi',
  elektrolisis: 'elektrolisis', electrolysis: 'elektrolisis', selelektrolisis: 'elektrolisis',
  tabunggas: 'tabunggas', gassyringe: 'tabunggas', suntikgas: 'tabunggas',
  penyaringan: 'penyaringan', filtrasi: 'penyaringan', filtration: 'penyaringan',
  pemanasan: 'pemanasan', heating: 'pemanasan', kakitiga: 'pemanasan'
};

function renderLabApparatusSVG(cfg) {
  const key = LAB_ALIASES[String(cfg.jenis || 'destilasi').toLowerCase().replace(/[\s_-]/g, '')];
  const build = key && LAB_APPARATUS[key];
  if (!build) {
    throw new Error('jenis alat lab tidak dikenal: "' + String(cfg.jenis || '') + '"');
  }
  const { W, H, s } = build();
  // "label=tidak" strips the leader-line captions, turning any apparatus
  // diagram into a blank one for the student to name themselves — the
  // standard "label the parts of the apparatus" question.
  const body = String(cfg.label || 'ya').toLowerCase() === 'tidak'
    ? s.replace(/<text[\s\S]*?<\/text>/g, '')
    : s;
  const titleH = cfg.judul ? 20 : 0;
  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${W} ${H + titleH}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H + titleH - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  if (cfg.judul) {
    svg += `<text x="${(W / 2).toFixed(1)}" y="15" text-anchor="middle" font-size="12" font-weight="700" fill="#000000">${escText(cfg.judul)}</text>`;
  }
  svg += `<g transform="translate(0,${titleH})">${body}</g></svg>`;
  return svg;
}

// ---------------------------------------------------------------------
// 7a. Statistika lanjutan — pencar, histogram, batang-daun
// ---------------------------------------------------------------------

function parseNumberList(raw) {
  return String(raw || '').split(',').map((s) => parseFloat(s.trim())).filter((n) => isFinite(n));
}

// Least-squares line through the points. Returned as the gradient and
// intercept a student is asked to read off the drawn line, plus r so the
// author can quote the correlation in the question if they want it.
function leastSquaresFit(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxy += xs[i] * ys[i];
    sxx += xs[i] * xs[i];
    syy += ys[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const m = (n * sxy - sx * sy) / denom;
  const c = (sy - m * sx) / n;
  const rDen = Math.sqrt(denom * (n * syy - sy * sy));
  const r = Math.abs(rDen) < 1e-12 ? 0 : (n * sxy - sx * sy) / rDen;
  return { m, c, r, meanX: sx / n, meanY: sy / n };
}

function renderScatterSVG(cfg) {
  const xs = parseNumberList(cfg.x);
  const ys = parseNumberList(cfg.y);
  if (!xs.length || !ys.length) throw new Error('pencar perlu x= dan y= berisi angka');
  const n = Math.min(xs.length, ys.length);
  // Batang galat: satu angka berlaku untuk semua titik, daftar per titik.
  const errs = parseNumberList(cfg.galat);

  const plotW = 320, plotH = 230;
  const dataXmin = Math.min.apply(null, xs), dataXmax = Math.max.apply(null, xs);
  const dataYmin = Math.min.apply(null, ys), dataYmax = Math.max.apply(null, ys);
  const maxErr = errs.length ? Math.max.apply(null, errs) : 0;
  // Sumbu dilebarkan ke kelipatan langkah di luar data supaya tidak ada
  // tanda silang yang duduk tepat di sumbu.
  const xStep = niceStep(dataXmax - dataXmin || 1);
  const yStep = niceStep((dataYmax + maxErr) - (dataYmin - maxErr) || 1);
  const xmin = numOrDefault(cfg.xmin, Math.floor(dataXmin / xStep) * xStep);
  const xmax = numOrDefault(cfg.xmax, Math.ceil(dataXmax / xStep) * xStep);
  const ymin = numOrDefault(cfg.ymin, Math.floor((dataYmin - maxErr) / yStep) * yStep);
  const ymax = numOrDefault(cfg.ymax, Math.ceil((dataYmax + maxErr) / yStep) * yStep);
  const xTicks = [], yTicks = [];
  for (let gx = Math.ceil(xmin / xStep) * xStep; gx <= xmax + 1e-9; gx += xStep) xTicks.push(Math.round(gx * 1e6) / 1e6);
  for (let gy = Math.ceil(ymin / yStep) * yStep; gy <= ymax + 1e-9; gy += yStep) yTicks.push(Math.round(gy * 1e6) / 1e6);
  const yTickW = Math.max.apply(null, yTicks.map((v) => lebarTeksKira(formatTick(v), GAYA.teksKecil)).concat([0]));
  const labelX = cfg.sumbux ? labelSumbuALevel(cfg.sumbux) : 'x';
  const labelY = cfg.sumbuy ? labelSumbuALevel(cfg.sumbuy) : 'y';
  const padL = yTickW + 16, padR = 12 + lebarTeksKira(labelX) + 10, padT = (cfg.judul ? 18 : 0) + 28, padB = 26;
  const width = Math.max(padL + plotW + padR, padL - 8 + lebarTeksKira(labelY) + 6), height = padT + plotH + padB;
  const xAxisY = padT + plotH, yAxisX = padL;
  const toPx = (x, y) => [padL + ((x - xmin) / ((xmax - xmin) || 1)) * plotW, xAxisY - ((y - ymin) / ((ymax - ymin) || 1)) * plotH];

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width.toFixed(0)} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  if (cfg.judul) {
    svg += `<text x="${(padL + plotW / 2).toFixed(1)}" y="14" text-anchor="middle" font-size="${GAYA.teks}" font-weight="700" fill="${GAYA.hitam}">${escText(cfg.judul)}</text>`;
  }
  xTicks.forEach((gx) => { const [px] = toPx(gx, ymin); svg += `<line x1="${px.toFixed(1)}" y1="${padT}" x2="${px.toFixed(1)}" y2="${xAxisY}" stroke="${GAYA.abuMuda}" stroke-width="0.6"/>`; });
  yTicks.forEach((gy) => { const [, py] = toPx(xmin, gy); svg += `<line x1="${padL}" y1="${py.toFixed(1)}" x2="${padL + plotW}" y2="${py.toFixed(1)}" stroke="${GAYA.abuMuda}" stroke-width="0.6"/>`; });

  const fit = leastSquaresFit(xs.slice(0, n), ys.slice(0, n));
  // Garis lurus terbaik putus-putus, digambar SEBELUM titik supaya tanda
  // silang tetap terbaca di tempat garis melewatinya. Dipotong ke jendela
  // plot supaya tidak keluar sumbu.
  if (fit && String(cfg.garis || 'ya').toLowerCase() !== 'tidak') {
    const seg = clipLineToRect(-fit.m, 1, fit.c, xmin, xmax, ymin, ymax);
    if (seg) {
      const a = toPx(seg[0].x, seg[0].y), b = toPx(seg[1].x, seg[1].y);
      svg += `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.2" stroke-dasharray="${GAYA.putus}"/>`;
    }
    // Titik rata-rata (x̄, ȳ) yang wajib dilewati garis menurut skema penilaian.
    if (String(cfg.rerata || '').toLowerCase() === 'ya') {
      const mp = toPx(fit.meanX, fit.meanY);
      svg += `<circle cx="${mp[0].toFixed(1)}" cy="${mp[1].toFixed(1)}" r="4" fill="none" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
      svg += `<circle cx="${mp[0].toFixed(1)}" cy="${mp[1].toFixed(1)}" r="1.5" fill="${GAYA.hitam}"/>`;
    }
  }

  for (let i = 0; i < n; i++) {
    const [px, py] = toPx(xs[i], ys[i]);
    if (errs.length) {
      const e = errs.length === 1 ? errs[0] : (errs[i] || 0);
      if (e) {
        const top = toPx(xs[i], ys[i] + e)[1];
        const bot = toPx(xs[i], ys[i] - e)[1];
        svg += `<line x1="${px.toFixed(1)}" y1="${top.toFixed(1)}" x2="${px.toFixed(1)}" y2="${bot.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1"/>`;
        svg += `<line x1="${(px - 4).toFixed(1)}" y1="${top.toFixed(1)}" x2="${(px + 4).toFixed(1)}" y2="${top.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1"/>`;
        svg += `<line x1="${(px - 4).toFixed(1)}" y1="${bot.toFixed(1)}" x2="${(px + 4).toFixed(1)}" y2="${bot.toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1"/>`;
      }
    }
    // Tanda silang, bukan titik: konvensi plot yang dinilai semua dewan ujian.
    svg += `<line x1="${(px - 4).toFixed(1)}" y1="${(py - 4).toFixed(1)}" x2="${(px + 4).toFixed(1)}" y2="${(py + 4).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
    svg += `<line x1="${(px - 4).toFixed(1)}" y1="${(py + 4).toFixed(1)}" x2="${(px + 4).toFixed(1)}" y2="${(py - 4).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
  }

  svg += sumbuALevelSVG({ xAxisY, yAxisX, xFrom: padL, xTo: padL + plotW + 10, yFrom: xAxisY, yTo: padT - 10, labelX, labelY });
  xTicks.forEach((gx) => { svg += tickXSVG(toPx(gx, ymin)[0], xAxisY, formatTick(gx)); });
  yTicks.forEach((gy) => { svg += tickYSVG(yAxisX, toPx(xmin, gy)[1], formatTick(gy)); });
  svg += '</svg>';
  return svg;
}

// Histogram with UNEQUAL class widths — the version that actually appears
// on an international paper, where the y axis is frequency DENSITY and it
// is the bar's area, not its height, that represents the frequency.
function renderHistogramSVG(cfg) {
  const bounds = parseNumberList(cfg.batas);
  const freqs = parseNumberList(cfg.frekuensi);
  if (bounds.length < 2 || freqs.length !== bounds.length - 1) {
    throw new Error('histogram perlu batas= (n+1 angka) dan frekuensi= (n angka)');
  }
  const classes = freqs.map((f, i) => {
    const w = bounds[i + 1] - bounds[i];
    return { lo: bounds[i], hi: bounds[i + 1], freq: f, width: w, density: w > 0 ? f / w : 0 };
  });

  const plotW = 320, plotH = 230;
  const xmin = bounds[0], xmax = bounds[bounds.length - 1];
  const maxDensity = Math.max.apply(null, classes.map((c) => c.density)) || 1;
  const yStep = niceStep(maxDensity);
  const ymax = Math.ceil(maxDensity / yStep) * yStep;
  const yTicks = [];
  for (let gy = 0; gy <= ymax + 1e-9; gy += yStep) yTicks.push(Math.round(gy * 1e6) / 1e6);
  const yTickW = Math.max.apply(null, yTicks.map((v) => lebarTeksKira(formatTick(v), GAYA.teksKecil)).concat([0]));
  const labelX = cfg.sumbux ? labelSumbuALevel(cfg.sumbux) : 'kelas';
  const labelY = cfg.sumbuy ? labelSumbuALevel(cfg.sumbuy) : 'densitas frekuensi';
  const padL = yTickW + 16, padR = 12 + lebarTeksKira(labelX) + 10, padT = (cfg.judul ? 18 : 0) + 28, padB = 26;
  const width = Math.max(padL + plotW + padR, padL - 8 + lebarTeksKira(labelY) + 6), height = padT + plotH + padB;
  const xAxisY = padT + plotH, yAxisX = padL;
  const toX = (x) => padL + ((x - xmin) / ((xmax - xmin) || 1)) * plotW;
  const toY = (d) => xAxisY - (d / (ymax || 1)) * plotH;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width.toFixed(0)} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  if (cfg.judul) {
    svg += `<text x="${(padL + plotW / 2).toFixed(1)}" y="14" text-anchor="middle" font-size="${GAYA.teks}" font-weight="700" fill="${GAYA.hitam}">${escText(cfg.judul)}</text>`;
  }
  yTicks.forEach((gy) => {
    if (gy === 0) return;
    svg += `<line x1="${padL}" y1="${toY(gy).toFixed(1)}" x2="${padL + plotW}" y2="${toY(gy).toFixed(1)}" stroke="${GAYA.abuMuda}" stroke-width="0.6"/>`;
  });
  // Batang berdempetan (histogram, bukan diagram batang), abu-abu muda
  // bertepi hitam; LUAS batang mewakili frekuensi.
  classes.forEach((c) => {
    const x1 = toX(c.lo), x2 = toX(c.hi), y = toY(c.density);
    svg += `<rect x="${x1.toFixed(1)}" y="${y.toFixed(1)}" width="${(x2 - x1).toFixed(1)}" height="${(xAxisY - y).toFixed(1)}" fill="${GAYA.arsir}" stroke="${GAYA.hitam}" stroke-width="1.2"/>`;
  });

  svg += sumbuALevelSVG({ xAxisY, yAxisX, xFrom: padL, xTo: padL + plotW + 10, yFrom: xAxisY, yTo: padT - 10, labelX, labelY });
  // Angka skala x tepat di batas kelas — itu yang dibaca siswa.
  bounds.forEach((b) => { svg += tickXSVG(toX(b), xAxisY, formatTick(b)); });
  yTicks.forEach((gy) => { svg += tickYSVG(yAxisX, toY(gy), formatTick(gy)); });
  svg += '</svg>';
  return svg;
}

// Stem-and-leaf. The stem is the value divided by "satuan" (default 10),
// so the same renderer handles 12|3 tens-and-units and 1.2|3 decimals.
function renderStemLeafSVG(cfg) {
  const data = parseNumberList(cfg.data).sort((a, b) => a - b);
  if (!data.length) throw new Error('batangdaun perlu data= berisi angka');
  const unit = Math.abs(numOrDefault(cfg.satuan, 10)) || 10;
  const rows = [];
  data.forEach((v) => {
    const stem = Math.floor(v / unit);
    const leaf = Math.round(Math.abs(v - stem * unit) / (unit / 10));
    let row = rows.find((r) => r.stem === stem);
    if (!row) { row = { stem, leaves: [] }; rows.push(row); }
    row.leaves.push(leaf);
  });
  rows.sort((a, b) => a.stem - b.stem);
  // Empty stems between occupied ones must still be shown, or the display
  // misrepresents the shape of the distribution.
  const filled = [];
  for (let st = rows[0].stem; st <= rows[rows.length - 1].stem; st++) {
    const found = rows.find((r) => r.stem === st);
    filled.push(found || { stem: st, leaves: [] });
  }

  const rowH = 16, padT = 26, padL = 18, stemW = 34;
  const maxLeaves = Math.max.apply(null, filled.map((r) => r.leaves.length));
  const width = Math.max(220, padL + stemW + 14 + maxLeaves * 12 + 20);
  const height = padT + filled.length * rowH + 34;

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" stroke="#d8dce1"/>`;
  svg += `<text x="${(padL + stemW - 6).toFixed(1)}" y="18" text-anchor="end" font-size="10" font-weight="700" fill="#000000">Batang</text>`;
  svg += `<text x="${(padL + stemW + 12).toFixed(1)}" y="18" font-size="10" font-weight="700" fill="#000000">Daun</text>`;
  const lineX = padL + stemW + 4;
  svg += `<line x1="${lineX}" y1="22" x2="${lineX}" y2="${(padT + filled.length * rowH).toFixed(1)}" stroke="#000000" stroke-width="1.2"/>`;
  filled.forEach((r, i) => {
    const y = padT + i * rowH + 11;
    svg += `<text x="${(padL + stemW - 6).toFixed(1)}" y="${y.toFixed(1)}" text-anchor="end" font-size="11" fill="#000000">${r.stem}</text>`;
    r.leaves.forEach((leaf, k) => {
      svg += `<text x="${(lineX + 10 + k * 12).toFixed(1)}" y="${y.toFixed(1)}" font-size="11" fill="#000000">${leaf}</text>`;
    });
  });
  const keyStem = filled[0].stem;
  const keyLeaf = filled[0].leaves.length ? filled[0].leaves[0] : 0;
  svg += `<text x="${padL}" y="${(height - 10).toFixed(1)}" font-size="9.5" fill="#334155">Kunci: ${keyStem} | ${keyLeaf} = ${escText(formatTick(keyStem * unit + keyLeaf * (unit / 10)))}</text>`;
  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------------
// 7b. Gambar impor, figur berpanel, anotasi, dan ruang jawab
// ---------------------------------------------------------------------

// --- Imported pictures -----------------------------------------------
// Uploaded pictures are kept OUTSIDE the naskah (see the image store in
// app.js) and referred to by a short id, because a base64 blob pasted
// inline would drop tens of thousands of unreadable characters right in
// the middle of the questions. diagrams.js has no storage of its own, so
// the lookup is handed in from the app; under Node (tests) no resolver is
// registered and the tag renders a visible placeholder instead.
let imageResolver = null;

function setImageResolver(fn) {
  imageResolver = typeof fn === 'function' ? fn : null;
}

function renderImageHTML(params) {
  const id = String(params.id || '').trim();
  const rec = id && imageResolver ? imageResolver(id) : null;
  if (!rec || !rec.dataUrl) {
    return `<span style="color:#b91c1c;font-size:11px;">[gambar "${escText(id || '?')}" tidak ada di penyimpanan]</span>`;
  }
  // Only ever emit a data: image URL. The store is written by this app's
  // own file picker, but the id comes from the naskah — which is pasted
  // text — so the value it resolves to is checked before it becomes a src.
  // A base64 data URL contains no quotes; anything that does was not
  // produced by this app's own encoder and has no business in a src.
  if (!/^data:image\//.test(rec.dataUrl) || /["'<>]/.test(rec.dataUrl)) {
    return `<span style="color:#b91c1c;font-size:11px;">[gambar "${escText(id)}" bukan berkas gambar yang sah]</span>`;
  }
  // escText covers &, < and > — enough for text nodes, but an attribute
  // value also has to survive a quote in the author's own alt text, which
  // would otherwise close the attribute and let the rest of the naskah be
  // read as markup.
  const alt = escText(params.alt || rec.name || 'Gambar soal').replace(/"/g, '&quot;');
  return `<img class="ws-image" src="${rec.dataUrl}" alt="${alt}">`;
}

// --- Annotation overlay ----------------------------------------------
// Works on top of ANY svg diagram. Coordinates are a percentage of the
// figure box (0-100, origin top-left), never the diagram's own data units:
// every renderer has its own internal coordinate system, and a percentage
// is the one frame of reference that means the same thing on all of them.
// With the builder's live preview they're quick to place by eye.
const ANNOTATION_KEYS = ['teks', 'panah', 'ukuran'];

function hasAnnotations(params) {
  return ANNOTATION_KEYS.some((k) => params[k]);
}

// "30,20:Sisi miring | 60,50:Sudut siku" -> [{ x, y, text }, ...]
function parseAnnotPoints(raw) {
  return String(raw || '').split('|').map((s) => s.trim()).filter(Boolean).map((chunk) => {
    const idx = chunk.indexOf(':');
    const coords = (idx > -1 ? chunk.slice(0, idx) : chunk).split(',');
    return {
      x: numOrDefault(coords[0], 50),
      y: numOrDefault(coords[1], 50),
      text: idx > -1 ? chunk.slice(idx + 1).trim() : ''
    };
  });
}

// "10,80>60,80:8 cm" -> [{ x1, y1, x2, y2, text }, ...]
function parseAnnotSegments(raw) {
  return String(raw || '').split('|').map((s) => s.trim()).filter(Boolean).map((chunk) => {
    const idx = chunk.indexOf(':');
    const geom = idx > -1 ? chunk.slice(0, idx) : chunk;
    const [from, to] = geom.split('>');
    const a = String(from || '').split(',');
    const b = String(to || '').split(',');
    return {
      x1: numOrDefault(a[0], 0), y1: numOrDefault(a[1], 0),
      x2: numOrDefault(b[0], 100), y2: numOrDefault(b[1], 0),
      text: idx > -1 ? chunk.slice(idx + 1).trim() : ''
    };
  });
}

// Arrowheads are drawn as a plain polygon rather than an SVG <marker>: a
// page carries many diagrams at once, and marker refs need document-unique
// ids that would have to be threaded through every renderer to stay unique.
function arrowHeadPolygon(x1, y1, x2, y2, size) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const back = ang + Math.PI;
  const p1x = x2 + size * Math.cos(back - 0.4), p1y = y2 + size * Math.sin(back - 0.4);
  const p2x = x2 + size * Math.cos(back + 0.4), p2y = y2 + size * Math.sin(back + 0.4);
  return `<polygon points="${x2.toFixed(1)},${y2.toFixed(1)} ${p1x.toFixed(1)},${p1y.toFixed(1)} ${p2x.toFixed(1)},${p2y.toFixed(1)}" fill="#000000"/>`;
}

// A white stroke painted UNDER the glyphs (paint-order) keeps annotation
// text readable where it lands on top of grid lines or a drawn shape.
function annotText(x, y, text, anchor) {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="11" fill="#000000"`
    + ` stroke="#ffffff" stroke-width="3" paint-order="stroke"`
    + ` text-anchor="${anchor || 'middle'}">${escText(text)}</text>`;
}

// Angka pertama dari teks anotasi yang cuma berupa besaran ("26 cm", "9", "7,5 m"),
// atau null untuk teks lain ("sisi miring", "x = ?").
function kunciBesaran(t) {
  const x = String(t == null ? '' : t).trim();
  if (!/^-?\d+(?:[.,]\d+)?\s*[A-Za-zµ²³°%\/]*$/.test(x)) return null;
  return x.match(/-?\d+(?:[.,]\d+)?/)[0].replace(',', '.');
}

function applyAnnotations(svg, params, buangGanda) {
  const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!vb) return svg;
  const W = parseFloat(vb[1]), H = parseFloat(vb[2]);
  const toX = (pct) => (pct / 100) * W;
  const toY = (pct) => (pct / 100) * H;
  let extra = '';

  // Preset bangun sudah mencetak semua sisi yang diberi angka. Anotasi bebas
  // yang hanya mengulang angka itu (penulis soal lupa) cuma jadi angka nyasar
  // di tempat tebakan, jadi dibuang.
  const sudahAda = new Set();
  if (buangGanda) {
    (svg.match(/<text[^>]*>[^<]*<\/text>/g) || []).forEach((t) => {
      const k = kunciBesaran(t.replace(/<[^>]*>/g, ''));
      if (k !== null) sudahAda.add(k);
    });
  }
  parseAnnotPoints(params.teks).forEach((a) => {
    if (!a.text) return;
    const k = kunciBesaran(a.text);
    if (k !== null && sudahAda.has(k)) return;
    extra += annotText(toX(a.x), toY(a.y), a.text);
  });

  parseAnnotSegments(params.panah).forEach((a) => {
    const x1 = toX(a.x1), y1 = toY(a.y1), x2 = toX(a.x2), y2 = toY(a.y2);
    extra += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#000000" stroke-width="1.6"/>`;
    extra += arrowHeadPolygon(x1, y1, x2, y2, 8);
    // The label sits at the arrow's TAIL, so it never covers whatever the
    // arrow is pointing at.
    if (a.text) extra += annotText(x1, y1 - 6, a.text);
  });

  parseAnnotSegments(params.ukuran).forEach((a) => {
    const x1 = toX(a.x1), y1 = toY(a.y1), x2 = toX(a.x2), y2 = toY(a.y2);
    const ang = Math.atan2(y2 - y1, x2 - x1);
    // End ticks run perpendicular to the measured line, the way a
    // dimension line is drawn on an engineering/geometry figure.
    const tx = 5 * Math.cos(ang + Math.PI / 2), ty = 5 * Math.sin(ang + Math.PI / 2);
    extra += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#000000" stroke-width="1.2"/>`;
    [[x1, y1], [x2, y2]].forEach(([cx, cy]) => {
      extra += `<line x1="${(cx - tx).toFixed(1)}" y1="${(cy - ty).toFixed(1)}" x2="${(cx + tx).toFixed(1)}" y2="${(cy + ty).toFixed(1)}" stroke="#000000" stroke-width="1.2"/>`;
    });
    if (a.text) extra += annotText((x1 + x2) / 2, (y1 + y2) / 2 - 5, a.text);
  });

  return extra ? svg.replace(/<\/svg>\s*$/, extra + '</svg>') : svg;
}

// --- Figur: numbered, captioned, multi-panel figures -------------------
// "Fig. 2.1 shows..." is how an international paper refers to its own
// artwork, and a single figure routinely holds two or three panels labelled
// (a)/(b)/(c). This wraps any number of ordinary diagram tags into one
// captioned figure, so a question can point at it by number.
let figureCounter = 0;

// Numbering is per printed sheet, not per browser session — renderNow()
// calls this before substituting the tags of each sheet, so Paket B's
// figures are "Gambar 1, 2, 3" again rather than continuing from Paket A.
function resetFigureCounter() {
  figureCounter = 0;
}

const FIGURE_PANEL_LABELS = 'abcdefgh';

function renderFigureHTML(headRaw, panelsRaw, depth) {
  const head = parseTagParams(headRaw);
  const panels = String(panelsRaw || '').split('//').map((s) => s.trim()).filter(Boolean);
  if (!panels.length) {
    return '<span style="color:#b91c1c;font-size:11px;">[figur: tidak ada panel setelah "panel="]</span>';
  }
  figureCounter++;
  const nomor = String(head.nomor != null && String(head.nomor).trim() ? head.nomor : figureCounter).trim();
  const multi = panels.length > 1;
  const body = panels.map((panel, i) => {
    const label = multi ? `<div class="ws-figure-panel-label">(${FIGURE_PANEL_LABELS[i] || i + 1})</div>` : '';
    return `<div class="ws-figure-panel">${renderDiagramTag(panel, depth + 1)}${label}</div>`;
  }).join('');
  const judul = head.judul ? ' — ' + escText(head.judul) : '';
  return `<figure class="ws-figure">`
    + `<div class="ws-figure-panels">${body}</div>`
    + `<figcaption class="ws-figure-caption">Gambar ${escText(nomor)}${judul}</figcaption>`
    + `</figure>`;
}

// --- Ruang jawab: blank graph paper, blank tables, ruled lines ---------
// Everything else in this file draws the ANSWER. These three draw the
// space a student writes the answer INTO — plotting a line of best fit,
// filling in a results table, writing out a derivation — which is where a
// large share of the marks live on an international paper.

// Pre-plotted points for graph paper: "1:3, 2:7, 4:12" (optionally
// "4:12:P" to label one).
function parseXYList(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).map((chunk) => {
    const parts = chunk.split(':').map((x) => x.trim());
    return { x: numOrDefault(parts[0], 0), y: numOrDefault(parts[1], 0), label: parts[2] || '' };
  });
}

function renderGraphPaperSVG(cfg) {
  const xmin = numOrDefault(cfg.xmin, 0), xmax = numOrDefault(cfg.xmax, 10);
  const ymin = numOrDefault(cfg.ymin, 0), ymax = numOrDefault(cfg.ymax, 10);
  const spanX = (xmax - xmin) || 1, spanY = (ymax - ymin) || 1;
  const majorX = Math.abs(numOrDefault(cfg.kotak, niceStep(spanX))) || 1;
  // Tanpa kotak y eksplisit, sumbu y memilih langkah rapinya SENDIRI, tidak
  // meminjam langkah x — grid 0..10 lawan 0..200 dengan langkah 1 di kedua
  // sumbu akan setinggi 200 kotak dan tak terpakai. Meminjam langkah x hanya
  // benar kalau penulis memang minta ukuran kotak tertentu (cfg.kotak).
  const majorY = Math.abs(numOrDefault(cfg.kotaky, cfg.kotak != null ? majorX : niceStep(spanY))) || 1;
  // Kotak kecil per kotak besar — 5 adalah garis 2 mm/1 cm kertas grafik
  // sungguhan, dan itu yang diandaikan soal "baca dari grafik".
  const minorDiv = Math.max(1, Math.min(10, Math.round(numOrDefault(cfg.subkotak, 5))));
  const xTicks = [], yTicks = [];
  for (let gx = Math.ceil(xmin / majorX) * majorX; gx <= xmax + 1e-9; gx += majorX) xTicks.push(Math.round(gx * 1e6) / 1e6);
  for (let gy = Math.ceil(ymin / majorY) * majorY; gy <= ymax + 1e-9; gy += majorY) yTicks.push(Math.round(gy * 1e6) / 1e6);
  const yTickW = Math.max.apply(null, yTicks.map((v) => lebarTeksKira(formatTick(v), GAYA.teksKecil)).concat([0]));
  const labelX = cfg.sumbux ? labelSumbuALevel(cfg.sumbux) : '';
  const labelY = cfg.sumbuy ? labelSumbuALevel(cfg.sumbuy) : '';

  // Bidang gambar dijaga sebanding dengan datanya supaya satu kotak dalam
  // satuan data tetap tampak persegi di kertas.
  const plotW = 328;
  const plotH = Math.max(180, Math.min(420, Math.round(plotW * (spanY / majorY) / (spanX / majorX))));
  const padL = yTickW + 16, padR = 14 + (labelX ? lebarTeksKira(labelX) + 8 : 0);
  const padT = (cfg.judul ? 20 : 0) + 28, padB = 26;
  const width = Math.max(padL + plotW + padR, padL - 8 + lebarTeksKira(labelY) + 6);
  const height = padT + plotH + padB;
  const top = padT;
  const xAxisY = top + plotH, yAxisX = padL;
  const toPx = (x, y) => [padL + ((x - xmin) / spanX) * plotW, top + plotH - ((y - ymin) / spanY) * plotH];

  let svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${width.toFixed(0)} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  if (cfg.judul) {
    svg += `<text x="${(padL + plotW / 2).toFixed(1)}" y="16" text-anchor="middle" font-size="${GAYA.teks}" font-weight="700" fill="${GAYA.hitam}">${escText(cfg.judul)}</text>`;
  }

  // Grid halus dulu, grid utama di atasnya, supaya garis yang lebih tebal
  // menang di tempat keduanya berimpit. Dua tebal abu-abu, tanpa warna.
  const minorStepX = majorX / minorDiv, minorStepY = majorY / minorDiv;
  const startX = Math.ceil(xmin / minorStepX) * minorStepX;
  for (let gx = startX; gx <= xmax + 1e-9; gx += minorStepX) {
    const [px] = toPx(gx, ymin);
    svg += `<line x1="${px.toFixed(1)}" y1="${top}" x2="${px.toFixed(1)}" y2="${xAxisY}" stroke="${GAYA.abuMuda}" stroke-width="0.5"/>`;
  }
  const startY = Math.ceil(ymin / minorStepY) * minorStepY;
  for (let gy = startY; gy <= ymax + 1e-9; gy += minorStepY) {
    const [, py] = toPx(xmin, gy);
    svg += `<line x1="${padL}" y1="${py.toFixed(1)}" x2="${(padL + plotW).toFixed(1)}" y2="${py.toFixed(1)}" stroke="${GAYA.abuMuda}" stroke-width="0.5"/>`;
  }
  xTicks.forEach((gx) => {
    const [px] = toPx(gx, ymin);
    svg += `<line x1="${px.toFixed(1)}" y1="${top}" x2="${px.toFixed(1)}" y2="${xAxisY}" stroke="${GAYA.abu}" stroke-width="0.9"/>`;
  });
  yTicks.forEach((gy) => {
    const [, py] = toPx(xmin, gy);
    svg += `<line x1="${padL}" y1="${py.toFixed(1)}" x2="${(padL + plotW).toFixed(1)}" y2="${py.toFixed(1)}" stroke="${GAYA.abu}" stroke-width="0.9"/>`;
  });

  // Sumbu hitam berpanah di tepi kiri dan bawah — inilah acuan siswa
  // mengukur; label "besaran / satuan" di ujung panah bernilai di naskah
  // praktikum, jadi diberi ruang sendiri.
  svg += sumbuALevelSVG({ xAxisY, yAxisX, xFrom: padL, xTo: padL + plotW + 10, yFrom: xAxisY, yTo: top - 10, labelX, labelY });
  const originShown = xmin === 0 && ymin === 0;
  xTicks.forEach((gx) => { if (!(originShown && Math.abs(gx) < 1e-9)) svg += tickXSVG(toPx(gx, ymin)[0], xAxisY, formatTick(gx)); });
  yTicks.forEach((gy) => { if (!(originShown && Math.abs(gy) < 1e-9)) svg += tickYSVG(yAxisX, toPx(xmin, gy)[1], formatTick(gy)); });
  if (originShown) svg += teksHaloSVG(yAxisX - 5, xAxisY + 13, 'O', { anchor: 'end', italic: true });

  parseXYList(cfg.titik).forEach((p) => {
    const [px, py] = toPx(p.x, p.y);
    // Tanda silang, bukan titik: konvensi plot yang dinilai semua dewan
    // ujian, dan tetap terbaca di atas garis-garis grid.
    svg += `<line x1="${(px - 4).toFixed(1)}" y1="${(py - 4).toFixed(1)}" x2="${(px + 4).toFixed(1)}" y2="${(py + 4).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
    svg += `<line x1="${(px - 4).toFixed(1)}" y1="${(py + 4).toFixed(1)}" x2="${(px + 4).toFixed(1)}" y2="${(py - 4).toFixed(1)}" stroke="${GAYA.hitam}" stroke-width="1.4"/>`;
    if (p.label) svg += annotText(px + 12, py - 6, p.label);
  });

  svg += '</svg>';
  return svg;
}

function renderBlankTableHTML(cfg) {
  const headers = pisahKolom(String(cfg.header || ''));
  const rowCount = Math.max(1, Math.min(30, Math.round(numOrDefault(cfg.baris, 5))));
  const cols = Math.max(1, headers.length || Math.round(numOrDefault(cfg.kolom, 2)));
  const rowH = Math.max(10, Math.min(40, numOrDefault(cfg.tinggi, 20)));
  let html = '';
  if (cfg.judul) html += `<div class="ws-table-title">${escText(cfg.judul)}</div>`;
  html += '<table class="ws-table ws-table-blank">';
  if (headers.length) {
    html += '<thead><tr>' + headers.map((h) => `<th>${escText(h)}</th>`).join('') + '</tr></thead>';
  }
  html += '<tbody>';
  for (let r = 0; r < rowCount; r++) {
    html += `<tr style="height:${rowH}pt">` + new Array(cols).fill('<td></td>').join('') + '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

function renderAnswerLinesHTML(cfg) {
  const count = Math.max(1, Math.min(40, Math.round(numOrDefault(cfg.baris, 4))));
  const gap = Math.max(10, Math.min(40, numOrDefault(cfg.spasi, 18)));
  let html = '<div class="ws-answer-lines">';
  if (cfg.judul) html += `<div class="ws-answer-lines-title">${escText(cfg.judul)}</div>`;
  for (let i = 0; i < count; i++) {
    html += `<div class="ws-answer-line" style="height:${gap}pt"></div>`;
  }
  html += '</div>';
  return html;
}

// ---------------------------------------------------------------------
// 8. Tag syntax: [[type: key=value; key2=value2]]
// ---------------------------------------------------------------------

const DIAGRAM_TYPE_ALIASES = {
  grafik: 'grafik', fungsi: 'grafik',
  programlinear: 'programlinear', linearprogram: 'programlinear',
  bangun: 'bangun', geometri: 'bangun',
  sektor: 'sektor', juring: 'sektor',
  garisbilangan: 'garisbilangan',
  venn: 'venn',
  statistik: 'statistik', stat: 'statistik',
  pohonfaktor: 'pohonfaktor', faktor: 'pohonfaktor',
  pembagian: 'pembagian', pembagianbersusun: 'pembagian', bersusun: 'pembagian',
  tabel: 'tabel', table: 'tabel',
  piktogram: 'piktogram', piktograf: 'piktogram',
  bangunruang: 'bangunruang', ruang: 'bangunruang',
  sudut: 'sudut', angle: 'sudut',
  lewis: 'lewis', strukturlewis: 'lewis',
  hidrokarbon: 'hidrokarbon', rantaikarbon: 'hidrokarbon',
  gaya: 'gaya', dinamika: 'gaya', newton: 'gaya',
  katrol: 'katrol', pulley: 'katrol',
  atwood: 'atwood', katrolganda: 'atwood',
  lift: 'lift', elevator: 'lift',
  balokberurutan: 'balokberurutan', bendaberurutan: 'balokberurutan',
  katroldua: 'katroldua', duabidangmiring: 'katroldua',
  rangkaian: 'rangkaian', rangkaianlistrik: 'rangkaian', circuit: 'rangkaian',
  rantaimakanan: 'rantaimakanan', foodchain: 'rantaimakanan',
  bentukmolekul: 'bentukmolekul', vsepr: 'bentukmolekul', molekul: 'bentukmolekul',
  tingkatenergi: 'tingkatenergi', energilevel: 'tingkatenergi', diagramenergi: 'tingkatenergi',
  sel: 'sel', selhewan: 'sel', seltumbuhan: 'sel',
  bunga: 'bunga',
  daurhidup: 'daurhidup', metamorfosis: 'daurhidup',
  peredarandarah: 'peredarandarah', sirkulasidarah: 'peredarandarah',
  pencernaan: 'pencernaan', sistempencernaan: 'pencernaan',
  gigi: 'gigi', tooth: 'gigi',
  hewan: 'hewan', animal: 'hewan',
  lengkungrahang: 'lengkungrahang', rahang: 'lengkungrahang',
  siklusair: 'siklusair', watercycle: 'siklusair',
  wujudzat: 'wujudzat', statesofmatter: 'wujudzat',
  pesawatsederhana: 'pesawatsederhana', simplemachine: 'pesawatsederhana',
  tatasurya: 'tatasurya', solarsystem: 'tatasurya',
  magnet: 'magnet',
  sketsa: 'sketsa', sketsabebas: 'sketsa', geometribebas: 'sketsa',
  solenoida: 'solenoida', solenoid: 'solenoida', induksi: 'solenoida', kumparan: 'solenoida', induksielektromagnetik: 'solenoida',
  fluida: 'fluida', hidrolik: 'fluida', bejana: 'fluida', bejanaberhubungan: 'fluida', fluidastatis: 'fluida', fluidadinamis: 'fluida',
  alatukur: 'alatukur', jangkasorong: 'alatukur', mikrometer: 'alatukur', micrometer: 'alatukur', vernier: 'alatukur',
  partikel: 'partikel', modelpartikel: 'partikel', diagrammolekul: 'diagrammolekul', molekulpartikel: 'diagrammolekul',
  tabelperiodik: 'tabelperiodik', sistemperiodik: 'tabelperiodik', periodictable: 'tabelperiodik',
  transformasi: 'transformasi', transformation: 'transformasi',
  pohonpeluang: 'pohonpeluang', treediagram: 'pohonpeluang', peluang: 'pohonpeluang',
  vektor: 'vektor', vector: 'vektor',
  bearing: 'bearing', arahmataangin: 'bearing',
  sebangun: 'sebangun', similar: 'sebangun',
  ogive: 'ogive', frekuensikumulatif: 'ogive',
  boxplot: 'boxplot', kotakgaris: 'boxplot',
  sinar: 'sinar', raydiagram: 'sinar', lensa: 'sinar',
  gerak: 'gerak', gerakgrafik: 'gerak', kinematika: 'gerak',
  gelombang: 'gelombang', wave: 'gelombang',
  medan: 'medan', medanlistrik: 'medan', medanmagnet: 'medan', fieldline: 'medan',
  kulitelektron: 'kulitelektron', bohr: 'kulitelektron', konfigurasielektron: 'kulitelektron',
  titrasi: 'titrasi', titration: 'titrasi',
  katalis: 'katalis', catalyst: 'katalis',
  kisi: 'kisi', kristal: 'kisi', lattice: 'kisi',
  piramida: 'piramida', piramidaekologi: 'piramida', ecopyramid: 'piramida',
  punnett: 'punnett', kotakpunnett: 'punnett', persilangan: 'punnett',
  kuncideterminasi: 'kuncideterminasi', kuncidikotomi: 'kuncideterminasi', dichotomouskey: 'kuncideterminasi',
  jaringmakanan: 'jaringmakanan', foodweb: 'jaringmakanan', jaringjaringmakanan: 'jaringmakanan',
  lingkaranteorema: 'lingkaranteorema', teoremalingkaran: 'lingkaranteorema', circletheorem: 'lingkaranteorema',
  jaring: 'jaring', jaringjaring: 'jaring', net: 'jaring',
  pandangan: 'pandangan', tampak: 'pandangan', proyeksi: 'pandangan',
  alatlab: 'alatlab', labware: 'alatlab', peralatan: 'alatlab', percobaan: 'alatlab',
  pencar: 'pencar', scatter: 'pencar', diagrampencar: 'pencar',
  histogram: 'histogram', densitasfrekuensi: 'histogram',
  batangdaun: 'batangdaun', stemleaf: 'batangdaun', batangdan_daun: 'batangdaun',
  gambar: 'gambar', foto: 'gambar', image: 'gambar',
  figur: 'figur', figure: 'figur', panel: 'figur',
  kertasgrafik: 'kertasgrafik', graphpaper: 'kertasgrafik', gridkosong: 'kertasgrafik',
  tabelkosong: 'tabelkosong', blanktable: 'tabelkosong',
  garisjawab: 'garisjawab', answerlines: 'garisjawab', barisjawab: 'garisjawab',
};

function parseTagParams(raw) {
  const params = {};
  String(raw || '').split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) params[key] = val;
  });
  return params;
}

function parseTitikList(raw) {
  if (!raw) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [v, label] = pair.split(':').map((x) => (x || '').trim());
    return { value: parseFloat(v) || 0, label: label || '' };
  });
}

function renderDiagramTag(rawTagContent, depth) {
  depth = depth || 0;
  const colonIdx = rawTagContent.indexOf(':');
  const typeRaw = (colonIdx > -1 ? rawTagContent.slice(0, colonIdx) : rawTagContent).trim().toLowerCase();
  const paramsRaw = colonIdx > -1 ? rawTagContent.slice(colonIdx + 1) : '';
  const type = DIAGRAM_TYPE_ALIASES[typeRaw];
  if (!type) return `<span style="color:#b91c1c;font-size:11px;">[diagram tidak dikenali: "${escText(typeRaw)}"]</span>`;

  // "figur" is handled before the generic "key=value;" parse, because its
  // "panel=" value holds whole diagram tags of its own — semicolons and
  // all — which parseTagParams would otherwise chop into nonsense at the
  // first ";". Everything after "panel=" is therefore taken verbatim, which
  // is why panel must be the LAST parameter of a figur tag.
  if (type === 'figur') {
    if (depth > 0) {
      return '<span style="color:#b91c1c;font-size:11px;">[figur tidak boleh ditaruh di dalam figur lain]</span>';
    }
    const m = paramsRaw.match(/(?:^|;)\s*panel\s*=/);
    if (!m) {
      return '<span style="color:#b91c1c;font-size:11px;">[figur: parameter "panel=" wajib ada, dan harus jadi parameter terakhir]</span>';
    }
    const cut = paramsRaw.indexOf(m[0]);
    return renderFigureHTML(paramsRaw.slice(0, cut), paramsRaw.slice(cut + m[0].length), depth);
  }

  const params = parseTagParams(paramsRaw);
  // "lebar" (width, in pt) is accepted on every diagram/table type to make
  // it bigger/smaller on the page; height follows automatically (SVGs keep
  // their own aspect ratio via viewBox; a table just wraps at that width).
  //
  // PATCH EXACTSEARCH (hilang bila wsm/ disinkronkan ulang lewat
  // perbarui-mesin.sh): dua jenis memakai "lebar" sebagai UKURAN BENDA, bukan
  // ukuran tampilan — balok (bangunruang) dan persegipanjang (bangun). Untuk
  // "[[bangunruang: bentuk=balok; panjang=12; lebar=9; tinggi=8]]" lebar 9 itu
  // 9 cm, tapi dibaca sebagai 9pt sehingga gambarnya tercetak 12 piksel: nyaris
  // tak terlihat, dan tidak ada pesan galat apa pun. Untuk kedua jenis itu
  // lebar tampilan harus ditulis "lebargambar".
  const LEBAR_ADALAH_UKURAN = { bangunruang: 1, ruang: 1, bangun: 1 };
  const lebarTampilan = params.lebargambar
    || (LEBAR_ADALAH_UKURAN[type] ? null : params.lebar);
  const widthPt = lebarTampilan ? numOrDefault(lebarTampilan, 260) : null;
  const widthStyle = widthPt ? ` style="max-width:${widthPt}pt"` : '';
  // penuh=ya (tabel periodik selalu): pada lembar dua kolom, item ini dipasang
  // selebar halaman, bukan terjepit di satu kolom.
  const penuh = type === 'tabelperiodik' || /^(ya|true|1)$/i.test(String(params.penuh || ''));

  // HTML-rendered types (tables, imported pictures, ruled answer space) —
  // everything below this block builds an <svg> instead.
  const HTML_RENDERERS = {
    tabel: renderTableHTML,
    tabelkosong: renderBlankTableHTML,
    garisjawab: renderAnswerLinesHTML
  };
  if (HTML_RENDERERS[type]) {
    try {
      return `<div class="ws-table-wrap${penuh ? ' ws-penuh' : ''}"${widthStyle}>${HTML_RENDERERS[type](params)}</div>`;
    } catch (err) {
      return `<span style="color:#b91c1c;font-size:11px;">[diagram error: ${escText(err.message)}]</span>`;
    }
  }

  if (type === 'gambar') {
    try {
      return `<div class="ws-diagram"${widthStyle}>${renderImageHTML(params)}</div>`;
    } catch (err) {
      return `<span style="color:#b91c1c;font-size:11px;">[gambar error: ${escText(err.message)}]</span>`;
    }
  }

  let svg = '';
  try {
    if (type === 'grafik') svg = renderFunctionGraphSVG(params);
    else if (type === 'programlinear') svg = renderLinearProgramSVG(params);
    else if (type === 'bangun') svg = (params.bentuk === 'potong-lingkaran') ? renderCutoutSVG(params) : renderGeometrySVG(params);
    else if (type === 'sektor') svg = renderSectorSVG(params);
    else if (type === 'garisbilangan') { params.titik = parseTitikList(params.titik); svg = renderNumberLineSVG(params); }
    else if (type === 'venn') svg = renderVennSVG(params);
    else if (type === 'statistik') svg = renderStatSVG(params);
    else if (type === 'pohonfaktor') svg = renderFactorTreeSVG(params);
    else if (type === 'pembagian') svg = renderLongDivisionSVG(params);
    else if (type === 'piktogram') svg = renderPictogramSVG(params);
    else if (type === 'bangunruang') svg = renderSolidSVG(params);
    else if (type === 'sudut') svg = renderAngleSVG(params);
    else if (type === 'sketsa') svg = renderSketsaSVG(params);
    else if (type === 'alatukur') svg = renderAlatUkurSVG(params);
    else if (type === 'fluida') svg = renderFluidaSVG(params);
    else if (type === 'solenoida') svg = renderSolenoidaSVG(params);
    else if (type === 'partikel') svg = renderPartikelSVG(params);
    else if (type === 'diagrammolekul') svg = renderDiagramMolekulSVG(params);
    else if (type === 'tabelperiodik') svg = renderPeriodicTableSVG(params);
    else if (type === 'lewis') svg = renderLewisSVG(params);
    else if (type === 'hidrokarbon') svg = renderHydrocarbonSVG(params);
    else if (type === 'gaya') svg = renderForceDiagramSVG(params);
    else if (type === 'katrol') svg = renderInclinePulleySVG(params);
    else if (type === 'atwood') svg = renderAtwoodSVG(params);
    else if (type === 'lift') svg = renderLiftSVG(params);
    else if (type === 'balokberurutan') svg = renderBeratBerurutanSVG(params);
    else if (type === 'katroldua') svg = renderDoubleInclineSVG(params);
    else if (type === 'rangkaian') svg = renderCircuitSVG(params);
    else if (type === 'rantaimakanan') svg = renderFoodChainSVG(params);
    else if (type === 'bentukmolekul') svg = renderMoleculeShapeSVG(params);
    else if (type === 'tingkatenergi') svg = renderEnergyLevelSVG(params);
    else if (type === 'sel') svg = renderCellSVG(params);
    else if (type === 'bunga') svg = renderFlowerSVG(params);
    else if (type === 'daurhidup') svg = renderLifeCycleSVG(params);
    else if (type === 'peredarandarah') svg = renderCirculationSVG(params);
    else if (type === 'pencernaan') svg = renderDigestiveSVG(params);
    else if (type === 'gigi') svg = renderGigiSVG(params);
    else if (type === 'hewan') svg = renderAnimalFaceSVG(params);
    else if (type === 'lengkungrahang') svg = renderLengkungRahangSVG(params);
    else if (type === 'siklusair') svg = renderWaterCycleSVG(params);
    else if (type === 'wujudzat') svg = renderStatesOfMatterSVG(params);
    else if (type === 'pesawatsederhana') svg = renderSimpleMachineSVG(params);
    else if (type === 'tatasurya') svg = renderSolarSystemSVG(params);
    else if (type === 'magnet') svg = renderMagnetSVG(params);
    else if (type === 'transformasi') svg = renderTransformSVG(params);
    else if (type === 'pohonpeluang') svg = renderProbTreeSVG(params);
    else if (type === 'vektor') svg = renderVectorSVG(params);
    else if (type === 'bearing') svg = renderBearingSVG(params);
    else if (type === 'sebangun') svg = renderSebangunSVG(params);
    else if (type === 'ogive') svg = renderOgiveSVG(params);
    else if (type === 'boxplot') svg = renderBoxplotSVG(params);
    else if (type === 'sinar') svg = renderRaySVG(params);
    else if (type === 'gerak') svg = renderKinematicsSVG(params);
    else if (type === 'gelombang') svg = renderWaveSVG(params);
    else if (type === 'medan') svg = renderFieldSVG(params);
    else if (type === 'kulitelektron') svg = renderElectronShellSVG(params);
    else if (type === 'titrasi') svg = renderTitrationSVG(params);
    else if (type === 'katalis') svg = renderCatalystSVG(params);
    else if (type === 'kisi') svg = renderLatticeSVG(params);
    else if (type === 'piramida') svg = renderEcoPyramidSVG(params);
    else if (type === 'kertasgrafik') svg = renderGraphPaperSVG(params);
    else if (type === 'alatlab') svg = renderLabApparatusSVG(params);
    else if (type === 'punnett') svg = renderPunnettSVG(params);
    else if (type === 'kuncideterminasi') svg = renderDichotomousKeySVG(params);
    else if (type === 'jaringmakanan') svg = renderFoodWebSVG(params);
    else if (type === 'lingkaranteorema') svg = renderCircleTheoremSVG(params);
    else if (type === 'jaring') svg = renderNetSVG(params);
    else if (type === 'pandangan') svg = renderViewsSVG(params);
    else if (type === 'pencar') svg = renderScatterSVG(params);
    else if (type === 'histogram') svg = renderHistogramSVG(params);
    else if (type === 'batangdaun') svg = renderStemLeafSVG(params);
    // Labels, arrows and dimension lines the author placed by hand, drawn
    // over whichever diagram was just built (see applyAnnotations).
    if (svg && hasAnnotations(params)) svg = applyAnnotations(svg, params, type === 'bangun');
    svg = rapikanSVG(svg);
  } catch (err) {
    return `<span style="color:#b91c1c;font-size:11px;">[diagram error: ${escText(err.message)}]</span>`;
  }
  if (modeSiswaDiagram && /^(ya|true|1)$/i.test(String(params.jawab || ''))) {
    const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    if (vb) svg = `<svg class="ws-diagram-svg" viewBox="0 0 ${vb[1]} ${vb[2]}" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="${(parseFloat(vb[1]) - 2).toFixed(1)}" height="${(parseFloat(vb[2]) - 2).toFixed(1)}" fill="#ffffff" stroke="${GAYA.hitam}" stroke-width="1.4"/></svg>`;
  }
  // An inline style beats style.css's own max-width rule regardless of
  // specificity, so this is the one place that needs to touch the <svg> tag.
  if (widthPt) {
    svg = svg.replace('class="ws-diagram-svg"', `class="ws-diagram-svg" style="max-width:${widthPt}pt"`);
  } else {
    // Gambar yang belum punya batas sendiri (lewat svgPas) dibatasi sebesar
    // ukuran aslinya, 1 satuan viewBox = 0,9 pt, dan tetap tunduk pada slider
    // "ukuran diagram". Tanpa ini, gambar kecil dan sempit (katrol, tuas)
    // dibesarkan CSS (width:100%) sampai selebar slider: hurufnya raksasa dan
    // tingginya memakan separuh halaman, walau slider sudah di ukuran terkecil.
    const akar = svg.match(/<svg class="ws-diagram-svg"([^>]*)>/);
    const vb = akar && akar[1].indexOf('style=') < 0 && akar[1].match(/viewBox="0 0 ([\d.]+) [\d.]+"/);
    if (vb) svg = svg.replace('class="ws-diagram-svg"', `class="ws-diagram-svg" style="max-width:min(var(--ws-diagram-width, 260pt), ${Math.round(parseFloat(vb[1]) * 0.9)}pt)"`);
  }
  return `<div class="ws-diagram${penuh ? ' ws-penuh' : ''}">${svg}</div>`;
}

const DIAGRAM_TOKEN_OPEN = 'DG';
const DIAGRAM_TOKEN_CLOSE = '';

// Mode lembar siswa: diagram bertanda jawab=ya (jawaban yang diminta digambar murid)
// dirender sebagai kotak kosong seukuran gambarnya; versi guru menampilkannya penuh.
let modeSiswaDiagram = false;
function setModeSiswaDiagram(v) { modeSiswaDiagram = !!v; }

// Diagram jawaban yang tak sengaja ditaruh di soal: tag molekul/partikel/Lewis yang
// didahului kalimat perintah menggambar ("Complete the molecular diagram in the box",
// "Gambarlah ...") otomatis ditandai jawab=ya, sehingga lembar siswa menampilkan
// kotak kosong, bukan jawabannya.
const RE_TAG_JAWABAN = /^(?:diagrammolekul|molekulpartikel|partikel|modelpartikel|lewis|strukturlewis)\s*:/i;
const RE_PERINTAH_GAMBAR = /\b(?:complete|draw|sketch)\b|\b(?:gambar(?:lah|kan)?|lengkapi|lukis(?:lah)?)\b/i;
function tandaiJawaban(inner, konteks) {
  if (!RE_TAG_JAWABAN.test(inner) || /(?:^|;)\s*(?:jawab|kosong)\s*=/i.test(inner)) return inner;
  if (/^(?:partikel|modelpartikel)\s*:/i.test(inner) && !/(?:^|[;:\s])(?:isi|padat|panel)\s*=/i.test(inner)) return inner;   // kotak kosong sudah kosong
  // Kalimat perintah bisa di baris yang sama dengan tag atau di baris tak-kosong
  // tepat sebelumnya (tag ditaruh di baris sendiri).
  const baris = String(konteks).split('\n');
  let barisIni = baris.pop();
  while (!barisIni.trim() && baris.length) barisIni = baris.pop();
  return RE_PERINTAH_GAMBAR.test(barisIni.slice(-320)) ? inner.replace(/\s*;?\s*$/, '') + '; jawab=ya' : inner;
}

// Soal yang menanyakan sistem pertidaksamaan dari gambar program linear: daftar pertidaksamaan di bawah
// grafik adalah jawabannya, jadi disembunyikan (sistem=tidak) kalau kalimat sesudah gambar menanyakannya.
const RE_TANYA_SISTEM = /(?:sistem|model)\s+(?:pertidaksamaan|matematika)\s+(?:linear\s+)?(?:yang\s+)?(?:paling\s+)?tepat|merepresentasikan|mewakili\s+daerah|menyatakan\s+daerah|tentukan\s+(?:sistem\s+)?pertidaksamaan|pertidaksamaan\s+(?:yang\s+)?(?:mewakili|memenuhi|sesuai)|which\s+(?:system|set)\s+of\s+inequalit|represents?\s+the\s+(?:shaded|feasible)/i;
function tandaiSistem(inner, sesudah) {
  if (!/^programlinear\s*:|^linearprogram\s*:/i.test(inner) || /(?:^|;)\s*(?:sistem|legenda)\s*=/i.test(inner)) return inner;
  const sampai = String(sesudah).search(/\n[ \t]*(?:PG|IB|B|I|E|M)\d+\./);
  const area = sampai > -1 ? String(sesudah).slice(0, sampai) : String(sesudah);
  return RE_TANYA_SISTEM.test(area) ? inner.replace(/\s*;?\s*$/, '') + '; sistem=tidak' : inner;
}

function extractDiagramTags(text) {
  const tags = [];
  // Titik yang menempel di belakang tag ("[[gaya: ...]]. Berapakah ...") dibuang: tanpa
  // itu ia tercetak sebagai ". Berapakah" yatim di awal baris sesudah diagram.
  const replaced = String(text || '').replace(/\[\[([\s\S]*?)\]\](?:[ \t]*\.(?=[ \t]|\r?\n|$))?/g, (match, inner, offset, whole) => {
    const idx = tags.length;
    tags.push(tandaiSistem(tandaiJawaban(inner.trim(), whole.slice(Math.max(0, offset - 360), offset)), whole.slice(offset + match.length, offset + match.length + 460)));
    return DIAGRAM_TOKEN_OPEN + idx + DIAGRAM_TOKEN_CLOSE;
  });
  return { text: replaced, tags };
}

function substituteDiagramTokens(html, tags) {
  const re = new RegExp(DIAGRAM_TOKEN_OPEN + '(\\d+)' + DIAGRAM_TOKEN_CLOSE, 'g');
  return html.replace(re, (m, i) => renderDiagramTag(tags[Number(i)] || ''));
}

// Export for Node-based testing (no-op in browser).
if (typeof module !== 'undefined') {
  module.exports = {
    GAYA, rapikanSVG, satuanALevel, labelSatuan, labelSumbuALevel, sumbuSVG, tidakBerskalaSVG, polaSeri,
    compileExpr, renderFunctionGraphSVG, renderGeometrySVG, renderNumberLineSVG,
    renderVennSVG, renderStatSVG, renderFactorTreeSVG, renderTableHTML,
    renderPictogramSVG, renderSolidSVG, renderAngleSVG, renderLewisSVG, renderAlatUkurSVG, renderFluidaSVG, renderSolenoidaSVG, bacaanJangka, bacaanMikrometer,
    renderHydrocarbonSVG, renderForceDiagramSVG, renderFoodChainSVG, renderDiagramTag,
    renderMoleculeShapeSVG, renderCellSVG,
    renderGraphPaperSVG, renderBlankTableHTML, renderAnswerLinesHTML,
    renderScatterSVG, renderHistogramSVG, renderStemLeafSVG, leastSquaresFit,
    componentSVG, parseCircuitComponent, CIRCUIT_KINDS,
    renderLabApparatusSVG, LAB_APPARATUS,
    renderCircleTheoremSVG, renderNetSVG, renderViewsSVG, CIRCLE_THEOREMS, SOLID_NETS, SOLID_VIEWS,
    renderPunnettSVG, renderDichotomousKeySVG, renderFoodWebSVG, splitGenotype, gametesOf, combineGametes, phenotypeOf,
    renderFigureHTML, renderImageHTML, setImageResolver, resetFigureCounter, applyAnnotations,
    extractDiagramTags, substituteDiagramTokens, setModeSiswaDiagram, GEOMETRY_PRESETS, SOLID_PRESETS, LEWIS_PRESETS, VSEPR_PRESETS,
  };
}

// --- ditambahkan scripts/salin-diagrams.mjs (Exact Canvas) ---
export { renderDiagramTag };
