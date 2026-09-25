export interface CachedCommune {
  insee: string;
  millesime: string;
  fetchedAt: number;
  features: unknown[];
  /**
   * Piscines de la commune (couche `tsurf`). Optionnelle : une entrée écrite avant
   * leur prise en charge n'en a pas, et doit rester lisible — la faire expirer
   * obligerait à retélécharger des dizaines de mégaoctets pour un ajout mineur.
   */
  piscines?: unknown[];
}

/**
 * Nom de la base IndexedDB — **inchangé malgré le renommage du greffon**.
 *
 * Le renommer orphelinerait tous les caches existants : chaque utilisateur
 * retéléchargerait sa commune, des dizaines de mégaoctets pour Paris ou Marseille,
 * sans rien y gagner. Un nom de base n'est pas une identité publique, c'est une clé
 * de stockage.
 */
const DB = 'cadastre-id';
const STORE = 'communes';

/**
 * Durée de validité d'une commune en cache.
 *
 * `fetchedAt` était écrit et relu par personne : une commune mise en cache aujourd'hui
 * aurait resservi le même millésime dans deux ans, et le tag `source` l'aurait annoncé
 * fidèlement — de la donnée périmée importée en toute bonne foi, ce que la Licence
 * Ouverte et le régime d'import semi-automatique interdisent tous deux en pratique.
 *
 * 30 jours : Etalab republie le PCI plusieurs fois par an, donc c'est court devant le
 * rythme de publication, et long devant une session de contribution — le cache garde
 * tout son intérêt (ne pas retélécharger 20 Mo à chaque ouverture de l'éditeur).
 */
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

/**
 * Rend l'entrée en cache si elle existe ET n'est pas périmée.
 *
 * Une entrée périmée n'est pas supprimée : la clé est l'INSEE, donc le prochain
 * `writeCache` l'écrase de toute façon. Pas de suppression, pas de chemin d'écriture
 * supplémentaire à faire échouer sur une lecture.
 */
export async function readCache(
  insee: string,
  now: number = Date.now(),
): Promise<CachedCommune | null> {
  const got = await run<CachedCommune | undefined>('readonly', s => s.get(insee));
  if (!got) return null;
  const age = now - (got.fetchedAt ?? 0);
  if (!Number.isFinite(age) || age < 0 || age > CACHE_TTL_MS) return null;
  return got;
}

export async function writeCache(entry: CachedCommune): Promise<void> {
  await run('readwrite', s => s.put(entry));
}
