export interface Message {
    id: string;
    conversationId: string;
    senderId: string;
    clientMessageId: string;
    sequence: number;
    body: string;
    createdAt: string;
    pending?: boolean;
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
