// Installed workshop packages on this device (docs/design.md §13): the
// files live in IndexedDB (backgrounds and portraits can be several MB, too
// big for localStorage); lib/workshop.ts keeps the small list of what is
// installed in localStorage.
import type { Package } from './workshopPackage';

const DB = 'am-workshop';
const STORE = 'packages';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('这台设备不能保存工坊的东西（浏览器存储被关掉了）'));
  });
}

async function run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = f(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result as T);
      tx.onerror = () => reject(tx.error ?? new Error('保存失败'));
      tx.onabort = () => reject(tx.error ?? new Error('保存失败（空间不够？）'));
    });
  } finally {
    db.close();
  }
}

export const savePackage = (id: string, p: Package) => run<void>('readwrite', (s) => s.put(p, id));
export const loadPackage = (id: string) => run<Package | undefined>('readonly', (s) => s.get(id));
export const deletePackage = (id: string) => run<void>('readwrite', (s) => s.delete(id));
