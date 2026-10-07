import {vi} from 'vitest';

type TimedTest = () => void | Promise<void>;

export function fakeAsync(test: TimedTest): () => Promise<void> {
    return async () => {
        vi.useFakeTimers();
        try {
            await test();
        } finally {
            vi.useRealTimers();
        }
    };
}

export async function tick(milliseconds = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(milliseconds);
}

export async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}
