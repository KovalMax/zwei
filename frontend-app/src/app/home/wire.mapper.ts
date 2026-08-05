import {Conversation} from './conversation.model';
import {Message, MessageHistory} from './message.model';

export interface ConversationWire {
    id: string;
    other_user_id: string;
    other_display_name: string;
    other_email: string;
    created_at: string;
    last_message_at?: string;
    unread_count?: number;
}

export interface MessageWire {
    id: string;
    conversation_id: string;
    sender_id: string;
    client_message_id: string;
    sequence: number;
    body: string;
    created_at: string;
}

export interface MessageHistoryWire {
    messages: MessageWire[];
    next_cursor?: string;
}

export function toConversation(item: ConversationWire): Conversation {
    const unreadCount = item.unread_count;
    return {
        id: item.id,
        otherUserId: item.other_user_id,
        otherDisplayName: item.other_display_name,
        otherEmail: item.other_email,
        createdAt: item.created_at,
        lastMessageAt: item.last_message_at || item.created_at,
        unreadCount: typeof unreadCount === 'number' && Number.isSafeInteger(unreadCount) && unreadCount > 0 ? unreadCount : 0,
    };
}

export function toMessage(item: MessageWire): Message | null {
    if (!item.id || !item.conversation_id || !item.sender_id || !item.client_message_id || !Number.isFinite(item.sequence) || item.sequence < 1 || typeof item.body !== 'string' || !item.created_at) return null;
    return {
        id: item.id,
        conversationId: item.conversation_id,
        senderId: item.sender_id,
        clientMessageId: item.client_message_id,
        sequence: item.sequence,
        body: item.body,
        createdAt: item.created_at,
    };
}

export function toMessageHistory(response: MessageHistoryWire): MessageHistory {
    return {
        messages: response.messages.map(toMessage).filter((message): message is Message => message !== null),
        nextCursor: response.next_cursor,
    };
}
