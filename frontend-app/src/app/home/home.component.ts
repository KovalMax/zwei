import {ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild} from '@angular/core';
import {BehaviorSubject, Subscription} from 'rxjs';
import {Conversation} from './conversation.model';
import {ConversationService} from './conversation.service';
import {Message} from './message.model';
import {UserSearchResult} from './user.model';
import {DataProviderService, MessageSocketEvent} from './data-provider.service';
import {createRandomID} from '../login/login';
import {AuthService} from '../auth/auth.service';
import {Profile} from '../auth/profile.model';
import {toMessage} from './wire.mapper';
import {CallFacade, CallState} from './call-facade.service';

@Component({
    standalone: false,
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-home',
    templateUrl: './home.component.html',
    styleUrls: ['./home.component.css'],
    providers: [DataProviderService, CallFacade],
})
export class HomeComponent implements OnInit, OnDestroy {
    private readonly selectedConversationKey = 'zwei_selected_conversation';
    public conversations = new BehaviorSubject<Conversation[]>([]);
    public isLoading = true;
    public selectedConversation?: Conversation;
    public messages: Message[] = [];
    public historyCursor?: string;
    public isHistoryLoading = false;
    public draft = '';
    public searchQuery = '';
    public searchResults: UserSearchResult[] = [];
    public socketError = false;
    public socketReady = false;
    public presenceReady = false;
    public sendStatus = '';
    public profile?: Profile;
    public callElapsedSeconds = 0;
    private callMinimized = false;
    private typingTimeout?: number;
    private remoteTypingTimeout?: number;
    private lastTypingStartAt = 0;
    private readonly pendingRequests = new Map<string, {clientMessageID: string; timeout: number}>();
    private historyLoadID = 0;
    private onlineUserIDs = new Set<string>();
    private typingConversationID?: string;
    private pendingIncomingCallConversationID?: string;
    private isTyping = false;
    private callStartedAt?: number;
    private callTimer?: number;
    private callStateSubscription?: Subscription;
    private readonly peerReadSequences = new Map<string, number>();
    private readonly ownReadSequences = new Map<string, number>();
    @ViewChild('messageHistory') private messageHistory?: ElementRef<HTMLElement>;

    constructor(private conversationService: ConversationService, private authService: AuthService, private changeDetector: ChangeDetectorRef, private dataProvider: DataProviderService, public call: CallFacade) {
    }

    public ngOnInit(): void {
        this.authService.profile().subscribe({next: profile => {
            this.profile = profile;
            this.changeDetector.markForCheck();
        }});
        this.conversationService.list().subscribe({
            next: conversations => {
                this.conversations.next(conversations);
                this.restoreSelectedConversation(conversations);
                this.selectPendingIncomingCallConversation();
            },
            error: () => { this.isLoading = false; this.changeDetector.markForCheck(); },
            complete: () => this.isLoading = false,
        });
        this.dataProvider.getObservable().subscribe({
            next: event => this.handleSocketEvent(event),
            error: () => { this.socketError = true; this.changeDetector.markForCheck(); },
        });
        this.dataProvider.readyChanges.subscribe(ready => {
            this.socketReady = ready;
            if (!ready) this.presenceReady = false;
            if (ready && this.markSelectedConversationRead()) this.clearSelectedConversationUnreadCount();
            this.changeDetector.markForCheck();
        });
        this.callStateSubscription = this.call.state$.subscribe(state => this.handleCallState(state));
    }

    public ngOnDestroy(): void {
        for (const pending of this.pendingRequests.values()) window.clearTimeout(pending.timeout);
        window.clearTimeout(this.typingTimeout);
        window.clearTimeout(this.remoteTypingTimeout);
        this.callStateSubscription?.unsubscribe();
        this.stopCallTimer();
        this.call.close();
        this.dataProvider.close();
    }

    public startCall(): void {
        if (this.selectedConversation) void this.call.start(this.selectedConversation.id, this.selectedConversation.otherUserId);
    }

