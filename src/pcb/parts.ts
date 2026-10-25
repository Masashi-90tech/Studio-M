// 部品の発熱（W）と上限温度の目安ライブラリ。DOM にも他のモジュールにも依存しない。
//
// ここに書いてある数字は「だいたいこのくらい」という控えめな推測で、実際の発熱は回路の使い方で大きく変わる。
// 取り込みの画面で、利用者が自分の回路に合わせて書き換える前提。データシートで確かめること。
// 照合は大文字小文字を区別しない。上にある項目ほど優先（具体的な型番 → 部品番号の頭文字の順に並べる）。

export interface PartMatcher {
  /** 部品の値（Value 欄。例: AMS1117-3.3）に当てはめる正規表現 */
  value?: RegExp;
  /** フットプリント名（例: Package_TO_SOT_SMD:SOT-223-3_TabPin2）に当てはめる正規表現 */
  footprint?: RegExp;
  /** 部品番号（Reference。例: U1）に当てはめる正規表現 */
  ref?: RegExp;
}

export interface PartLibraryEntry {
  id: string;
  /** 日本語の種類名 */
  label: string;
  /** どれか 1 つに合えば該当（1 つの照合の中は、書いた項目がすべて合うこと） */
  matchers: PartMatcher[];
  /** 既定の発熱 [W]。0 なら熱源として扱わない（watch が true なら温度だけ見る） */
  defaultW: number;
  /** 上限温度の目安 [°C] */
  maxTempC: number;
  /** 発熱量の目安の根拠と、書き換えのヒント */
  note: string;
  /** 発熱が 0 W でも温度を見張る部品（電解コンデンサなど熱に弱いもの） */
  watch?: boolean;
}

const i = (s: string): RegExp => new RegExp(s, 'i');

