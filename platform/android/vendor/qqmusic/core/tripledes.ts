/**
 * Triple DES 实现
 * 移植自 LDDC 项目: https://github.com/chenmozhijin/LDDC
 * 原始代码: LDDC/core/decryptor/tripledes.py
 *
 * 上游 dev 位于 electron/main/apis/qqmusic/core/tripledes.ts，
 * Android vendor 用纯 JS 移植，零 node 依赖。
 */

const ENCRYPT = 1;
const DECRYPT = 0;

// S-boxes
const sbox: number[][] = [
  // sbox1
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11,
    9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5,
    11, 3, 14, 10, 0, 6, 13,
  ],
  // sbox2
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10,
    6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2,
    11, 6, 7, 12, 0, 5, 14, 9,
  ],
  // sbox3
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12,
    11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4,
    15, 14, 3, 11, 5, 2, 12,
  ],
  // sbox4
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1,
    10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 10, 13, 8, 9,
    4, 5, 11, 12, 7, 2, 14,
  ],
  // sbox5
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10,
    3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6,
    15, 0, 9, 10, 4, 5, 3,
  ],
  // sbox6
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14,
    0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10,
    11, 14, 1, 7, 6, 0, 8, 13,
  ],
  // sbox7
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12,
    2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9,
    5, 0, 15, 14, 2, 3, 12,
  ],
  // sbox8
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11,
    0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13,
    15, 12, 9, 0, 3, 5, 6, 11,
  ],
];

const bitnum = (a: Uint8Array, b: number, c: number): number => {
  const byteIndex = Math.floor(b / 32) * 4 + 3 - Math.floor((b % 32) / 8);
  return ((a[byteIndex] >> (7 - (b % 8))) & 1) << c;
};

const bitnumIntr = (a: number, b: number, c: number): number => ((a >> (31 - b)) & 1) << c;

const bitnumIntl = (a: number, b: number, c: number): number =>
  (((a << b) & 0x80000000) >>> c) >>> 0;

const sboxBit = (a: number): number => (a & 32) | ((a & 31) >> 1) | ((a & 1) << 4);

const initialPermutation = (inputData: Uint8Array): [number, number] => {
  const s0 =
    (bitnum(inputData, 57, 31) |
      bitnum(inputData, 49, 30) |
      bitnum(inputData, 41, 29) |
      bitnum(inputData, 33, 28) |
      bitnum(inputData, 25, 27) |
      bitnum(inputData, 17, 26) |
      bitnum(inputData, 9, 25) |
      bitnum(inputData, 1, 24) |
      bitnum(inputData, 59, 23) |
      bitnum(inputData, 51, 22) |
      bitnum(inputData, 43, 21) |
      bitnum(inputData, 35, 20) |
      bitnum(inputData, 27, 19) |
      bitnum(inputData, 19, 18) |
      bitnum(inputData, 11, 17) |
      bitnum(inputData, 3, 16) |
      bitnum(inputData, 61, 15) |
      bitnum(inputData, 53, 14) |
      bitnum(inputData, 45, 13) |
      bitnum(inputData, 37, 12) |
      bitnum(inputData, 29, 11) |
      bitnum(inputData, 21, 10) |
      bitnum(inputData, 13, 9) |
      bitnum(inputData, 5, 8) |
      bitnum(inputData, 63, 7) |
      bitnum(inputData, 55, 6) |
      bitnum(inputData, 47, 5) |
      bitnum(inputData, 39, 4) |
      bitnum(inputData, 31, 3) |
      bitnum(inputData, 23, 2) |
      bitnum(inputData, 15, 1) |
      bitnum(inputData, 7, 0)) >>>
    0;

  const s1 =
    (bitnum(inputData, 56, 31) |
      bitnum(inputData, 48, 30) |
      bitnum(inputData, 40, 29) |
      bitnum(inputData, 32, 28) |
      bitnum(inputData, 24, 27) |
      bitnum(inputData, 16, 26) |
      bitnum(inputData, 8, 25) |
      bitnum(inputData, 0, 24) |
      bitnum(inputData, 58, 23) |
      bitnum(inputData, 50, 22) |
      bitnum(inputData, 42, 21) |
      bitnum(inputData, 34, 20) |
      bitnum(inputData, 26, 19) |
      bitnum(inputData, 18, 18) |
      bitnum(inputData, 10, 17) |
      bitnum(inputData, 2, 16) |
      bitnum(inputData, 60, 15) |
      bitnum(inputData, 52, 14) |
      bitnum(inputData, 44, 13) |
      bitnum(inputData, 36, 12) |
      bitnum(inputData, 28, 11) |
      bitnum(inputData, 20, 10) |
      bitnum(inputData, 12, 9) |
      bitnum(inputData, 4, 8) |
      bitnum(inputData, 62, 7) |
      bitnum(inputData, 54, 6) |
      bitnum(inputData, 46, 5) |
      bitnum(inputData, 38, 4) |
      bitnum(inputData, 30, 3) |
      bitnum(inputData, 22, 2) |
      bitnum(inputData, 14, 1) |
      bitnum(inputData, 6, 0)) >>>
    0;

  return [s0, s1];
};

