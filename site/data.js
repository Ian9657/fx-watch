export const API = 'https://api.frankfurter.dev/v2';
export const PAIRS = {
  GBP: { quote:'GBP', label:'人民币 → 英镑', unit:'£', name:'英镑' },
  USD: { quote:'USD', label:'人民币 → 美元', unit:'$', name:'美元' }
};
export function parseRows(data, quote) {
  if (!Array.isArray(data) || !data.length) throw new Error('数据为空');
  const rows = data.map(r => {
    if (r.base !== 'CNY' || r.quote !== quote || !Number.isFinite(r.rate) || r.rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || new Date(r.date).toISOString().slice(0,10) !== r.date || r.date > new Date().toISOString().slice(0,10)) throw new Error('数据格式异常');
    return {date:r.date, rate:r.rate};
  });
  return [...new Map(rows.map(r=>[r.date,r])).values()].sort((a,b)=>a.date.localeCompare(b.date));
}
export function isStale(date, now = new Date()) { return (Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()) - Date.parse(date)) / 86400000 > 4; }
export function validTarget(v) { return Number.isFinite(v) && v > 0 && v <= 1000; }
export async function loadRates(days, quote) {
  const from = new Date(); from.setUTCDate(from.getUTCDate() - days);
  const query = `base=CNY&quotes=${quote}${days ? `&from=${from.toISOString().slice(0,10)}` : ''}`;
  const response = await fetch(`${API}/rates?${query}`,{signal:AbortSignal.timeout(18000),cache:'no-store'});
  if (!response.ok) throw new Error(`数据服务返回 ${response.status}`);
  return parseRows(await response.json(), quote);
}