export const PART_LIBRARY: PartLibraryEntry[] = [
  // ---- 電源 ----
  {
    id: 'ldo-power',
    label: 'リニアレギュレーター（大きめ）',
    matchers: [
      { value: i('1117|LM317|LM337|1086|LM2940|MIC29\\d|LD1085|(^|[^A-Z0-9])(L|LM|MC|UA|KA)?78[LM]?[0-9]{2}([^0-9]|$)|(^|[^A-Z0-9])(L|LM|MC|UA|KA)?79[LM]?[0-9]{2}([^0-9]|$)') },
      { footprint: i('SOT-223'), ref: i('^(U|IC|VR|REG)\\d') },
    ],
    defaultW: 1.0,
    maxTempC: 125,
    note: 'LDO は (Vin − Vout) × I がそのまま熱になります。5V→3.3V・0.6A なら約 1 W。入力電圧が高いほど熱くなります',
  },
  {
    id: 'ldo-small',
    label: 'リニアレギュレーター（小型）',
    matchers: [{ value: i('AP2112|AP7361|AP7333|XC6206|XC6220|MCP1700|MCP1703|HT73\\d\\d|LP298\\d|TLV7\\d\\d|MIC5219|RT9193|SPX3819|TPS7A|TPS73') }],
    defaultW: 0.2,
    maxTempC: 125,
    note: 'LDO は (Vin − Vout) × I が熱になります。小型のものは電流が小さいので 0.2 W 程度。大電流を流すなら増やしてください',
  },
  {
    id: 'buck',
    label: 'スイッチングレギュレーター（降圧）',
    matchers: [{ value: i('LM25\\d\\d|MP1584|MP2307|MP2315|MP1475|AP63\\d\\d|TPS54\\d+|TPS56\\d+|TPS62\\d+|XL4015|XL1509|XL7015|RT8\\d\\d\\d|MT3608|SY8\\d\\d\\d|AOZ1\\d\\d\\d|LMR\\d+|TPS61\\d+') }],
    defaultW: 0.5,
    maxTempC: 125,
    note: '効率 90% なら、出力 5 W で約 0.5 W が熱になります（損失 = 出力 × (1/効率 − 1)）',
  },
  // ---- モータードライバー ----
  {
    id: 'motor-bipolar',
    label: 'モータードライバー（バイポーラ）',
    matchers: [{ value: i('L298|L293|L9110|L297|SN754410|BTS7960|VNH\\d+|BTN8982') }],
    defaultW: 2.0,
    maxTempC: 125,
    note: 'L298 系は飽和電圧が高く、1 A 流すだけで 2 W 前後が熱になります。放熱板（ヒートシンク）を付ける前提の部品です',
  },
  {
    id: 'motor-mosfet',
    label: 'モータードライバー（MOSFET）',
    matchers: [{ value: i('DRV88\\d\\d|DRV83\\d\\d|TB6612|TB66\\d\\d|A4988|A4950|A49\\d\\d|TMC22\\d\\d|TMC21\\d\\d|MX1508|DRV8313|TB67\\w+|AT8833|ZK-?5AD') }],
    defaultW: 0.8,
    maxTempC: 150,
    note: 'I² × RDS(on) 程度の発熱（1 A・0.5 Ω 級で 0.5〜1 W）。ステッピング用 IC は連続電流が大きいと増えます',
  },
  // ---- マイコン・モジュール ----
  {
    id: 'esp32',
    label: 'マイコン（ESP32 系）',
    matchers: [{ value: i('ESP32|ESP-?WROOM|ESP-?WROVER') }, { footprint: i('ESP32|ESP-?WROOM|ESP-?WROVER') }],
    defaultW: 0.8,
    maxTempC: 85,
    note: 'Wi-Fi 送信中は 0.5〜1 W 近く。-40〜85°C 保証のモジュールが多いです（85°C 級）',
  },
  {
    id: 'rp2040',
    label: 'マイコン（RP2040 系）',
    matchers: [{ value: i('RP2040|RP2350|PICO') }, { footprint: i('RP2040|RP2350') }],
    defaultW: 0.3,
    maxTempC: 85,
    note: '動作 100 mA 前後（約 0.3 W）。動作温度は 85°C まで',
  },
  {
    id: 'stm32',
    label: 'マイコン（STM32 系）',
    matchers: [{ value: i('STM32|GD32|NRF52|NRF53|SAMD\\d+|ATSAM') }],
    defaultW: 0.4,
    maxTempC: 105,
    note: '動作 50〜150 mA 前後。品番の末尾で 85°C 級と 105°C 級があります',
  },
  {
    id: 'avr',
    label: 'マイコン（AVR・ATmega 系）',
    matchers: [{ value: i('ATMEGA|ATTINY|AT90|PIC1[0-9]F|PIC18|CH32V|CH55') }],
    defaultW: 0.15,
    maxTempC: 85,
    note: '5V・20 MHz で 0.1〜0.2 W 程度。LED を直接つなぐと増えます',
  },
  {
    id: 'usb-serial',
    label: 'USB-シリアル変換',
    matchers: [{ value: i('CP210\\d|CH340|CH9102|FT232|FT23\\d|PL2303') }],
    defaultW: 0.15,
    maxTempC: 85,
    note: 'USB バスパワー 30 mA 前後の動作で、発熱は小さめです',
  },
  // ---- トランジスタ・ダイオード ----
  {
    id: 'mosfet-power',
    label: 'パワー MOSFET',
    matchers: [
      { value: i('IRLZ?44|IRF\\d{3,4}|IRL\\d{3,4}|FQP\\d+|FQD\\d+|STP\\d+N|AOD\\d+|AOT\\d+|IPP\\d+|IPD\\d+|STD\\d+N|NTD\\d+|BUZ\\d+|RFP\\d+') },
      { footprint: i('TO-220|TO-252|DPAK|TO-263|D2PAK|PowerPAK|LFPAK'), ref: i('^Q\\d') },
    ],
    defaultW: 0.3,
    maxTempC: 150,
    note: 'I² × RDS(on)＋スイッチング損失。10 A・20 mΩ なら約 2 W、1 A なら 0.02 W と電流で大きく変わります',
  },
  {
    id: 'mosfet-small',
    label: '小信号トランジスタ・MOSFET',
    matchers: [
      { value: i('AO34\\d\\d|AO340\\d|SI23\\d\\d|2N7002|BSS\\d+|IRLML\\d+|2N\\d{4}|BC\\d{3}|MMBT\\d+|S8050|S8550|DMN\\d+|DMP\\d+|SS8050') },
      { footprint: i('SOT-23|SOT-323|SC-70|SOT-523'), ref: i('^Q\\d') },
    ],
    defaultW: 0.1,
    maxTempC: 150,
    note: 'スイッチとして使うなら 0.1 W 以下。リニア動作（電流源など）なら Vce × I で増やしてください',
  },
  {
    id: 'diode',
    label: 'ダイオード（整流・保護）',
    matchers: [
      { value: i('^(1N\\d{3,4}|SS\\d+|SB\\d+|MBR\\d+|STPS\\d+|BAT\\d+|BAS\\d+|BAV\\d+|M7|S1[A-Z]|SM\\d+|ES\\d[A-Z]|SMBJ|SMAJ|P6KE|TVS|PESD|1SS\\d+|RB\\d+)') },
      { footprint: i('D_(SOD|SMA|SMB|SMC|DO-)|Diode_') },
    ],
    defaultW: 0.1,
    maxTempC: 125,
    note: '順方向電圧 × 電流（0.5 V × 1 A で 0.5 W）。フライバック用なら普段はほとんど発熱しません',
  },
  {
    id: 'led',
    label: 'LED',
    matchers: [{ value: i('(^|[^A-Z])LED($|[^A-Z])|RED$|GREEN$|BLUE$|YELLOW$|WHITE$|WS2812|SK6812|APA10\\d') }, { footprint: i('LED_|LED$') }, { ref: i('^(LED\\d|D\\d)') }],
    defaultW: 0.06,
    maxTempC: 85,
    note: '20 mA × 2〜3 V で約 0.06 W。ハイパワー LED や WS2812 を多数つけるなら増やしてください',
  },
  // ---- 受動部品 ----
  {
    id: 'electrolytic',
    label: '電解コンデンサ',
    matchers: [{ footprint: i('CP_|C_Elec|CP_Radial|CP_EIA|Capacitor_THT:CP|Panasonic_'), value: i('[0-9.]+\\s*[uµμ]F') }, { footprint: i('CP_Radial|C_Elec') }],
    defaultW: 0,
    maxTempC: 85,
    note: '自分では発熱しませんが熱に弱く、寿命は温度で大きく変わります（85°C 品が多い。105°C 品なら上限を 105 に）。近くの熱源で温度を見張ります',
    watch: true,
  },
  {
    id: 'capacitor',
    label: 'コンデンサ（セラミック等）',
    matchers: [{ ref: i('^C\\d') }],
    defaultW: 0,
    maxTempC: 125,
    note: '発熱はほぼ 0 W として扱います（X7R は 125°C まで）',
  },
  {
    id: 'inductor',
    label: 'インダクタ',
    matchers: [{ ref: i('^L\\d') }, { footprint: i('^Inductor_') }],
    defaultW: 0.1,
    maxTempC: 125,
    note: '電源用のコイルは銅損＋鉄損で 0.1〜0.5 W 程度。DCR × I² で見積もれます',
  },
  {
    id: 'resistor',
    label: '抵抗',
    matchers: [{ ref: i('^R\\d') }, { footprint: i('^Resistor_') }],
    defaultW: 0.05,
    maxTempC: 155,
    note: '信号用なら 0.05 W 以下。電流検出・ブリーダー抵抗は I² × R（または V² ÷ R）で計算して書き換えてください',
  },
  // ---- 発熱しないもの（表示のために登録） ----
  {
    id: 'connector',
    label: 'コネクタ・端子',
    matchers: [{ ref: i('^(J|P|CN|USB|TB|SW|BT|BAT)\\d') }, { footprint: i('^(Connector|TerminalBlock|Button_Switch)') }],
    defaultW: 0,
    maxTempC: 105,
    note: 'ほぼ発熱しません。大電流の端子は接触抵抗（I² × R）に注意',
  },
  {
    id: 'mechanical',
    label: '取り付け穴・マーク',
    matchers: [{ ref: i('^(H|MH|FID|TP|LOGO)\\d+$') }, { footprint: i('^(MountingHole|Fiducial|TestPoint|Symbol)') }],
    defaultW: 0,
    maxTempC: 130,
    note: '熱源ではありません',
  },
];

