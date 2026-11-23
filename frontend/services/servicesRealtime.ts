import { collection, doc, onSnapshot } from 'firebase/firestore';
import {
  ErpServiceItem,
  ServiceCategoryItem,
  ServiceSubcategoryItem,
} from '../modules/types';
import {
  auth,
  db,
  handleFirestoreError,
  OperationType,
} from './firebase';
import {
  CATALOG_SEED_DOC_ID,
  CatalogSeedMeta,
  computeContinuousServiceSerials,
  mapFirestoreCategoryDoc,
  mapFirestoreServiceDoc,
  mapFirestoreSubcategoryDoc,
  parseCatalogSeedMeta,
  SERVICE_CATEGORIES_COLLECTION,
  SERVICE_SUBCATEGORIES_COLLECTION,
  SERVICES_COLLECTION,
  SETTINGS_COLLECTION,
} from './servicesFirestore';

export interface ServicesRealtimeCallbacks {
  onCategories: (items: ServiceCategoryItem[]) => void;
  onSubcategories: (items: ServiceSubcategoryItem[]) => void;
  onServices: (items: ErpServiceItem[]) => void;
  onCatalogSeedMeta?: (meta: CatalogSeedMeta | null) => void;
  onError?: (err: unknown) => void;
}

/**
 * Subscribes to live Firestore updates for serviceCategories, serviceSubcategories, services,
 * and catalogSeed tombstone metadata when an authenticated Firebase user is active.
 */
export function subscribeServicesModuleRealtime(
  callbacks: ServicesRealtimeCallbacks
): () => void {
  if (!db || !auth?.currentUser) {
    return () => {};
  }

  const unsubCats = onSnapshot(
    collection(db, SERVICE_CATEGORIES_COLLECTION),
    (snapshot) => {
      const items = snapshot.docs
        .map((d) => mapFirestoreCategoryDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => (a.displayOrder ?? a.id) - (b.displayOrder ?? b.id) || a.id - b.id);
      callbacks.onCategories(items);
    },
    (error) => {
      if (callbacks.onError) {
        callbacks.onError(error);
      } else {
        handleFirestoreError(error, OperationType.LIST, SERVICE_CATEGORIES_COLLECTION);
      }
    }
  );

  const unsubSubs = onSnapshot(
    collection(db, SERVICE_SUBCATEGORIES_COLLECTION),
    (snapshot) => {
      const items = snapshot.docs
        .map((d) => mapFirestoreSubcategoryDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => a.categoryId - b.categoryId || a.displayOrder - b.displayOrder || a.id - b.id);
      callbacks.onSubcategories(items);
    },
    (error) => {
      if (callbacks.onError) {
        callbacks.onError(error);
      } else {
        handleFirestoreError(error, OperationType.LIST, SERVICE_SUBCATEGORIES_COLLECTION);
      }
    }
  );

  const unsubSvcs = onSnapshot(
    collection(db, SERVICES_COLLECTION),
    (snapshot) => {
      const rawItems = snapshot.docs
        .map((d) => mapFirestoreServiceDoc(d.id, d.data() as Record<string, unknown>))
        .filter((s) => !s.deletedAt);
      callbacks.onServices(computeContinuousServiceSerials(rawItems));
    },
    (error) => {
      if (callbacks.onError) {
        callbacks.onError(error);
      } else {
        handleFirestoreError(error, OperationType.LIST, SERVICES_COLLECTION);
      }
    }
  );

  const unsubSeedMeta = callbacks.onCatalogSeedMeta
    ? onSnapshot(
        doc(db, SETTINGS_COLLECTION, CATALOG_SEED_DOC_ID),
        (snapshot) => {
          callbacks.onCatalogSeedMeta?.(snapshot.exists() ? parseCatalogSeedMeta(snapshot.data()) : null);
        },
        (error) => {
          if (callbacks.onError) {
            callbacks.onError(error);
          } else {
            handleFirestoreError(error, OperationType.GET, `${SETTINGS_COLLECTION}/${CATALOG_SEED_DOC_ID}`);
          }
        }
      )
    : () => {};

  return () => {
    unsubCats();
    unsubSubs();
    unsubSvcs();
    unsubSeedMeta();
  };
}
