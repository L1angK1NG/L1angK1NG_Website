// Generate an ADMIN_PASSWORD_HASH for the admin backend.
// Usage: npm run admin:hash -- "your-new-password"
//    or: echo "your-new-password" | npm run admin:hash
import { hashPassword } from '../admin/lib/auth.mjs';

const arg = process.argv[2];
let password = arg;

if (!password) {
  // Read one line from stdin so the password doesn't land in shell history.
  password = await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

if (!password) {
  console.error('未提供密码。用法: npm run admin:hash -- "新密码"');
  process.exit(1);
}

console.log('将下面这一行写入 .env（覆盖旧的 ADMIN_PASSWORD_HASH）：\n');
console.log('ADMIN_PASSWORD_HASH=' + hashPassword(password));