export interface PartQuery {
  ref: string;
  value: string;
  footprint: string;
}

export interface PartMatch {
  entry: PartLibraryEntry;
  /** どの欄で見つかったか（画面に出す説明用） */
  by: 'value' | 'footprint' | 'ref';
}

function testMatcher(m: PartMatcher, q: PartQuery): 'value' | 'footprint' | 'ref' | null {
  let by: 'value' | 'footprint' | 'ref' | null = null;
  if (m.value) {
    if (!m.value.test(q.value)) return null;
    by = 'value';
  }
  if (m.footprint) {
    if (!m.footprint.test(q.footprint)) return null;
    by ??= 'footprint';
  }
  if (m.ref) {
    if (!m.ref.test(q.ref)) return null;
    by ??= 'ref';
  }
  return by;
}

/** 照合の具体性。型番（値）で合うものを先に、次にフットプリント、最後に部品番号の頭文字だけで合うものを調べる */
function specificity(m: PartMatcher): number {
  return m.value ? 0 : m.footprint ? 1 : 2;
}

/** 部品に合うライブラリの項目を探す（具体的な照合を優先し、同じ具体性なら表の上にあるもの）。無ければ null */
export function matchPart(q: PartQuery, library: PartLibraryEntry[] = PART_LIBRARY): PartMatch | null {
  for (let pass = 0; pass < 3; pass++) {
    for (const entry of library) {
      for (const m of entry.matchers) {
        if (specificity(m) !== pass) continue;
        const by = testMatcher(m, q);
        if (by) return { entry, by };
      }
    }
  }
  return null;
}

export function getPartEntry(id: string): PartLibraryEntry | undefined {
  return PART_LIBRARY.find((e) => e.id === id);
}
