// A random id for this installation, so settings can name "the device that
// runs this AI" (docs/design.md §9). Not secret.
const KEY = 'am-device-id';

export function deviceId(): string {
  let id = '';
  try {
    id = localStorage.getItem(KEY) ?? '';
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(KEY, id);
    }
  } catch {
    /* storage blocked: a new id each start */
  }
  return id;
}
