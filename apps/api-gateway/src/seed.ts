/**
 * Creates a demo user (demo@rag.local / demo-password-123).
 * Run: pnpm seed  or  npm run seed
 */
import 'reflect-metadata';
import * as bcrypt from 'bcryptjs';
import { User } from './modules/users/user.entity';
import { buildSeedDataSource } from './config/typeorm.config';

async function seed() {
  const dataSource = buildSeedDataSource([User]);

  await dataSource.initialize();
  const repo = dataSource.getRepository(User);

  const email = 'demo@rag.local';
  const existing = await repo.findOneBy({ email });
  if (existing) {
    console.log(`demo user already exists: ${email}`);
  } else {
    await repo.save(
      repo.create({
        email,
        name: 'Demo User',
        passwordHash: await bcrypt.hash('demo-password-123', 10),
      }),
    );
    console.log(`created demo user: ${email} / demo-password-123`);
  }

  await dataSource.destroy();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
