import {Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable, map} from 'rxjs';
import {Conversation} from './conversation.model';
import {MessageHistory} from './message.model';
import {UserSearchResult} from './user.model';
import {backends} from '../../environments/environment';
import {ConversationWire, MessageHistoryWire, toConversation, toMessageHistory} from './wire.mapper';

@Injectable({providedIn: 'root'})
export class ConversationService {
    constructor(private http: HttpClient) {}

    public list(): Observable<Conversation[]> {
        return this.http.get<ConversationWire[]>(`${backends.chat}/api/chat/conversations`).pipe(map(items => items.map(toConversation)));
    }

    public history(id: string, before?: string): Observable<MessageHistory> {
        const query = before ? `?before=${encodeURIComponent(before)}` : '';
        return this.http.get<MessageHistoryWire>(`${backends.chat}/api/chat/conversations/${id}/messages${query}`).pipe(map(toMessageHistory));
    }

    public searchUsers(query: string): Observable<UserSearchResult[]> {
        return this.http.get<UserSearchResult[]>(`${backends.chat}/api/chat/users/search?q=${encodeURIComponent(query)}`);
    }

    public create(otherUserId: string): Observable<Conversation> {
        return this.http.post<ConversationWire>(`${backends.chat}/api/chat/conversations`, {other_user_id: otherUserId}).pipe(map(toConversation));
    }
}
