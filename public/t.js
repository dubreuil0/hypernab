// Texts for the plain modules of the app window. The texts live in strings.js (HypernabText); without it (unit tests) the key shows.
export const T = (key, vars) => globalThis.HypernabText?.t(key, vars) ?? key;
export const TN = (key, count, vars) => globalThis.HypernabText?.tn(key, count, vars) ?? key;
export const LOCALE = () => globalThis.HypernabText?.language() ?? undefined;