    public minimizeCall(): void {
        if (!this.isOngoingCall()) return;
        this.callMinimized = true;
        if (this.markSelectedConversationRead()) this.clearSelectedConversationUnreadCount();
        this.changeDetector.markForCheck();
    }

    public restoreCall(): void {
        if (!this.isOngoingCall()) return;
        this.callMinimized = false;
        const conversation = this.callConversation();
        if (conversation && this.selectedConversation?.id !== conversation.id) this.selectConversation(conversation);
        this.changeDetector.markForCheck();
    }

    public onCallInputDeviceChange(event: Event): void {
        const deviceID = (event.target as HTMLSelectElement | null)?.value;
        if (deviceID) void this.call.selectInputDevice(deviceID);
    }

    public onCallOutputDeviceChange(event: Event): void {
        const deviceID = (event.target as HTMLSelectElement | null)?.value;
        if (deviceID) void this.call.selectOutputDevice(deviceID);
    }

    public isCallSurfaceVisible(): boolean {
        return this.isOngoingCall() && !this.callMinimized;
    }

    public isCallMinimized(): boolean {
        return this.isOngoingCall() && this.callMinimized;
    }

    public isOngoingCall(): boolean {
        return this.call.state.phase === 'connecting' || this.call.state.phase === 'active';
    }

    public callDurationLabel(): string {
        const totalSeconds = this.callElapsedSeconds;
        const hours = Math.floor(totalSeconds / 3_600);
        const minutes = Math.floor((totalSeconds % 3_600) / 60);
        const seconds = totalSeconds % 60;
        const formatted = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        return hours ? `${hours.toString().padStart(2, '0')}:${formatted}` : formatted;
    }

    private handleCallState(state: CallState): void {
        if (state.phase === 'active') {
            if (!this.callStartedAt) {
                this.callStartedAt = Date.now();
                this.callElapsedSeconds = 0;
                this.startCallTimer();
            }
            this.updateCallElapsed();
            this.changeDetector.markForCheck();
            return;
        }
        if (state.phase !== 'connecting') this.callMinimized = false;
        if (state.phase !== 'connecting') {
            this.callStartedAt = undefined;
            this.callElapsedSeconds = 0;
            this.stopCallTimer();
            if (this.markSelectedConversationRead()) this.clearSelectedConversationUnreadCount();
        }
        this.changeDetector.markForCheck();
    }

    private startCallTimer(): void {
        this.stopCallTimer();
        this.callTimer = window.setInterval(() => {
            this.updateCallElapsed();
            this.changeDetector.markForCheck();
        }, 1_000);
    }

    private stopCallTimer(): void {
        window.clearInterval(this.callTimer);
        this.callTimer = undefined;
    }

    private updateCallElapsed(): void {
        if (this.callStartedAt) this.callElapsedSeconds = Math.max(0, Math.floor((Date.now() - this.callStartedAt) / 1_000));
    }

    public callConversation(): Conversation | undefined {
        const conversationID = this.call.state.conversationID;
        if (conversationID) return this.conversations.getValue().find(item => item.id === conversationID);
        return this.selectedConversation;
    }

    public callDisplayName(): string {
        return this.callConversation()?.otherDisplayName || (this.call.state.phase === 'incoming' ? 'Incoming caller' : 'Audio call');
    }

    public callInitials(): string {
        const conversation = this.callConversation();
        return conversation ? this.initials(conversation) : '??';
    }

    public headerDisplayName(): string {
        return this.callConversation()?.otherDisplayName || 'Choose a conversation';
    }

    public headerInitials(): string {
        return this.callConversation() ? this.callInitials() : 'L';
    }

    public initials(conversation: Conversation): string {
        return (conversation.otherDisplayName || '??').slice(0, 2).toUpperCase();
    }

