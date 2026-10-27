import { validateVerhoeffChecksum, validateLuhnChecksum, validateFaydaStructure, generateVerhoeffCheckDigit } from '../src/lib/fayda-verification';
import { parseBudgetRangeInput } from '../src/lib/telegram';

console.log('--- Testing Verhoeff Checksum & Generation ---');
// Generate a valid Verhoeff 16-digit number
const base15 = '482910472819384';
const checkDigit = generateVerhoeffCheckDigit(base15);
const validVerhoeff16 = base15 + checkDigit.toString();
console.log(`Generated Verhoeff FAN: ${validVerhoeff16}`);
console.log(`Verhoeff check: ${validateVerhoeffChecksum(validVerhoeff16)} (expected true)`);
if (!validateVerhoeffChecksum(validVerhoeff16)) throw new Error('Verhoeff check failed on generated number!');

// Corrupted single-digit test
const corrupted = validVerhoeff16.slice(0, 15) + ((checkDigit + 1) % 10).toString();
console.log(`Corrupted Verhoeff check: ${validateVerhoeffChecksum(corrupted)} (expected false)`);
if (validateVerhoeffChecksum(corrupted)) throw new Error('Corrupted Verhoeff check should have failed!');

console.log('\n--- Testing Anti-Spoofing & Heuristics ---');
// 1. Repeating digits
const repeating = '1111111111111111';
const repRes = validateFaydaStructure(repeating);
console.log(`Repeating check: valid=${repRes.valid}, error=${repRes.error}`);
if (repRes.valid) throw new Error('Repeating digits should be rejected!');

// 2. Sequential digits
const sequential = '1234567890123456';
const seqRes = validateFaydaStructure(sequential);
console.log(`Sequential check: valid=${seqRes.valid}, error=${seqRes.error}`);
if (seqRes.valid) throw new Error('Sequential digits should be rejected!');

// 3. Leading zero
const leadingZero = '0123456789012345';
const lzRes = validateFaydaStructure(leadingZero);
console.log(`Leading zero check: valid=${lzRes.valid}, error=${lzRes.error}`);
if (lzRes.valid) throw new Error('Leading zero should be rejected!');

// 4. Invalid length
const badLen = '12345678';
const lenRes = validateFaydaStructure(badLen);
console.log(`Short length check: valid=${lenRes.valid}, error=${lenRes.error}`);
if (lenRes.valid) throw new Error('Short length should be rejected!');

console.log('\n--- Testing Budget Range Parsing ---');
const testCases = [
  { input: '8000 - 15000', expected: { min: 8000, max: 15000 } },
  { input: '8k - 15k', expected: { min: 8000, max: 15000 } },
  { input: '8000 to 15000', expected: { min: 8000, max: 15000 } },
  { input: '8000-15000', expected: { min: 8000, max: 15000 } },
  { input: '12000', expected: { min: 8400, max: 12000 } },
  { input: '12k', expected: { min: 8400, max: 12000 } },
  { input: '20000 - 8000', expected: { min: 8000, max: 20000 } },
  { input: 'invalid text', expected: null },
  { input: '-500', expected: null },
];

for (const tc of testCases) {
  const result = parseBudgetRangeInput(tc.input);
  console.log(`Input: "${tc.input}" => Result:`, result);
  if (tc.expected === null) {
    if (result !== null) throw new Error(`Expected null for "${tc.input}", got ${JSON.stringify(result)}`);
  } else {
    if (!result || result.min !== tc.expected.min || result.max !== tc.expected.max) {
      throw new Error(`Mismatch for "${tc.input}": expected ${JSON.stringify(tc.expected)}, got ${JSON.stringify(result)}`);
    }
  }
}

console.log('\nALL VERIFICATION TESTS PASSED SUCCESSFULLY! ✅');
