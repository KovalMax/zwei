import {Injectable} from '@angular/core';
import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {Observable, catchError, forkJoin, map, throwError} from 'rxjs';
import {Conversation, GroupConversation, GroupRole} from './conversation.model';
import {MessageHistory} from './message.model';
import {UserSearchResult} from './user.model';
import {backends} from '../../environments/environment';
import {ConversationWire, GroupPage, GroupWire, MessageHistoryWire, toConversation, toConversationList, toGroup, toGroupPage, toMessageHistory} from './wire.mapper';

export class InvalidGroupProjectionError extends Error {
    constructor() { super('invalid group projection'); }
}

export class InvalidConversationProjectionError extends Error {
    constructor() { super('invalid conversation projection'); }
}

export class GroupProjectionNotFoundError extends Error {
    constructor() { super('group projection not found'); }
}

export type GroupProjectionFailureReason = 'sessionExpired' | 'unavailable';

export class GroupProjectionFailureError extends Error {
    constructor(public readonly reason: GroupProjectionFailureReason) { super('group projection could not be verified'); }
}

export class InvalidUserSearchResponseError extends Error {
    constructor() { super('invalid user search response'); }
}

@Injectable({providedIn: 'root'})
export class ConversationService {
    constructor(private http: HttpClient) {}

    public listHomeSnapshot(): Observable<{direct: Conversation[]; groups: GroupPage}> {
        return forkJoin({direct: this.listDirect(), groups: this.listGroupPage()});
    }

    public listDirect(): Observable<Conversation[]> {
        return this.http.get<unknown>(`${backends.chat}/api/chat/conversations`).pipe(map(response => {
            const conversations = toConversationList(response);
            if (!conversations) throw new InvalidConversationProjectionError();
            return conversations;
        }));
    }

    public listGroupPage(cursor: string | null = null): Observable<GroupPage> {
        const query = cursor === null ? '?limit=25' : `?limit=25&cursor=${encodeURIComponent(cursor)}`;
        return this.http.get<unknown>(`${backends.chat}/api/chat/groups${query}`).pipe(map(response => {
            const page = toGroupPage(response);
            if (!page) throw new InvalidGroupProjectionError();
            return page;
        }));
    }

    public history(id: string, before?: string): Observable<MessageHistory> {
        const query = before ? `?before=${encodeURIComponent(before)}` : '';
        return this.http.get<MessageHistoryWire>(`${backends.chat}/api/chat/conversations/${id}/messages${query}`).pipe(map(toMessageHistory));
    }

    public searchUsers(query: string): Observable<UserSearchResult[]> {
        return this.http.get<unknown>(`${backends.chat}/api/chat/users/search?q=${encodeURIComponent(query)}`).pipe(map(response => {
            if (!Array.isArray(response) || !response.every(isUserSearchResult)) throw new InvalidUserSearchResponseError();
            return response;
        }));
    }

    public create(otherUserId: string): Observable<Conversation> {
        return this.http.post<ConversationWire>(`${backends.chat}/api/chat/conversations`, {other_user_id: otherUserId}).pipe(map(item => {
            const conversation = toConversation(item);
            if (!conversation) throw new InvalidConversationProjectionError();
            return conversation;
        }));
    }

    public getGroup(id: string): Observable<GroupConversation> {
        return this.mapGroup(this.http.get<GroupWire>(`${backends.chat}/api/chat/groups/${id}`).pipe(catchError((error: unknown) => {
            if (this.isGroupNotFoundResponse(error)) return throwError(() => new GroupProjectionNotFoundError());
            return throwError(() => new GroupProjectionFailureError(error instanceof HttpErrorResponse && error.status === 401 ? 'sessionExpired' : 'unavailable'));
        })));
    }
    public createGroup(name: string, memberIDs: string[]): Observable<GroupConversation> { return this.mapGroup(this.http.post<GroupWire>(`${backends.chat}/api/chat/groups`, {name, member_ids: memberIDs})); }
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
            if (!mapped) throw new InvalidGroupProjectionError();
            return mapped;
        }));
    }

    private isGroupNotFoundResponse(error: unknown): boolean {
        if (!(error instanceof HttpErrorResponse) || error.status !== 404 || typeof error.error !== 'object' || error.error === null) return false;
        return 'error' in error.error && error.error.error === 'group or user not found';
    }
}

function isUserSearchResult(value: unknown): value is UserSearchResult {
    if (!isRecord(value)) return false;
    const result = value;
    return typeof result['id'] === 'string' && result['id'].trim().length > 0 &&
        typeof result['display_name'] === 'string' && typeof result['email'] === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
