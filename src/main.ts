const log = (...a: unknown[]) => console.log('[cadastre-id]', ...a);

let realID: unknown = undefined;

Object.defineProperty(window, 'iD', {
  configurable: true,
  get: () => realID,
  set(v: any) {
    if (v && typeof v.coreContext === 'function') {
      const orig = v.coreContext;
      v.coreContext = function (this: unknown, ...args: unknown[]) {
        const ctx = orig.apply(this, args);
        log('contexte iD capturé');
        return ctx;
      };
    }
    realID = v;
  },
});

log('chargé');
