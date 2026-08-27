/**
 * Runtime config helpers shared across TS services.
 * Minimal — read environment variables with sane defaults.
 */

export const env = (key: string, fallback = ''): string => {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  return value;
};

export const envInt = (key: string, fallback: number): number => {
  const value = env(key, String(fallback));
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

export const envBool = (key: string, fallback: boolean): boolean => {
  const value = env(key, String(fallback)).toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
};
