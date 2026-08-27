interface Window {
  __TAURI_INTERNALS__?: {
    invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
    transformCallback: (callback: (...args: unknown[]) => void, once?: boolean) => number;
    unregisterCallback: (id: number) => void;
    convertFileSrc: (path: string, protocol?: string) => string;
  };
}
