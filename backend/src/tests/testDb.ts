import neo4j from 'neo4j-driver';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Try loading env from root or current folder
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
dotenv.config();

console.log('Current Cwd:', process.cwd());
console.log('NEO4J_URI:', `"${process.env.NEO4J_URI}"`);
console.log('NEO4J_USERNAME:', `"${process.env.NEO4J_USERNAME}"`);
console.log('NEO4J_PASSWORD:', `"${process.env.NEO4J_PASSWORD ? '********' : 'undefined'}"`);

const uri = (process.env.NEO4J_URI || '').trim();
const username = (process.env.NEO4J_USERNAME || '').trim();
const password = (process.env.NEO4J_PASSWORD || '').trim();

console.log('Trimmed URI:', `"${uri}"`);
console.log('Trimmed Username:', `"${username}"`);

const driver = neo4j.driver(uri, neo4j.auth.basic(username, password));

console.log('Verifying connectivity...');
driver.verifyConnectivity()
  .then(() => {
    console.log('✅ Connection verification succeeded!');
    driver.close().then(() => process.exit(0));
  })
  .catch((err) => {
    console.error('❌ Connection verification failed:', err.message);
    driver.close().then(() => process.exit(1));
  });
