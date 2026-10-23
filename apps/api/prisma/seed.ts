import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/password';

const db = new PrismaClient();
async function main() {
  for (const user of [
    { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.com', name: 'Алиса' },
    { id: '22222222-2222-4222-8222-222222222222', email: 'bob@example.com', name: 'Борис' },
  ]) {
    await db.user.upsert({
      where: { email: user.email },
      update: {},
      create: { ...user, passwordHash: await hashPassword('demo-password') },
    });
  }
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
