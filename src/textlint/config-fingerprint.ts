import { types as utilTypes } from 'node:util';
import { runInNewContext } from 'node:vm';
import { contentHashParts } from '../core/text.js';

interface CleanIntrinsics {
  readonly arrayIsArray: ArrayConstructor['isArray'];
  readonly getOwnPropertyDescriptor: (
    value: object,
    key: PropertyKey,
  ) => PropertyDescriptor | undefined;
  readonly getPrototypeOf: (value: object) => object | null;
  readonly numberIsNaN: (value: unknown) => boolean;
  readonly numberIsSafeInteger: (value: unknown) => boolean;
  readonly objectIs: (left: unknown, right: unknown) => boolean;
  readonly ownKeys: (value: object) => PropertyKey[];
  readonly WeakMap: WeakMapConstructor;
}

function isCleanIntrinsics(value: unknown): value is CleanIntrinsics {
  return (
    typeof value === 'object' &&
    value !== null &&
    'arrayIsArray' in value &&
    typeof value.arrayIsArray === 'function' &&
    'getOwnPropertyDescriptor' in value &&
    typeof value.getOwnPropertyDescriptor === 'function' &&
    'getPrototypeOf' in value &&
    typeof value.getPrototypeOf === 'function' &&
    'numberIsNaN' in value &&
    typeof value.numberIsNaN === 'function' &&
    'numberIsSafeInteger' in value &&
    typeof value.numberIsSafeInteger === 'function' &&
    'objectIs' in value &&
    typeof value.objectIs === 'function' &&
    'ownKeys' in value &&
    typeof value.ownKeys === 'function' &&
    'WeakMap' in value &&
    typeof value.WeakMap === 'function'
  );
}

const cleanIntrinsicsValue: unknown = runInNewContext(`({
  arrayIsArray: Array.isArray,
  getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
  getPrototypeOf: Object.getPrototypeOf,
  numberIsNaN: Number.isNaN,
  numberIsSafeInteger: Number.isSafeInteger,
  objectIs: Object.is,
  ownKeys: Reflect.ownKeys,
  WeakMap,
})`);
if (!isCleanIntrinsics(cleanIntrinsicsValue)) {
  throw new Error('Cannot establish clean configuration-fingerprint intrinsics.');
}
const cleanIntrinsics = cleanIntrinsicsValue;
const hostObjectPrototype = cleanIntrinsics.getPrototypeOf({});
const hostArrayPrototype = cleanIntrinsics.getPrototypeOf([]);
if (hostObjectPrototype === null || hostArrayPrototype === null) {
  throw new Error('Cannot establish host configuration prototypes.');
}

interface FingerprintObjectState {
  readonly id: number;
  status: 'visiting' | 'done';
}

interface FingerprintState {
  nextId: number;
  readonly objects: WeakMap<object, FingerprintObjectState>;
}

function appendPart(parts: string[], part: string): void {
  parts[parts.length] = part;
}

/** Append one cache-safe value without expanding repeated references. */
function appendFingerprint(value: unknown, state: FingerprintState, parts: string[]): boolean {
  if (value === null) {
    appendPart(parts, 'null');
    return true;
  }
  if (typeof value === 'string') {
    appendPart(parts, 'string');
    appendPart(parts, value);
    return true;
  }
  if (typeof value === 'boolean') {
    appendPart(parts, 'boolean');
    appendPart(parts, value ? 'true' : 'false');
    return true;
  }
  if (typeof value === 'number') {
    if (cleanIntrinsics.objectIs(value, -0)) appendPart(parts, 'number-negative-zero');
    else if (cleanIntrinsics.numberIsNaN(value)) appendPart(parts, 'number-nan');
    else if (value === Infinity) appendPart(parts, 'number-positive-infinity');
    else if (value === -Infinity) appendPart(parts, 'number-negative-infinity');
    else {
      appendPart(parts, 'number');
      appendPart(parts, `${value}`);
    }
    return true;
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value)) return false;

  const existing = state.objects.get(value);
  if (existing !== undefined) {
    if (existing.status === 'visiting') return false;
    appendPart(parts, 'reference');
    appendPart(parts, `${existing.id}`);
    return true;
  }

  const objectState: FingerprintObjectState = { id: state.nextId, status: 'visiting' };
  state.nextId += 1;
  state.objects.set(value, objectState);

  const isArray = cleanIntrinsics.arrayIsArray(value);
  const prototype = cleanIntrinsics.getPrototypeOf(value);
  if (
    isArray
      ? prototype !== hostArrayPrototype
      : prototype !== hostObjectPrototype && prototype !== null
  ) {
    return false;
  }

  appendPart(parts, isArray ? 'array-start' : 'object-start');
  appendPart(parts, `${objectState.id}`);
  const keys = cleanIntrinsics.ownKeys(value);
  let entries = 0;
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex];
    if (key === undefined) return false;
    if (isArray && key === 'length') continue;
    if (typeof key !== 'string') return false;
    const descriptor = cleanIntrinsics.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor))
      return false;
    if (isArray) {
      const index = +key;
      if (
        !cleanIntrinsics.numberIsSafeInteger(index) ||
        index < 0 ||
        `${index}` !== key ||
        index >= value.length
      ) {
        return false;
      }
    }
    appendPart(parts, 'key');
    appendPart(parts, key);
    if (!appendFingerprint(descriptor.value, state, parts)) return false;
    entries += 1;
  }
  if (isArray && entries !== value.length) return false;

  objectState.status = 'done';
  appendPart(parts, isArray ? 'array-end' : 'object-end');
  appendPart(parts, `${entries}`);
  return true;
}

/** Return no key when equivalence cannot be established without side effects or information loss. */
export function tryConfigFingerprint(value: unknown): string | undefined {
  try {
    const parts: string[] = [];
    const success = appendFingerprint(
      value,
      {
        nextId: 0,
        objects: new cleanIntrinsics.WeakMap<object, FingerprintObjectState>(),
      },
      parts,
    );
    return success ? contentHashParts(parts) : undefined;
  } catch {
    return undefined;
  }
}
