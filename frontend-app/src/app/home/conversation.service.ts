import {Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable, forkJoin, map} from 'rxjs';
import {Conversation, GroupConversation, GroupRole} from './conversation.model';
import {MessageHistory} from './message.model';
import {UserSearchResult} from './user.model';
import {backends} from '../../environments/environment';
import {ConversationWire, GroupWire, MessageHistoryWire, toConversation, toGroup, toMessageHistory} from './wire.mapper';

@Injectable({providedIn: 'root'})
export class ConversationService {
    constructor(private http: HttpClient) {}

    public list(): Observable<Conversation[]> {
        return forkJoin({
            direct: this.http.get<ConversationWire[]>(`${backends.chat}/api/chat/conversations`),
            groups: this.listGroups(),
        }).pipe(map(({direct, groups}) => [...direct.map(toConversation), ...groups].sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt))));
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

    public listGroups(): Observable<GroupConversation[]> { return this.http.get<GroupWire[]>(`${backends.chat}/api/chat/groups`).pipe(map(items => items.map(toGroup).filter((group): group is GroupConversation => group !== null))); }
    public getGroup(id: string): Observable<GroupConversation> { return this.http.get<GroupWire>(`${backends.chat}/api/chat/groups/${id}`).pipe(map(group => { const mapped = toGroup(group); if (!mapped) throw new Error('invalid group projection'); return mapped; })); }
    public createGroup(name: string, memberIDs: string[]): Observable<GroupConversation> { return this.http.post<GroupWire>(`${backends.chat}/api/chat/groups`, {name, member_ids: memberIDs}).pipe(map(group => { const mapped = toGroup(group); if (!mapped) throw new Error('invalid group projection'); return mapped; })); }
    public renameGroup(id: string, name: string): Observable<GroupConversation> { return this.mapGroup(this.http.patch<GroupWire>(`${backends.chat}/api/chat/groups/${id}`, {name})); }
    public addGroupMember(id: string, userID: string): Observable<GroupConversation> { return this.mapGroup(this.http.post<GroupWire>(`${backends.chat}/api/chat/groups/${id}/members`, {user_id: userID})); }
    public removeGroupMember(id: string, userID: string): Observable<GroupConversation> { return this.mapGroup(this.http.delete<GroupWire>(`${backends.chat}/api/chat/groups/${id}/members/${userID}`)); }
    public changeGroupRole(id: string, userID: string, role: GroupRole): Observable<GroupConversation> { return this.mapGroup(this.http.patch<GroupWire>(`${backends.chat}/api/chat/groups/${id}/members/${userID}`, {role})); }
    public transferGroupOwnership(id: string, userID: string): Observable<GroupConversation> { return this.mapGroup(this.http.post<GroupWire>(`${backends.chat}/api/chat/groups/${id}/ownership`, {user_id: userID})); }
    public leaveGroup(id: string): Observable<void> { return this.http.post<void>(`${backends.chat}/api/chat/groups/${id}/leave`, {}); }
    public deleteGroup(id: string): Observable<void> { return this.http.delete<void>(`${backends.chat}/api/chat/groups/${id}`); }

    private mapGroup(source: Observable<GroupWire>): Observable<GroupConversation> {
        return source.pipe(map(group => {
            const mapped = toGroup(group);
            if (!mapped) throw new Error('invalid group projection');
            return mapped;
        }));
    }
}
