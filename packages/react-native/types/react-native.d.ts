// Just enough of react-native for type checking inside this repo; apps use their own.
declare module 'react-native' {
  export const Platform: { OS: 'ios' | 'android' | 'web' | string; Version: number | string };
}
declare const __DEV__: boolean;
