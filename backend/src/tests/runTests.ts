import { parseSourceFile } from '../../../ingestion-worker/src/parsing/treeSitterParser';

async function testASTParser() {
  console.log('--- Test 1: AST Parser ---');
  const dummyCode = `
    import { validateUser } from './auth';
    import express from 'express';

    class UserController extends BaseController {
      constructor() {
        super();
      }

      async login(req, res) {
        const user = await validateUser(req.body.token);
        return res.json(user);
      }
    }
  `;

  try {
    const result = await parseSourceFile('src/controllers/UserController.ts', dummyCode);
    console.log('Parsed File Path:', result.path);
    console.log('Parsed LOC:', result.loc);
    console.log('Extracted Imports:', JSON.stringify(result.imports, null, 2));
    console.log('Extracted Classes:', JSON.stringify(result.classes, null, 2));
    console.log('Extracted Functions & Calls:', JSON.stringify(result.functions, null, 2));
    
    // Assertions
    const hasExpressImport = result.imports.some(imp => imp.importPath === 'express');
    const hasClass = result.classes.some(cls => cls.name === 'UserController' && cls.superClass === 'BaseController');
    const hasLoginFunc = result.functions.some(f => f.name === 'login' && f.calls.some(c => c.callee === 'validateUser'));

    if (hasExpressImport && hasClass && hasLoginFunc) {
      console.log('✅ AST Parser verification passed!');
    } else {
      console.error('❌ AST Parser verification failed: Expected structures missing.');
    }
  } catch (err: any) {
    console.error('❌ AST Parser threw error:', err.message);
  }
}

function testMetricsNormalization() {
  console.log('\n--- Test 2: Metrics Normalization ---');
  
  // Helper to normalize values
  function normalize(values: number[], val: number): number {
    const max = Math.max(...values);
    const min = Math.min(...values);
    if (max === min) return 1.0;
    return (val - min) / (max - min);
  }

  const testCommits = [10, 5, 2]; // raw commit counts
  const normCommits = testCommits.map(v => normalize(testCommits, v));
  
  console.log('Raw values:', testCommits);
  console.log('Normalized values:', normCommits);

  if (normCommits[0] === 1.0 && normCommits[1] === 0.375 && normCommits[2] === 0) {
    console.log('✅ Normalization formula verified successfully!');
  } else {
    console.error('❌ Normalization failed: Values do not match min-max expectations.');
  }
}

async function runAllTests() {
  console.log('Starting OSS Sahayak Verification Suite...');
  await testASTParser();
  testMetricsNormalization();
  console.log('\nVerification suite run completed.');
}

runAllTests();
