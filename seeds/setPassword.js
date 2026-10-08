import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { connectMongo, disconnectMongo } from '../infra/mongo.js';
import { hashPassword } from '../infra/password.js';
import { revokeUserSessions } from '../lib/sessions.js';
import { writeAudit } from '../lib/audit.js';
import { User } from '../models/user.model.js';

// Emergency tool for the person who runs the server:
//   npm run set-password -- someone@example.com
// Gives that user a new temporary password, prints it ONCE in this terminal, signs the user out
// everywhere, and makes them choose their own password at the next sign-in.
// Use it for the first CEO account, or when every administrator is locked out.

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
    // 18 random bytes → 24 URL-safe characters.
    const temporaryPassword = randomBytes(18).toString('base64url');
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          passwordHash: await hashPassword(temporaryPassword),
          mustChangePassword: true,
          passwordChangedAt: new Date(),
          status: user.status === 'deactivated' ? 'deactivated' : 'active',
        },
      },
    );
    await revokeUserSessions(user._id);
    await writeAudit({
      action: 'user.password_reset_by_operator',
      entityType: 'users',
      entityId: user._id,
    });
    process.stdout.write(
      `\nTemporary password for ${email} (${env.DATABASE_KIND} database):\n\n  ${temporaryPassword}\n\n` +
        'It is shown only this once. The user must choose a new password at sign-in.\n',
    );
  }
} finally {
  await disconnectMongo();
}
