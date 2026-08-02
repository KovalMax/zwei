export interface Login {
    email: string;
    password: string;
    device_id?: string;
    device_name?: string;
}

export function getDeviceID(): string {
    const key = 'zwei_device_id';
    const stored = window.localStorage.getItem(key);
    if (stored) {
        return stored;
    }
    const deviceID = `browser-${createRandomID()}`;
    window.localStorage.setItem(key, deviceID);
    return deviceID;
}

export function createRandomID(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}
