const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const [databasePath, backupPath] = process.argv.slice(2);

if (!databasePath || !backupPath) {
  console.error("Usage: node scripts/sqlite-backup.js <database-path> <backup-path>");
  process.exit(1);
}

fs.mkdirSync(path.dirname(backupPath), { recursive: true });

if (fs.existsSync(backupPath)) {
  fs.unlinkSync(backupPath);
}

const database = new DatabaseSync(databasePath);
const quotedBackupPath = `'${backupPath.replaceAll("'", "''")}'`;
database.exec(`VACUUM INTO ${quotedBackupPath}`);
database.close();

console.log(backupPath);
