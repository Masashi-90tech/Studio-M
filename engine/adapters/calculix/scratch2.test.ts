import { readFileSync } from 'node:fs';
import { parseDat } from './dat';
it('x', () => {
  const b = parseDat(readFileSync('/tmp/studio-m-engine-NE5qYI/elastic.dat', 'utf8'));
  const s = b.find((x) => x.kind === 'stress')!;
  let mx = 0, at = 0;
  for (let k = 0; k < s.ids.length; k++) { const v = Math.abs(s.values[6 * k]); if (v > mx) { mx = v; at = s.ids[k]; } }
  console.log(b.map((x) => x.kind + x.ids.length), mx, at);
});