    public conversationTime(conversation: Conversation): string {
        const createdAt = new Date(conversation.lastMessageAt);
        if (Number.isNaN(createdAt.getTime())) return '';
        const now = new Date();
        if (createdAt.toDateString() === now.toDateString()) {
            return createdAt.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
        }
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        if (createdAt.toDateString() === yesterday.toDateString()) return 'Yesterday';
        return createdAt.toLocaleDateString([], {month: 'short', day: 'numeric'});
    }

    public isOwnMessage(message: Message): boolean {
        return message.senderId === this.profile?.id;
    }

    public isLatestReadMessage(message: Message): boolean {
        const readSequence = this.peerReadSequences.get(message.conversationId) || 0;
        if (message.pending || !this.isOwnMessage(message) || message.sequence > readSequence) return false;
        return !this.messages.some(item => this.isOwnMessage(item) && item.conversationId === message.conversationId && item.sequence > message.sequence && item.sequence <= readSequence);
    }

    public senderName(message: Message): string {
        return this.isOwnMessage(message) ? (this.profile?.display_name || 'You') : (this.selectedConversation?.otherDisplayName || 'Conversation member');
    }

    public peerPresenceLabel(): string {
        if (!this.selectedConversation) return this.socketReady ? 'Live connection' : 'Connecting…';
        if (!this.socketReady) return 'Connection unavailable';
        if (!this.presenceReady) return 'Checking presence…';
        return this.onlineUserIDs.has(this.selectedConversation.otherUserId) ? 'Online' : 'Offline';
    }

    public isSelectedUserOffline(): boolean {
        return !!this.selectedConversation && this.presenceReady && !this.onlineUserIDs.has(this.selectedConversation.otherUserId);
    }

    public isSelectedUserTyping(): boolean {
        return !!this.selectedConversation && this.typingConversationID === this.selectedConversation.id;
    }

    public onDraftChange(): void {
        if (!this.selectedConversation || !this.socketReady) return;
        if (!this.draft.trim()) {
            this.stopTyping();
            return;
        }
        if (!this.isTyping || Date.now() - this.lastTypingStartAt >= 1_200) {
            this.isTyping = this.dataProvider.send({type: 'typing.start', payload: {conversation_id: this.selectedConversation.id}});
            if (this.isTyping) this.lastTypingStartAt = Date.now();
        }
        window.clearTimeout(this.typingTimeout);
        this.typingTimeout = window.setTimeout(() => this.stopTyping(), 2_000);
    }

    public searchUsers(): void {
        const query = this.searchQuery.trim();
        if (query.length < 2) { this.searchResults = []; return; }
        this.conversationService.searchUsers(query).subscribe({next: results => { this.searchResults = results; this.changeDetector.markForCheck(); }});
    }

    public startConversation(user: UserSearchResult): void {
        this.conversationService.create(user.id).subscribe(conversation => {
            const items = this.conversations.getValue();
            this.conversations.next([conversation, ...items.filter(item => item.id !== conversation.id)]);
            this.searchResults = [];
            this.searchQuery = '';
            this.selectConversation(conversation);
            this.dataProvider.send({type: 'presence.refresh'});
        });
    }

    public selectConversation(conversation: Conversation): void {
        const selectedConversation = {...conversation};
        this.selectedConversation = selectedConversation;
        window.localStorage.setItem(this.selectedConversationKey, conversation.id);
        this.conversations.next(this.conversations.getValue().map(item => item.id === conversation.id ? selectedConversation : item));
        this.messages = [];
        this.historyCursor = undefined;
        this.loadHistory();
    }

    public closeConversation(): void {
        this.historyLoadID++;
        this.selectedConversation = undefined;
        this.messages = [];
        this.historyCursor = undefined;
        this.isHistoryLoading = false;
        window.localStorage.removeItem(this.selectedConversationKey);
    }

