const { GeminiService } = require('./services/geminiService');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

async function main() {
  const gemini = new GeminiService();
  const repoId = 'asheesh109/kisanai';
  const question = 'What details do we have about file src/lib/i18n.js?';
  
  console.log('Testing askQuestion with question:', question);
  const result = await gemini.askQuestion(repoId, 1, question);
  console.log('Result:', JSON.stringify(result, null, 2));
}

main();
