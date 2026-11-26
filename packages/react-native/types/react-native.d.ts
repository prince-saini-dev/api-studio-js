// Just enough of react-native for type checking inside this repo; apps use their own.
declare module 'react-native' {
  export const Platform: { OS: 'ios' | 'android' | 'web' | string; Version: number | string };
  export type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';
  export const AppState: {
    addEventListener(type: 'change', listener: (state: AppStateStatus) => void): { remove(): void };
  };
}
declare const __DEV__: boolean;
