// Run: node --experimental-strip-types src/lib/joincode.test.ts
// Vectors come from Go: AM_PRINT_VECTORS=1 go test -run TestPrintVectors -v ./internal/connectcode/
import { findJoinCode, parseJoinCode } from './joincode.ts';

const vectors = `AM1-AE8F-WNDD-NXZJ-YLKL-2DXU-B8HL-VQ6T-HMBT-8MQP-A9RS-JNYV-SD2U-MUNC-G5QD|47.1.2.3:7000|06298432e8066b29e2223bcc23aa9504|false|K7QM2XPA9R
AM1-AFV7-XC2T-CEJP-YAXM-V2R8-CJ5R-F5MG-K4F3-7M94-KPUH-3CUU-7HFB-RB2S-ZQEU-4Y8H-4QNW|[2001:db8::1]:8443|06298432e8066b29e2223bcc23aa9504|false|
AM1-AH5E-8TBS-9TWP-Z8T9-JEAZ-UESH-Y95S-8MF2-XN7Q-Y68N|chat.example.com:443||false|
AM1-AHC5-XLGL-W2U3-GSVR-X7V6-X2HH-QMYY-4TS|127.0.0.1:8443||true|ABCDEFGH23`;

const hex = (b?: Uint8Array) => (b ? Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') : '');
let failed = 0;
for (const line of vectors.split('\n')) {
  const [code, addr, pin, plain, invite] = line.split('|');
  for (const input of [code, code.toLowerCase(), `朋友发来的：${code} 快来`, `https://github.com/OzakiJUN/AM/releases/latest#join=${code}`]) {
    const j = await parseJoinCode(input);
    const ok = j.address === addr && hex(j.pin) === pin && String(j.plain) === plain && (j.invite ?? '') === invite;
    if (!ok) {
      failed++;
      console.error('FAIL', input, j);
    }
  }
}
if (findJoinCode('hello world') !== null) failed++;
try {
  await parseJoinCode('AM1-AE8F-WNDD-NXZJ-YLKL-2DXU-B8HL-VQ6T-HMBT-8MQP-A9RS-JNYV-SD2U-MUNC-G5QE');
  failed++;
  console.error('FAIL: typo accepted');
} catch { /* expected */ }
console.log(failed ? `${failed} failures` : 'joincode: all ok');
if (failed) process.exit(1);

// The encoder must produce exactly the Go codes.
{
  const { encodeJoinCode } = await import('./joincode.ts');
  let bad = 0;
  for (const line of vectors.split('\n')) {
    const [code, addr, pin, plain, invite] = line.split('|');
    const pinBytes = pin ? new Uint8Array(pin.match(/../g)!.map((h) => parseInt(h, 16))) : undefined;
    const got = await encodeJoinCode({ address: addr, pin: pinBytes, plain: plain === 'true', invite: invite || undefined });
    if (got !== code) {
      bad++;
      console.error('ENCODE FAIL', addr, got, code);
    }
  }
  console.log(bad ? `${bad} encode failures` : 'encode: all ok');
  if (bad) process.exit(1);
}
