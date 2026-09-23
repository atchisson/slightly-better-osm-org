export interface CachedCommune {
  insee: string;
  millesime: string;
  fetchedAt: number;
  features: unknown[];
}

const DB = 'cadastre-id';
const STORE = 'communes';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'insee' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(db => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  }));
}

export async function readCache(insee: string): Promise<CachedCommune | null> {
  const got = await run<CachedCommune | undefined>('readonly', s => s.get(insee));
  return got ?? null;
}

export async function writeCache(entry: CachedCommune): Promise<void> {
  await run('readwrite', s => s.put(entry));
}
