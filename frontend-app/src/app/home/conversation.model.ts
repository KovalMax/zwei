export interface Conversation {
    id: string;
    otherUserId: string;
    otherDisplayName: string;
    otherEmail: string;
    createdAt: string;
    lastMessageAt: string;
    unreadCount: number;
}
