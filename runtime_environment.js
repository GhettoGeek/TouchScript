class RuntimeEnvironment {
  constructor() {
    const wasmMemory = new WebAssembly.Memory({initial: 1});
    const memoryUbytes = new Uint8Array(wasmMemory.buffer);
    this.env = {
      memory: wasmMemory,
      puts(address) {
        const message = Wasm.decodeString(memoryUbytes, address);
        print(message);
      },
      put(char) {
        const message = String.fromCharCode(char);
        print(message);
      },
      putbool(value) {
        const message = String(!!value);
        print(message);
      },
      putnum(num) {
        const message = String(num);
        print(message);
      },
      putu32(u32Num) {
        if (u32Num < 0) {
          u32Num += 1**32;
        }
        const message = String(u32Num);
        print(message);
      }
    }
    this.Math = Math;
  }
}