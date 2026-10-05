import type { Conversation } from './conversation.model';

interface ParsedInstant {
    epochSeconds: number;
    nanoseconds: number;
}

const RFC3339_NANO_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

function parseRFC3339Nano(value: string): ParsedInstant | undefined {
    const match = RFC3339_NANO_PATTERN.exec(value);
    if (!match) return undefined;

    const [, dateAndTime, fraction = '', offset] = match;
    const epochMilliseconds = Date.parse(`${dateAndTime}${offset}`);
    if (!Number.isFinite(epochMilliseconds)) return undefined;

    return {
        epochSeconds: epochMilliseconds / 1000,
        nanoseconds: Number(fraction.padEnd(9, '0')),
    };
}

function compareInstants(left: string, right: string): number {
    const leftInstant = parseRFC3339Nano(left);
    const rightInstant = parseRFC3339Nano(right);

    if (leftInstant && rightInstant) {
        if (leftInstant.epochSeconds !== rightInstant.epochSeconds)
            return leftInstant.epochSeconds < rightInstant.epochSeconds ? -1 : 1;
        if (leftInstant.nanoseconds !== rightInstant.nanoseconds)
            return leftInstant.nanoseconds < rightInstant.nanoseconds ? -1 : 1;
        return 0;
    }

    if (left === right) return 0;
    return left < right ? -1 : 1;
}

/** Sorts activity newest-first, using a descending ID as a stable tie-break. */
export function compareConversationActivityDescending(left: Conversation, right: Conversation): number {
    return compareInstants(right.lastMessageAt, left.lastMessageAt) ||
        (right.id === left.id ? 0 : right.id < left.id ? -1 : 1);
}