const inversePermutation = (s0: number, s1: number): Uint8Array => {
  const result = new Uint8Array(8);
  const data = new Uint8Array(8);
  for (let i = 0; i < 32; i++) {
    data[Math.floor(i / 8)] |= bitnumIntr(s0, i, 7 - (i % 8));
    data[4 + Math.floor(i / 8)] |= bitnumIntr(s1, i, 7 - (i % 8));
  }
  result[0] = data[7];
  result[1] = data[6];
  result[2] = data[5];
  result[3] = data[4];
  result[4] = data[3];
  result[5] = data[2];
  result[6] = data[1];
  result[7] = data[0];
  return result;
};

const f = (state: number, key: number[]): number => {
  const stateL = state >>> 0;

  const state0 = bitnumIntl(stateL, 31, 31) >>> 0;
  const state1 = bitnumIntl(stateL, 30, 31) >>> 0;
  const state2 = bitnumIntl(stateL, 29, 31) >>> 0;
  const state3 = bitnumIntl(stateL, 28, 31) >>> 0;
  const state4 = bitnumIntl(stateL, 27, 30) >>> 0;
  const state5 = bitnumIntl(stateL, 26, 30) >>> 0;
  const state6 = bitnumIntl(stateL, 25, 30) >>> 0;
  const state7 = bitnumIntl(stateL, 24, 30) >>> 0;
  const state8 = bitnumIntl(stateL, 23, 29) >>> 0;
  const state9 = bitnumIntl(stateL, 22, 29) >>> 0;
  const state10 = bitnumIntl(stateL, 21, 29) >>> 0;
  const state11 = bitnumIntl(stateL, 20, 29) >>> 0;
  const state12 = bitnumIntl(stateL, 19, 28) >>> 0;
  const state13 = bitnumIntl(stateL, 18, 28) >>> 0;
  const state14 = bitnumIntl(stateL, 17, 28) >>> 0;
  const state15 = bitnumIntl(stateL, 16, 28) >>> 0;
  const state16 = bitnumIntl(stateL, 15, 27) >>> 0;
  const state17 = bitnumIntl(stateL, 14, 27) >>> 0;
  const state18 = bitnumIntl(stateL, 13, 27) >>> 0;
  const state19 = bitnumIntl(stateL, 12, 27) >>> 0;
  const state20 = bitnumIntl(stateL, 11, 26) >>> 0;
  const state21 = bitnumIntl(stateL, 10, 26) >>> 0;
  const state22 = bitnumIntl(stateL, 9, 26) >>> 0;
  const state23 = bitnumIntl(stateL, 8, 26) >>> 0;
  const state24 = bitnumIntl(stateL, 7, 25) >>> 0;
  const state25 = bitnumIntl(stateL, 6, 25) >>> 0;
  const state26 = bitnumIntl(stateL, 5, 25) >>> 0;
  const state27 = bitnumIntl(stateL, 4, 25) >>> 0;
  const state28 = bitnumIntl(stateL, 3, 24) >>> 0;
  const state29 = bitnumIntl(stateL, 2, 24) >>> 0;
  const state30 = bitnumIntl(stateL, 1, 24) >>> 0;
  const state31 = bitnumIntl(stateL, 0, 24) >>> 0;

  const sb1 =
    (state31 << 5) | (state30 << 4) | (state29 << 3) | (state28 << 2) | (state27 << 1) | state26;
  const sb2 =
    (state25 << 5) | (state24 << 4) | (state23 << 3) | (state22 << 2) | (state21 << 1) | state20;
  const sb3 =
    (state19 << 5) | (state18 << 4) | (state17 << 3) | (state16 << 2) | (state15 << 1) | state14;
  const sb4 =
    (state13 << 5) | (state12 << 4) | (state11 << 3) | (state10 << 2) | (state9 << 1) | state8;
  const sb5 =
    (state7 << 5) | (state6 << 4) | (state5 << 3) | (state4 << 2) | (state3 << 1) | state2;
  const sb6 = (state1 << 1) | state0;
  const sb7 = (state31 >> 1) | (state30 >> 2) | (state29 >> 3) | (state28 >> 4) | (state27 >> 5);
  const sb8 = (state25 >> 1) | (state24 >> 2) | (state23 >> 3) | (state22 >> 4) | (state21 >> 5);

  return (
    (sbox[0][sboxBit(sb1 << 1)] |
      sbox[1][sboxBit((sb1 >> 5) | (sb2 << 1))] |
      sbox[2][sboxBit((sb2 >> 4) | (sb3 << 2))] |
      sbox[3][sboxBit((sb3 >> 3) | (sb4 << 3))] |
      sbox[4][sboxBit((sb4 >> 2) | (sb5 << 4))] |
      sbox[5][sboxBit((sb5 >> 1) | (sb6 << 5))] |
      sbox[6][sboxBit((sb6 >> 6) | (sb7 << 6))] |
      sbox[7][sboxBit((sb7 >> 6) | (sb8 << 6))]) ^
    ((key[0] << 24) | (key[1] << 16) | (key[2] << 8) | key[3] | (key[4] << 24) | (key[5] << 16))
  );
};

