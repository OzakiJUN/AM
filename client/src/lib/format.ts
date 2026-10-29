const pad = (n: number) => String(n).padStart(2, '0');

/** Time for the conversation list: 14:05 / 昨天 / 星期三 / 10/21. */
export function listTime(ms: number) {
  const d = new Date(ms);
  const now = new Date();
  const days = Math.floor((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days === 1) return '昨天';
  if (days < 7) return '星期' + '日一二三四五六'[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Time shown between messages. */
export function chatTime(ms: number) {
  const d = new Date(ms);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = Math.floor((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return hm;
  if (days === 1) return '昨天 ' + hm;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function fileSize(n: number) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
