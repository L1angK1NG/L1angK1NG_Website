// 为管理后台生成 ADMIN_PASSWORD_HASH。
// 用法：npm run admin:hash -- "你的新密码"
// 或者：echo "你的新密码" | npm run admin:hash
import { hashPassword } from '../admin/lib/auth.mjs';

const arg = process.argv[2];
let password = arg;

if (!password) {
  // 从 stdin 读取一行，避免密码留在 shell 历史记录中。
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
