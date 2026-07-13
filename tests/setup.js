import "fake-indexeddb/auto";

if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, "crypto", {
    value: {
      getRandomValues(array) {
        for (let index = 0; index < array.length; index += 1) {
          array[index] = Math.floor(Math.random() * 256);
        }
        return array;
      },
      randomUUID() {
        return "10000000-1000-4000-8000-100000000000";
      }
    },
    configurable: true
  });
}