const crypt = (inputData: Uint8Array, key: number[][]): Uint8Array => {
  let [s0, s1] = initialPermutation(inputData);

  for (let idx = 0; idx < 15; idx++) {
    const previousS1 = s1;
    s1 = (f(s1, key[idx]) ^ s0) >>> 0;
    s0 = previousS1;
  }
  s0 = (f(s1, key[15]) ^ s0) >>> 0;

  return inversePermutation(s0, s1);
};

const keySchedule = (key: Uint8Array, mode: number): number[][] => {
  const schedule: number[][] = Array.from({ length: 16 }, () => Array(6).fill(0));
  const keyRndShift = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
  const keyPermC = [
    56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59,
    51, 43, 35,
  ];
  const keyPermD = [
    62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27,
    19, 11, 3,
  ];
  const keyCompression = [
    13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1, 40, 51,
    30, 36, 46, 54, 29, 39, 50, 44, 32, 47, 43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31,
  ];

  let c = 0;
  let d = 0;
  for (let i = 0; i < 28; i++) {
    c |= bitnum(key, keyPermC[i], 31 - i);
    d |= bitnum(key, keyPermD[i], 31 - i);
  }

  for (let i = 0; i < 16; i++) {
    c = (((c << keyRndShift[i]) | (c >>> (28 - keyRndShift[i]))) & 0xfffffff0) >>> 0;
    d = (((d << keyRndShift[i]) | (d >>> (28 - keyRndShift[i]))) & 0xfffffff0) >>> 0;

    const togen = mode === DECRYPT ? 15 - i : i;

    for (let j = 0; j < 6; j++) {
      schedule[togen][j] = 0;
    }

    for (let j = 0; j < 24; j++) {
      schedule[togen][Math.floor(j / 8)] |= bitnumIntr(c, keyCompression[j], 7 - (j % 8));
    }

    for (let j = 24; j < 48; j++) {
      schedule[togen][Math.floor(j / 8)] |= bitnumIntr(d, keyCompression[j] - 27, 7 - (j % 8));
    }
  }

  return schedule;
};

const tripleDesKeySetup = (key: Uint8Array, mode: number): number[][][] => {
  if (mode === ENCRYPT) {
    return [
      keySchedule(key.slice(0), ENCRYPT),
      keySchedule(key.slice(8), DECRYPT),
      keySchedule(key.slice(16), ENCRYPT),
    ];
  }
  return [
    keySchedule(key.slice(16), DECRYPT),
    keySchedule(key.slice(8), ENCRYPT),
    keySchedule(key.slice(0), DECRYPT),
  ];
};

const tripleDesCrypt = (data: Uint8Array, key: number[][][]): Uint8Array => {
  let result = data;
  for (let i = 0; i < 3; i++) {
    result = crypt(result, key[i]);
  }
  return result;
};

/**
 * 解密 QRC 歌词
 * @param encryptedData - 加密的字节数组
 * @param key - 24字节密钥
 * @returns 解密后的字节数组
 */
export const qrcDecrypt = (encryptedData: Uint8Array, key: Uint8Array): Uint8Array => {
  const schedule = tripleDesKeySetup(key, DECRYPT);
  const result: number[] = [];

  // 以 8 字节为单位迭代
  for (let i = 0; i < encryptedData.length; i += 8) {
    const block = encryptedData.slice(i, i + 8);
    const decrypted = tripleDesCrypt(block, schedule);
    result.push(...decrypted);
  }

  return new Uint8Array(result);
};
