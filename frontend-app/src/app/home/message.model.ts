export interface Message {
    id: string;
    conversationId: string;
    senderId: string;
    clientMessageId: string;
    sequence: number;
    body: string;
    createdAt: string;
}

export interface MessageHistory {
    messages: Message[];
    nextCursor?: string;
}
