import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { connectMongo, disconnectMongo } from '../infra/mongo.js';
import { revokeUserSessions } from '../lib/sessions.js';
import { writeAudit } from '../lib/audit.js';
import { User } from '../models/user.model.js';

// Tool for the person who runs the server:
//   npm run set-password -- someone@example.com
// Gives that user a new random password, prints it in this terminal, and signs the user out
// everywhere. Use it for the first CEO account, or when every administrator is locked out.

const email = String(process.argv[2] ?? '')
  .trim()
  .toLowerCase();
if (!email) {
  process.stderr.write('Usage: npm run set-password -- someone@example.com\n');
  process.exit(1);
}

await connectMongo(env.DATABASE_URI);
try {
  const user = await User.findOne({ email });
  if (!user) {
    process.stderr.write(`No user with the email ${email} in the ${env.DATABASE_KIND} database.\n`);
    process.exitCode = 1;
  } else {
    // 12 random bytes → 16 URL-safe characters.
    const password = randomBytes(12).toString('base64url');
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          password,
          passwordChangedAt: new Date(),
          status: user.status === 'deactivated' ? 'deactivated' : 'active',
        },
      },
    );
    await revokeUserSessions(user._id);
    await writeAudit({
      action: 'user.password_set_by_operator',
      entityType: 'users',
      entityId: user._id,
    });
    process.stdout.write(
      `\nNew password for ${email} (${env.DATABASE_KIND} database):\n\n  ${password}\n\n`,
    );
  }
} finally {
  await disconnectMongo();
}
