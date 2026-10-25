import { describe, expect, it } from 'vitest';
import { getPartEntry, matchPart, PART_LIBRARY } from './parts';

const id = (ref: string, value: string, footprint = '') => matchPart({ ref, value, footprint })?.entry.id ?? null;

describe('部品ライブラリの照合', () => {
  it('リニアレギュレーター（型番の違い・大文字小文字）', () => {
    expect(id('U2', 'AMS1117-3.3', 'Package_TO_SOT_SMD:SOT-223-3_TabPin2')).toBe('ldo-power');
    expect(id('U2', 'lm1117-5.0')).toBe('ldo-power');
    expect(id('U2', 'LM7805')).toBe('ldo-power');
    expect(id('U2', 'L7805CV')).toBe('ldo-power');
    expect(id('U2', '7812')).toBe('ldo-power');
    expect(id('U2', 'MC78M05')).toBe('ldo-power');
    expect(id('U2', 'LM317T')).toBe('ldo-power');
    expect(id('U3', 'AP2112K-3.3')).toBe('ldo-small');
    // SOT-223 の U 部品は値が分からなくてもレギュレーターとみなす
    expect(id('U9', 'XYZ', 'Package_TO_SOT_SMD:SOT-223-3_TabPin2')).toBe('ldo-power');
    expect(getPartEntry('ldo-power')!.note).toContain('Vin');
    expect(getPartEntry('ldo-power')!.defaultW).toBe(1);
    expect(getPartEntry('ldo-power')!.maxTempC).toBe(125);
  });

  it('モータードライバー', () => {
    expect(id('U3', 'L298N')).toBe('motor-bipolar');
    expect(id('U3', 'L298', 'Package_TO_SOT_THT:TO-220-15')).toBe('motor-bipolar'); // フットプリントより型番を優先
    expect(id('U4', 'DRV8833PWP')).toBe('motor-mosfet');
    expect(id('U4', 'TB6612FNG')).toBe('motor-mosfet');
    expect(id('U4', 'A4988')).toBe('motor-mosfet');
    expect(getPartEntry('motor-bipolar')!.defaultW).toBe(2);
    expect(getPartEntry('motor-mosfet')!.maxTempC).toBe(150);
  });

  it('マイコン・モジュール', () => {
    expect(id('U1', 'ESP32-S3-WROOM-1-N8')).toBe('esp32');
    expect(id('U1', 'MODULE', 'RF_Module:ESP32-WROOM-32')).toBe('esp32');
    expect(id('U1', 'RP2040')).toBe('rp2040');
    expect(id('U1', 'ATmega328P-AU')).toBe('avr');
    expect(id('U1', 'STM32F103C8T6')).toBe('stm32');
    expect(getPartEntry('esp32')!.maxTempC).toBe(85);
  });

  it('MOSFET', () => {
    expect(id('Q1', 'AO3400A', 'Package_TO_SOT_SMD:SOT-23')).toBe('mosfet-small');
    expect(id('Q2', 'IRLZ44N', 'Package_TO_SOT_THT:TO-220-3_Vertical')).toBe('mosfet-power');
    expect(id('Q3', 'Q_NMOS', 'Package_TO_SOT_SMD:SOT-23')).toBe('mosfet-small');
    expect(getPartEntry('mosfet-power')!.maxTempC).toBe(150);
  });

  it('抵抗・LED・ダイオード', () => {
    expect(id('R1', '10k')).toBe('resistor');
    expect(id('R5', '330', 'Resistor_SMD:R_0603_1608Metric')).toBe('resistor');
    expect(id('RN1', '10k')).toBeNull(); // 抵抗ネットワークは対象外
    expect(id('D1', 'GREEN', 'LED_SMD:LED_0603_1608Metric')).toBe('led');
    expect(id('LED2', '')).toBe('led');
    expect(id('D2', '1N4007')).toBe('diode');
    expect(id('D3', 'SS34', 'Diode_SMD:D_SMA')).toBe('diode');
    expect(id('D4', 'X')).toBe('led'); // D だけでは LED とみなす
    expect(getPartEntry('resistor')!.defaultW).toBe(0.05);
    expect(getPartEntry('resistor')!.maxTempC).toBe(155);
    expect(getPartEntry('led')!.defaultW).toBe(0.06);
    expect(getPartEntry('led')!.maxTempC).toBe(85);
  });

  it('電解コンデンサは 0 W で温度を見張り、セラミックは見張らない', () => {
    const e = matchPart({ ref: 'C1', value: '100uF', footprint: 'Capacitor_THT:CP_Radial_D6.3mm_P2.50mm' })!.entry;
    expect(e.id).toBe('electrolytic');
    expect(e.defaultW).toBe(0);
    expect(e.maxTempC).toBe(85);
    expect(e.watch).toBe(true);
    const c = matchPart({ ref: 'C2', value: '100nF', footprint: 'Capacitor_SMD:C_0603_1608Metric' })!.entry;
    expect(c.id).toBe('capacitor');
    expect(c.watch).toBeFalsy();
    expect(id('C9', '470µF', 'Capacitor_THT:CP_Radial_D8.0mm_P3.50mm')).toBe('electrolytic');
  });

  it('コネクタや取り付け穴は 0 W、知らない部品は null', () => {
    expect(getPartEntry(id('J1', 'Conn_01x04')!)!.defaultW).toBe(0);
    expect(id('H1', 'MountingHole', 'MountingHole:MountingHole_3.2mm_M3')).toBe('mechanical');
    expect(id('HS1', 'Heatsink')).toBeNull(); // H で始まるだけでは取り付け穴にしない
    expect(id('Y1', '16MHz')).toBeNull();
  });

  it('ライブラリの項目は id が重複せず、数値が常識的な範囲', () => {
    const ids = PART_LIBRARY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of PART_LIBRARY) {
      expect(e.label).toMatch(/\S/);
      expect(e.note.length).toBeGreaterThan(5);
      expect(e.matchers.length).toBeGreaterThan(0);
      expect(e.defaultW).toBeGreaterThanOrEqual(0);
      expect(e.defaultW).toBeLessThanOrEqual(5);
      expect(e.maxTempC).toBeGreaterThanOrEqual(60);
      expect(e.maxTempC).toBeLessThanOrEqual(200);
    }
  });
});