    public sendMessage(event?: Event): void {
        event?.preventDefault();
        const body = this.draft.trim();
        if (!this.selectedConversation) {
            this.sendStatus = 'Select a conversation before sending.';
            return;
        }
        if (!body) {
            this.sendStatus = 'Write a message before sending.';
            return;
        }
        if (!this.socketReady) {
            this.sendStatus = 'Secure connection is not ready. Wait a moment and try again.';
            return;
        }
        const clientMessageId = createRandomID();
        const requestID = createRandomID();
        this.stopTyping();
        const sent = this.dataProvider.send({
            type: 'message.send',
            request_id: requestID,
            payload: {conversation_id: this.selectedConversation.id, client_message_id: clientMessageId, body},
        });
        if (!sent) {
            this.socketReady = false;
            this.sendStatus = 'Secure connection was lost. Refresh to reconnect.';
            this.changeDetector.markForCheck();
            return;
        }
        this.messages = [...this.messages, {id: `pending:${clientMessageId}`, conversationId: this.selectedConversation.id, senderId: this.profile?.id || '', clientMessageId, sequence: 0, body, createdAt: new Date().toISOString(), pending: true}];
        this.sendStatus = '';
        this.draft = '';
        console.info('Sending chat message', {conversationId: this.selectedConversation.id, clientMessageId});
        const timeout = window.setTimeout(() => this.rejectPendingMessage(requestID, 'No acknowledgement received. Try again.'), 10_000);
        this.pendingRequests.set(requestID, {clientMessageID: clientMessageId, timeout});
        this.changeDetector.markForCheck();
    }

    public handleSocketEvent(event: MessageSocketEvent): void {
        if (event.type === 'call.incoming') {
            this.selectIncomingCallConversation(event.payload.conversation_id);
            this.changeDetector.markForCheck();
            return;
        }
        if (event.type === 'conversation.created') {
            this.refreshConversations();
            this.dataProvider.send({type: 'presence.refresh'});
            return;
        }
        if (event.type === 'conversation.read') {
            if (event.payload.user_id === this.profile?.id) {
                const sequence = this.ownReadSequences.get(event.payload.conversation_id) || 0;
                if (event.payload.sequence > sequence) this.ownReadSequences.set(event.payload.conversation_id, event.payload.sequence);
                this.clearConversationUnreadCount(event.payload.conversation_id);
            } else if (this.conversations.getValue().some(item => item.id === event.payload.conversation_id && item.otherUserId === event.payload.user_id)) {
                const sequence = this.peerReadSequences.get(event.payload.conversation_id) || 0;
                if (event.payload.sequence > sequence) this.peerReadSequences.set(event.payload.conversation_id, event.payload.sequence);
            }
            this.changeDetector.markForCheck();
            return;
        }
        if (event.type === 'presence.snapshot') {
            this.onlineUserIDs = new Set(event.payload.user_ids);
            this.presenceReady = true;
            this.changeDetector.markForCheck();
            return;
        }
        if (event.type === 'presence.changed') {
            if (event.payload.online) this.onlineUserIDs.add(event.payload.user_id);
            else this.onlineUserIDs.delete(event.payload.user_id);
            this.changeDetector.markForCheck();
            return;
        }
        if (event.type === 'typing.started') {
            if (event.payload.conversation_id === this.selectedConversation?.id && event.payload.user_id === this.selectedConversation.otherUserId) {
                this.typingConversationID = event.payload.conversation_id;
                window.clearTimeout(this.remoteTypingTimeout);
                this.remoteTypingTimeout = window.setTimeout(() => {
                    this.typingConversationID = undefined;
                    this.changeDetector.markForCheck();
                }, 5_000);
                this.changeDetector.markForCheck();
            }
            return;
        }
        if (event.type === 'typing.stopped') {
            if (event.payload.conversation_id === this.typingConversationID && event.payload.user_id === this.selectedConversation?.otherUserId) {
                this.typingConversationID = undefined;
                window.clearTimeout(this.remoteTypingTimeout);
                this.changeDetector.markForCheck();
            }
            return;
        }
        if (event.type === 'message.rejected') {
            if (event.request_id) this.rejectPendingMessage(event.request_id, `Message rejected: ${String((event.payload as {error?: string}).error || 'unknown error')}`);
            return;
        }
        if (event.type !== 'message.accepted' && event.type !== 'message.created') return;
        const message = toMessage(event.payload);
        if (event.type === 'message.accepted' && event.request_id) this.resolvePendingMessage(event.request_id);
        if (!message) return;
        if (!this.selectedConversation || message.conversationId !== this.selectedConversation.id) {
            this.updateBackgroundConversationActivity(message.conversationId, message.createdAt, message.sequence, event.type === 'message.created');
            this.changeDetector.markForCheck();
            return;
        }
        const pendingIndex = this.messages.findIndex(item => item.pending && item.clientMessageId === message.clientMessageId);
        if (pendingIndex >= 0) {
            this.messages = this.messages.map((item, index) => index === pendingIndex ? message : item);
        } else if (!this.messages.some(item => item.id === message.id)) {
            this.messages = [...this.messages, message];
        }
        const incomingDuringCall = event.type === 'message.created' && !this.isOwnMessage(message) && this.isCallSurfaceVisible() && this.call.state.conversationID === message.conversationId;
        if (event.type === 'message.created' && !this.isOwnMessage(message) && !incomingDuringCall) this.markSelectedConversationRead();
        this.updateConversationActivity(message.createdAt, incomingDuringCall);
        this.changeDetector.markForCheck();
        this.scrollToLatest();
    }

