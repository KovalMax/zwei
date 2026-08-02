import {Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable, map} from 'rxjs';
import {Conversation} from './conversation.model';
import {MessageHistory} from './message.model';
import {UserSearchResult} from './user.model';
import {backends} from '../../environments/environment';

@Injectable({providedIn: 'root'})
export class ConversationService {
    constructor(private http: HttpClient) {}

    public list(): Observable<Conversation[]> {
        return this.http.get<Array<{id: string; other_user_id: string; other_display_name: string; other_email: string; created_at: string; last_message_at: string}>>(`${backends.chat}/api/chat/conversations`).pipe(map(items => items.map(item => this.toConversation(item))));
    }

    public history(id: string, before?: string): Observable<MessageHistory> {
        const query = before ? `?before=${encodeURIComponent(before)}` : '';
        return this.http.get<MessageHistoryResponse>(`${backends.chat}/api/chat/conversations/${id}/messages${query}`).pipe(
            map(response => ({
                messages: response.messages.map(message => this.toMessage(message)),
                nextCursor: response.next_cursor,
            })),
        );
    }

    public searchUsers(query: string): Observable<UserSearchResult[]> {
        return this.http.get<UserSearchResult[]>(`${backends.chat}/api/chat/users/search?q=${encodeURIComponent(query)}`);
    }

    public create(otherUserId: string): Observable<Conversation> {
        return this.http.post<{id: string; other_user_id: string; other_display_name: string; other_email: string; created_at: string; last_message_at?: string}>(`${backends.chat}/api/chat/conversations`, {other_user_id: otherUserId}).pipe(map(item => this.toConversation(item)));
    }

    private toConversation(item: {id: string; other_user_id: string; other_display_name: string; other_email: string; created_at: string; last_message_at?: string}): Conversation {
        return {id: item.id, otherUserId: item.other_user_id, otherDisplayName: item.other_display_name, otherEmail: item.other_email, createdAt: item.created_at, lastMessageAt: item.last_message_at || item.created_at};
    }

    private toMessage(item: MessageResponse): MessageHistory['messages'][number] {
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
}

interface MessageHistoryResponse {
    messages: MessageResponse[];
    next_cursor?: string;
}

interface MessageResponse {
    id: string;
    conversation_id: string;
    sender_id: string;
    client_message_id: string;
    sequence: number;
    body: string;
    created_at: string;
}
