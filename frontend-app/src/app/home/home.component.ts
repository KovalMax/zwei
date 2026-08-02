import {ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {BehaviorSubject} from 'rxjs';
import {Conversation} from './conversation.model';
import {ConversationService} from './conversation.service';
import {Message} from './message.model';
import {UserSearchResult} from './user.model';
import {DataProviderService, MessageSocketEvent} from './data-provider.service';
import {createRandomID} from '../login/login';
import {AuthService} from '../auth/auth.service';
import {Profile} from '../auth/profile.model';

@Component({
    standalone: false,
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-home',
    templateUrl: './home.component.html',
    styleUrls: ['./home.component.css']
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
    public isSending = false;
    public searchQuery = '';
    public searchResults: UserSearchResult[] = [];
    public socketError = false;
    public socketReady = false;
    public sendStatus = '';
    public profile?: Profile;
    private dataProvider: DataProviderService;
    private acknowledgementTimeout?: number;
    @ViewChild('messageHistory') private messageHistory?: ElementRef<HTMLElement>;

    constructor(private conversationService: ConversationService, private authService: AuthService, private changeDetector: ChangeDetectorRef, http: HttpClient) {
        this.dataProvider = new DataProviderService(http);
    }

    public ngOnInit(): void {
        this.authService.profile().subscribe({next: profile => {
            this.profile = profile;
            this.changeDetector.markForCheck();
        }});
        this.conversationService.list().subscribe({
            next: conversations => {
                this.conversations.next(conversations);
                window.localStorage.removeItem(this.selectedConversationKey);
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
            this.changeDetector.markForCheck();
        });
    }

    public ngOnDestroy(): void {
        window.clearTimeout(this.acknowledgementTimeout);
        this.dataProvider.close();
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

    public senderName(message: Message): string {
        return this.isOwnMessage(message) ? (this.profile?.display_name || 'You') : (this.selectedConversation?.otherDisplayName || 'Conversation member');
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
        });
    }

    public selectConversation(conversation: Conversation): void {
        this.selectedConversation = conversation;
        window.localStorage.setItem(this.selectedConversationKey, conversation.id);
        this.messages = [];
        this.historyCursor = undefined;
        this.loadHistory();
    }

    public closeConversation(): void {
        this.selectedConversation = undefined;
        this.messages = [];
        this.historyCursor = undefined;
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
        if (this.isSending) {
            this.sendStatus = 'Waiting for the previous message to be acknowledged.';
            return;
        }
        if (!this.socketReady) {
            this.sendStatus = 'Secure connection is not ready. Wait a moment and try again.';
            return;
        }
        const clientMessageId = createRandomID();
        const sent = this.dataProvider.send({
            type: 'message.send',
            request_id: createRandomID(),
            payload: {conversation_id: this.selectedConversation.id, client_message_id: clientMessageId, body},
        });
        if (!sent) {
            this.socketReady = false;
            this.sendStatus = 'Secure connection was lost. Refresh to reconnect.';
            this.changeDetector.markForCheck();
            return;
        }
        this.isSending = true;
        this.sendStatus = 'Sending…';
        this.draft = '';
        console.info('Sending chat message', {conversationId: this.selectedConversation.id, clientMessageId});
        window.clearTimeout(this.acknowledgementTimeout);
        this.acknowledgementTimeout = window.setTimeout(() => {
            if (this.isSending) {
                this.isSending = false;
                this.sendStatus = 'No acknowledgement received. Refresh and try again.';
                this.changeDetector.markForCheck();
            }
        }, 10_000);
        this.changeDetector.markForCheck();
    }

    public handleSocketEvent(event: MessageSocketEvent): void {
        if (event.type === 'message.rejected') {
            this.isSending = false;
            this.sendStatus = `Message rejected: ${String((event.payload as {error?: string}).error || 'unknown error')}`;
            window.clearTimeout(this.acknowledgementTimeout);
            this.changeDetector.markForCheck();
            return;
        }
        const message = this.normalizeMessage(event.payload as Record<string, unknown>);
        if (!message || !this.selectedConversation || message.conversationId !== this.selectedConversation.id) return;
        if (!this.messages.some(item => item.id === message.id)) {
            this.messages = [...this.messages, message];
        }
        this.updateConversationActivity(message.createdAt);
        this.isSending = false;
        this.sendStatus = '';
        window.clearTimeout(this.acknowledgementTimeout);
        this.changeDetector.markForCheck();
        this.scrollToLatest();
    }

    private normalizeMessage(payload: Record<string, unknown>): Message | null {
        if (typeof payload.id !== 'string' || typeof payload.conversation_id !== 'string') return null;
        return {
            id: payload.id,
            conversationId: payload.conversation_id,
            senderId: String(payload.sender_id || ''),
            clientMessageId: String(payload.client_message_id || ''),
            sequence: Number(payload.sequence),
            body: String(payload.body || ''),
            createdAt: String(payload.created_at || ''),
        };
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
        this.isHistoryLoading = true;
        this.conversationService.history(this.selectedConversation.id, before).subscribe({
            next: history => {
                const messages = [...history.messages].reverse();
                this.messages = prepend ? [...messages, ...this.messages] : messages;
                this.historyCursor = history.nextCursor;
                this.changeDetector.markForCheck();
                if (!prepend) this.scrollToLatest();
            },
            error: () => { this.isHistoryLoading = false; this.changeDetector.markForCheck(); },
            complete: () => this.isHistoryLoading = false,
        });
    }

    private scrollToLatest(): void {
        window.setTimeout(() => {
            const element = this.messageHistory?.nativeElement;
            if (element) element.scrollTop = element.scrollHeight;
        });
    }

    private updateConversationActivity(lastMessageAt: string): void {
        if (!this.selectedConversation) return;
        const updated = {...this.selectedConversation, lastMessageAt};
        this.selectedConversation = updated;
        const conversations = this.conversations.getValue();
        this.conversations.next([updated, ...conversations.filter(item => item.id !== updated.id)]);
    }
}
