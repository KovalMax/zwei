import {DOCUMENT, Inject, Injectable, OnDestroy} from '@angular/core';
import {Subscription} from 'rxjs';
import {CallFacade} from './call-facade.service';
import {DataProviderService, MessageSocketEvent} from './data-provider.service';
import {BrowserNotificationService} from '../notifications/notification.service';

@Injectable()
export class HomeNotificationService implements OnDestroy {
    private readonly subscriptions = new Subscription();
    private userID?: string;
    private selectedConversationID?: string;

    public constructor(
        dataProvider: DataProviderService,
        private readonly call: CallFacade,
        private readonly notifications: BrowserNotificationService,
        @Inject(DOCUMENT) private readonly document: Document,
    ) {
        this.subscriptions.add(dataProvider.getObservable().subscribe(event => this.handleSocketEvent(event)));
        this.subscriptions.add(call.state$.subscribe(state => {
            if (state.phase === 'incoming') this.notifications.startCallRingtone();
            else this.notifications.stopCallRingtone();
        }));
        this.subscriptions.add(this.notifications.permissionChanges.subscribe(() => {
            if (this.call.state.phase === 'incoming') {
                this.notifications.startCallRingtone();
                if (this.isBackgroundTab() && this.call.state.callID) this.notifications.showCallNotification(this.call.state.callID);
            }
        }));
    }

    public setUserID(userID: string | undefined): void { this.userID = userID; }
    public setSelectedConversationID(conversationID: string | undefined): void { this.selectedConversationID = conversationID; }

    public ngOnDestroy(): void {
        this.subscriptions.unsubscribe();
        this.notifications.stopCallRingtone();
    }

    private handleSocketEvent(event: MessageSocketEvent): void {
        if (event.type === 'message.created') {
            this.handleMessage(event.payload);
            return;
        }
        if (event.type === 'call.incoming') {
            if (this.call.state.phase === 'incoming' && this.isBackgroundTab()) this.notifications.showCallNotification(event.payload.call_id);
        }
    }

    private handleMessage(payload: {conversation_id: string; sender_id: string}): void {
        if (!this.userID || payload.sender_id === this.userID) return;
        const background = this.isBackgroundTab();
        if (background || payload.conversation_id !== this.selectedConversationID) this.notifications.playMessageSound();
        if (background) this.notifications.showMessageNotification(payload.conversation_id);
    }

    private isBackgroundTab(): boolean {
        return this.document.visibilityState === 'hidden' || !this.document.hasFocus();
    }
}
