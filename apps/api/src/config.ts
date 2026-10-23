export const webOrigins = (process.env.WEB_ORIGINS ?? 'http://localhost:3100,http://127.0.0.1:3100')
  .split(',')
  .map((value) => value.trim());
export const sessionCookie = 'todo_session';
export function jwtSecret(): string {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32)
    throw new Error('JWT_SECRET must contain at least 32 characters');
  return value;
}
