export interface Message {
    id: string;
    conversationId: string;
    senderId: string;
    clientMessageId: string;
    sequence: number;
    body: string;
    contentType?: 'text' | 'sticker';
    mentions?: MessageMention[];
    createdAt: string;
    kind?: 'user' | 'system';
    pending?: boolean;
    uncertain?: boolean;
}

/** Half-open UTF-16 body offsets, matching JavaScript string indexing and textarea selections. */
export interface MessageMention {
    userId: string;
    start: number;
    end: number;
}

export interface MessageTextSegment {
    text: string;
    mentioned: boolean;
}

export function isValidMessageMentions(value: unknown, body: string): value is MessageMention[] {
    if (!Array.isArray(value) || value.length > 16) return false;
    let previousEnd = 0;
    for (const mention of value) {
        if (!mention || typeof mention !== 'object' || Array.isArray(mention)) return false;
        const item = mention as Record<string, unknown>;
        const userID = item['userId'];
        if (typeof userID !== 'string' || !userID.trim() || userID !== userID.trim() ||
            !Number.isSafeInteger(item['start']) || !Number.isSafeInteger(item['end']) || (item['start'] as number) < previousEnd ||
            (item['end'] as number) <= (item['start'] as number) + 1 || (item['end'] as number) > body.length || body[item['start'] as number] !== '@' || splitsSurrogatePair(body, item['start'] as number) || splitsSurrogatePair(body, item['end'] as number)) return false;
        previousEnd = item['end'] as number;
    }
    return true;
}

function splitsSurrogatePair(text: string, offset: number): boolean {
    if (offset <= 0 || offset >= text.length) return false;
    const before = text.charCodeAt(offset - 1);
    const after = text.charCodeAt(offset);
    return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Produces text-only segments; the template may only interpolate these values. */
export function messageTextSegments(body: string, mentions: readonly MessageMention[] | undefined): MessageTextSegment[] {
    if (!mentions || !isValidMessageMentions(mentions, body)) return [{text: body, mentioned: false}];
    const segments: MessageTextSegment[] = [];
    let cursor = 0;
    for (const mention of mentions) {
        if (mention.start > cursor) segments.push({text: body.slice(cursor, mention.start), mentioned: false});
        segments.push({text: body.slice(mention.start, mention.end), mentioned: true});
        cursor = mention.end;
    }
    if (cursor < body.length || segments.length === 0) segments.push({text: body.slice(cursor), mentioned: false});
    return segments;
}

/** Preserve spans for edits outside them and discard a mention when its text is edited. */
export function updateMentionRanges(previousBody: string, nextBody: string, mentions: readonly MessageMention[]): MessageMention[] {
    let prefix = 0;
    while (prefix < previousBody.length && prefix < nextBody.length && previousBody[prefix] === nextBody[prefix]) prefix++;
    let suffix = 0;
    while (suffix < previousBody.length - prefix && suffix < nextBody.length - prefix && previousBody[previousBody.length - suffix - 1] === nextBody[nextBody.length - suffix - 1]) suffix++;
    const oldEnd = previousBody.length - suffix;
    const newEnd = nextBody.length - suffix;
    const delta = newEnd - oldEnd;
    const updated: MessageMention[] = [];
    for (const mention of mentions) {
        if (mention.end <= prefix) updated.push(mention);
        else if (mention.start >= oldEnd) updated.push({...mention, start: mention.start + delta, end: mention.end + delta});
    }
    return updated;
}

export interface MessageHistory {
    messages: Message[];
    nextCursor?: string;
}

export function messageDateLabel(createdAt: string, now = new Date()): string {
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return '';
    if (date.toDateString() === now.toDateString()) return 'Today';
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString([], {month: 'short', day: 'numeric', year: 'numeric'});
}

export function messageDateTimeLabel(createdAt: string): string {
    const date = new Date(createdAt);
    return Number.isNaN(date.getTime()) ? '' : `${date.toLocaleDateString([], {month: 'short', day: 'numeric', year: 'numeric'})} ${date.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}`;
}