    private refreshConversations(): void {
        this.conversationService.list().subscribe({
            next: conversations => {
                this.conversations.next(conversations);
                this.selectPendingIncomingCallConversation();
                this.changeDetector.markForCheck();
            },
        });
    }

    private selectIncomingCallConversation(conversationID: string): void {
        this.pendingIncomingCallConversationID = conversationID;
        this.selectPendingIncomingCallConversation();
    }

    private selectPendingIncomingCallConversation(): void {
        const conversationID = this.pendingIncomingCallConversationID;
        if (!conversationID) return;
        const conversation = this.conversations.getValue().find(item => item.id === conversationID);
        if (!conversation) return;
        this.pendingIncomingCallConversationID = undefined;
        if (this.selectedConversation?.id !== conversation.id) this.selectConversation(conversation);
    }

    private stopTyping(): void {
        window.clearTimeout(this.typingTimeout);
        if (!this.isTyping || !this.selectedConversation) return;
        this.dataProvider.send({type: 'typing.stop', payload: {conversation_id: this.selectedConversation.id}});
        this.isTyping = false;
        this.lastTypingStartAt = 0;
    }

    public loadOlderMessages(): void {
        if (this.historyCursor && !this.isHistoryLoading) {
            this.loadHistory(this.historyCursor, true);
        }
    }

    private loadHistory(before?: string, prepend = false): void {
        if (!this.selectedConversation) {
            return;
        }
        const conversationID = this.selectedConversation.id;
        const historyLoadID = ++this.historyLoadID;
        this.isHistoryLoading = true;
        this.conversationService.history(conversationID, before).subscribe({
            next: history => {
                if (!this.isCurrentHistoryLoad(historyLoadID, conversationID)) return;
                const messages = [...history.messages].reverse();
                this.messages = prepend ? [...messages, ...this.messages] : messages;
                this.historyCursor = history.nextCursor;
                if (!prepend && this.markSelectedConversationRead()) this.clearSelectedConversationUnreadCount();
                this.changeDetector.markForCheck();
                if (!prepend) this.scrollToLatest();
            },
            error: () => {
                if (!this.isCurrentHistoryLoad(historyLoadID, conversationID)) return;
                this.isHistoryLoading = false;
                this.changeDetector.markForCheck();
            },
            complete: () => {
                if (this.isCurrentHistoryLoad(historyLoadID, conversationID)) this.isHistoryLoading = false;
            },
        });
    }

    private isCurrentHistoryLoad(historyLoadID: number, conversationID: string): boolean {
        return this.historyLoadID === historyLoadID && this.selectedConversation?.id === conversationID;
    }

    private markSelectedConversationRead(): boolean {
        if (!this.socketReady || !this.selectedConversation || this.messages.length === 0) return false;
        const sequence = Math.max(...this.messages.map(message => message.sequence));
        if (sequence < 1) return false;
        const sent = this.dataProvider.send({type: 'conversation.read', payload: {conversation_id: this.selectedConversation.id, sequence}});
        if (sent) {
            const current = this.ownReadSequences.get(this.selectedConversation.id) || 0;
            if (sequence > current) this.ownReadSequences.set(this.selectedConversation.id, sequence);
        }
        return sent;
    }

    private clearSelectedConversationUnreadCount(): void {
        if (this.selectedConversation) this.clearConversationUnreadCount(this.selectedConversation.id);
    }

    private clearConversationUnreadCount(conversationID: string): void {
        const conversation = this.conversations.getValue().find(item => item.id === conversationID);
        if (!conversation || conversation.unreadCount === 0) return;
        const updated = {...conversation, unreadCount: 0};
        if (this.selectedConversation?.id === conversationID) this.selectedConversation = updated;
        this.conversations.next(this.conversations.getValue().map(item => item.id === conversationID ? updated : item));
    }

    private resolvePendingMessage(requestID: string): void {
        const pending = this.pendingRequests.get(requestID);
        if (!pending) return;
        window.clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestID);
        this.sendStatus = '';
    }

    private rejectPendingMessage(requestID: string, status: string): void {
        const pending = this.pendingRequests.get(requestID);
        if (!pending) return;
        window.clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestID);
        this.messages = this.messages.filter(message => message.clientMessageId !== pending.clientMessageID);
        this.sendStatus = status;
        this.changeDetector.markForCheck();
    }

    private restoreSelectedConversation(conversations: Conversation[]): void {
        const selectedConversationID = window.localStorage.getItem(this.selectedConversationKey);
        if (!selectedConversationID) return;
        const selectedConversation = conversations.find(item => item.id === selectedConversationID);
        if (selectedConversation) {
            this.selectConversation(selectedConversation);
            return;
        }
        window.localStorage.removeItem(this.selectedConversationKey);
    }

    private scrollToLatest(): void {
        window.setTimeout(() => {
            const element = this.messageHistory?.nativeElement;
            if (element) element.scrollTop = element.scrollHeight;
        });
    }

    private updateConversationActivity(lastMessageAt: string, incrementUnread = false): void {
        if (!this.selectedConversation) return;
        const current = this.conversations.getValue().find(item => item.id === this.selectedConversation?.id) || this.selectedConversation;
        const updated = {...current, lastMessageAt, unreadCount: current.unreadCount + (incrementUnread ? 1 : 0)};
        this.selectedConversation = updated;
        const conversations = this.conversations.getValue();
        this.conversations.next([updated, ...conversations.filter(item => item.id !== updated.id)]);
    }

    private updateBackgroundConversationActivity(conversationID: string, lastMessageAt: string, sequence: number, incrementUnread: boolean): void {
        const conversations = this.conversations.getValue();
        const conversation = conversations.find(item => item.id === conversationID);
        if (!conversation) return;
        const ownReadSequence = this.ownReadSequences.get(conversationID) || 0;
        const shouldIncrement = incrementUnread && sequence > ownReadSequence;
        const updated = {...conversation, lastMessageAt, unreadCount: conversation.unreadCount + (shouldIncrement ? 1 : 0)};
        this.conversations.next([updated, ...conversations.filter(item => item.id !== conversationID)]);
    }
}
