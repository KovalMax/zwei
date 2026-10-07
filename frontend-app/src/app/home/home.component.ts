import {ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Inject, OnDestroy, OnInit, Optional, ViewChild} from '@angular/core';
import {BehaviorSubject, finalize, map, Observable, Subscription} from 'rxjs';
import {Conversation, GroupConversation, GroupMember, GroupPeerReadCursor, GroupRole} from './conversation.model';
import {compareConversationActivityDescending} from './conversation-activity';
import {ConversationService} from './conversation.service';
import {HomeGroupAccessContext, HomeGroupAccessFacade, HomeGroupAccessOutcome} from './home-group-access-facade.service';
import {Message, messageDateLabel, messageDateTimeLabel} from './message.model';
import {UserSearchResult} from './user.model';
import {ConnectionState, DataProviderService, MessageSocketEvent} from './data-provider.service';
import {createRandomID} from '../login/login';
import {AuthService} from '../auth/auth.service';
import {Profile} from '../auth/profile.model';
import {messageSenderDisplayName, toGroupPeerReadCursor, toMessage} from './wire.mapper';
import {CallFacade, CallState} from './call-facade.service';
import {GroupCallFacade, GroupCallPeer, GroupCallState} from './group-call-facade.service';
import {HomeNotificationService} from './home-notification.service';
import {CallPresentationAction, CallPresentationActionID, CallPresentationControl, CallPresentationControlChange, CallPresentationDevice, CallPresentationParticipants, CallPresentationProfile} from './call-presentation.model';
import {GroupMemberAction, GroupMemberActionID, GroupMemberActionIntent} from './group-member-actions.model';
import {GroupMemberListComponent} from './group-member-list.component';
import {DirectCallSurfaceIntent} from './call-presentation/direct-call-surface.component';
import {GroupCallSurfaceIntent} from './call-presentation/group-call-surface.component';

@Component({
    standalone: false,
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-home',
    templateUrl: './home.component.html',
    styleUrls: ['./home.component.css'],
    providers: [DataProviderService, CallFacade, GroupCallFacade, HomeNotificationService, HomeGroupAccessFacade],
})
export class HomeComponent implements OnInit, OnDestroy {
    private readonly selectedConversationKey = 'zwei_selected_conversation';
    public conversations = new BehaviorSubject<Conversation[]>([]);
    public isLoading = true;
    public groupPageLoading = false;
    public groupPageError = false;
    public groupPageLoaded = false;
    public groupSnapshotLoading = false;
    public groupNextCursor: string | null = null;
    public selectedConversation?: Conversation;
    public messages: Message[] = [];
    public historyCursor?: string;
    public isHistoryLoading = false;
    public draft = '';
    public searchQuery = '';
    public searchResults: UserSearchResult[] = [];
    public searchState: 'idle' | 'loading' | 'results' | 'empty' | 'error' = 'idle';
    public groupName = '';
    public groupMemberQuery = '';
    public groupMemberResults: UserSearchResult[] = [];
    public groupMemberSearchState: 'idle' | 'loading' | 'results' | 'empty' | 'error' = 'idle';
    public selectedGroupMember?: UserSearchResult;
    public groupError = '';
    public groupMembershipRefreshError = '';
    public groupMembershipRefreshErrorConversationID?: string;
    public groupLoading = false;
    public isCreatingGroup = false;
    public showGroupManager = false;
    public socketError = false;
    public socketReady = false;
    public connectionState: ConnectionState = 'offline';
    public presenceReady = false;
    public sendStatus = '';
    public profile?: Profile;
    public callElapsedSeconds = 0;
    private callMinimized = false;
    public groupCallMinimized = false;
    private groupCallNoticeConversationID?: string;
    public groupScreenQuality: '360p' | '720p' | '1080p' | '2k' = '720p';
    private typingTimeout?: number;
    private typingTargetConversationID?: string;
    private remoteTypingTimeout?: number;
    private lastTypingStartAt = 0;
    private readonly pendingRequests = new Map<string, {clientMessageID: string; timeout: number}>();
    private historyLoadID = 0;
    private onlineUserIDs = new Set<string>();
    private typingConversationID?: string;
    private readonly groupTypingTimeouts = new Map<string, number>();
    private pendingIncomingCallConversation?: {conversationID: string; navigationIntentVersion: number};
    private isTyping = false;
    private callStartedAt?: number;
    private callTimer?: number;
    private conversationRefreshGeneration = 0;
    private conversationRefreshTimer?: number;
    private groupPresenceRefreshTimer?: number;
    private lastGroupPresenceRefreshAt?: number;
    private initialConversationLoadState: 'pending' | 'ready' | 'failed' = 'pending';
    private hasEstablishedConnection = false;
    public readonly groupMemberActionsFor = (member: GroupMember): readonly GroupMemberAction[] => this.groupMemberActions(member);
    private callStateSubscription?: Subscription;
    private groupCallStateSubscription?: Subscription;
    private readonly peerReadSequences = new Map<string, number>();
    private readonly groupPeerReadCursors = new Map<string, Map<string, GroupPeerReadCursor>>();
    private readonly ownReadSequences = new Map<string, number>();
    public showDepartedGroupStatus = false;
    private readonly groupAccess: HomeGroupAccessFacade;
    private readonly groupMutationSubscriptions = new Subscription();
    private readonly abortedGroupCallConversations = new Set<string>();
    private readonly clearedGroupProjections = new Set<string>();
    private readonly staleGroupIDs = new Set<string>();
    private readonly groupAccessSubscription = new Subscription();
    private readonly listRequests = new Subscription();
    private groupPageRequest?: Subscription;
    private groupMemberSearchRequest?: Subscription;
    private groupMemberSearchGeneration = 0;
    private userSearchRequest?: Subscription;
    private userSearchGeneration = 0;
    private recoveryGeneration = 0;
    private navigationIntentVersion = 0;
    @ViewChild('messageHistory') private messageHistory?: ElementRef<HTMLElement>;
    @ViewChild(GroupMemberListComponent) private groupMemberList?: GroupMemberListComponent;

    constructor(private conversationService: ConversationService, private authService: AuthService, private changeDetector: ChangeDetectorRef, private dataProvider: DataProviderService, public call: CallFacade, groupAccess: HomeGroupAccessFacade, @Optional() @Inject(HomeNotificationService) private readonly notifications?: HomeNotificationService, @Optional() @Inject(GroupCallFacade) public groupCall?: GroupCallFacade) {
        this.groupAccess = groupAccess;
        this.groupAccessSubscription.add(this.groupAccess.outcomes$.subscribe(outcome => this.handleGroupAccessOutcome(outcome)));
    }

    public ngOnInit(): void {
        this.authService.profile().subscribe({next: profile => {
            this.profile = profile;
        this.notifications?.setUserID?.(profile.id);
            this.changeDetector.markForCheck();
        }});
        this.loadInitialConversations(++this.conversationRefreshGeneration, 2);
        this.dataProvider.getObservable().subscribe({
            next: event => this.handleSocketEvent(event),
            error: () => { this.socketError = true; this.changeDetector.markForCheck(); },
        });
        this.dataProvider.connectionStateChanges.subscribe(state => {
            this.connectionState = state;
            this.socketReady = state === 'ready';
            if (state === 'recovering') {
                this.clearEphemeralRecoveryState();
                if (this.hasEstablishedConnection) this.refreshConversationsForRecovery();
                else this.completeInitialRecovery();
            }
            if (state === 'ready') {
                this.hasEstablishedConnection = true;
                this.replayUncertainMessages();
                if (this.selectedConversation?.kind === 'group') this.requestGroupPresenceRefresh();
                if (this.markSelectedConversationRead()) this.clearSelectedConversationUnreadCount();
            }
            this.changeDetector.markForCheck();
        });
        this.callStateSubscription = this.call.state$.subscribe(state => this.handleCallState(state));
        this.groupCallStateSubscription = this.groupCall?.state$.subscribe(state => {
            if (state.room?.conversation_id || state.conversationID) this.groupCallNoticeConversationID = state.room?.conversation_id ?? state.conversationID;
            else if (state.phase === 'idle') this.groupCallNoticeConversationID = undefined;
            if (state.room && ['requesting', 'joining', 'ringing', 'active'].includes(state.phase)) this.abortedGroupCallConversations.delete(state.room.conversation_id);
            if (state.room && ['requesting', 'joining'].includes(state.phase)) this.clearedGroupProjections.delete(state.room.conversation_id);
            if (state.phase === 'idle' || state.phase === 'left' || state.phase === 'ended' || state.phase === 'error') this.groupCallMinimized = false;
            this.changeDetector.markForCheck();
        });
    }

    public ngOnDestroy(): void {
        this.conversationRefreshGeneration++;
        this.recoveryGeneration++;
        this.listRequests.unsubscribe();
        this.groupPageRequest?.unsubscribe();
        this.groupMemberSearchGeneration++;
        this.groupMemberSearchRequest?.unsubscribe();
        this.userSearchGeneration++;
        this.userSearchRequest?.unsubscribe();
        this.groupMutationSubscriptions.unsubscribe();
        this.groupAccessSubscription.unsubscribe();
        this.groupAccess.ngOnDestroy();
        for (const pending of this.pendingRequests.values()) window.clearTimeout(pending.timeout);
        this.stopTyping();
        this.clearRemoteTypingState();
        window.clearTimeout(this.groupPresenceRefreshTimer);
        window.clearTimeout(this.conversationRefreshTimer);
        this.callStateSubscription?.unsubscribe();
        this.groupCallStateSubscription?.unsubscribe();
        this.stopCallTimer();
        this.call.close();
        this.groupCall?.close?.();
        this.dataProvider.close();
    }

    public startCall(): void {
        if (this.selectedConversation?.kind === 'direct') void this.call.start(this.selectedConversation.id, this.selectedConversation.otherUserId);
    }

    public startGroupCall(): void {
        if (this.selectedConversation?.kind !== 'group' || !this.profile?.id || !this.groupCall) return;
        this.groupCallNoticeConversationID = this.selectedConversation.id;
        // The facade publishes requesting state before awaiting microphone access.
        // Schedule this OnPush view in the same click turn so the initiator sees
        // the call card before a room event can arrive from the socket.
        this.groupCall.discoverAndStart(this.selectedConversation.id, this.profile.id);
        this.changeDetector.markForCheck();
    }

    public joinGroupCall(): void {
        const room = this.groupCall?.state.room;
        if (room && this.profile?.id) {
            this.groupCallNoticeConversationID = room.conversation_id;
            void this.groupCall?.join(room, this.profile.id);
        }
    }

    public rejoinGroupCall(): void {
        if (this.selectedConversation?.kind !== 'group' || !this.profile?.id || !this.socketReady || !this.groupCall?.canRejoin(this.selectedConversation.id)) return;
        this.groupCall.rejoin(this.profile.id);
        this.changeDetector.markForCheck();
    }

    public showGroupCallTerminalNotice(state: GroupCallState): boolean {
        if (state.phase !== 'left' && state.phase !== 'ended' && state.phase !== 'error') return false;
        const originConversationID = state.conversationID ?? this.groupCallNoticeConversationID;
        return this.selectedConversation ? originConversationID === this.selectedConversation.id : Boolean(originConversationID);
    }

    public minimizeGroupCall(): void {
        if (!this.groupCall?.isOngoing) return;
        this.groupCallMinimized = true;
        this.changeDetector.markForCheck();
    }

    public restoreGroupCall(): void {
        if (!this.groupCall?.isOngoing) return;
        this.groupCallMinimized = false;
        const conversationID = this.groupCall.state.room?.conversation_id;
        const conversation = this.conversations.getValue().find(item => item.id === conversationID);
        if (conversation && this.selectedConversation?.id !== conversation.id) this.selectConversation(conversation, true);
        this.changeDetector.markForCheck();
    }

    public startGroupPresentation(): void {
        const room = this.groupCall?.state.room;
        if (!this.groupCall || !room) return;
        const presenter = room.presenter;
        if (presenter && presenter.user_id !== this.profile?.id && !window.confirm('Replace the current presenter? Their presentation will stop.')) return;
        void this.groupCall.startPresentation(this.groupScreenQuality);
    }

    public onGroupInputDeviceChange(deviceID: string): void { if (deviceID) void this.groupCall?.selectInputDevice(deviceID); }
    public onGroupOutputDeviceChange(deviceID: string): void {
        void this.groupCall?.selectOutputDevice(deviceID);
    }

    public onGroupScreenQualityChange(quality: string): void {
        if (quality === '360p' || quality === '720p' || quality === '1080p' || quality === '2k') this.groupScreenQuality = quality;
    }

    public groupCallControls(): readonly CallPresentationControl[] {
        const state = this.groupCall?.state;
        const inputDevices = state?.inputDevices.map(device => ({id: device.deviceId, label: device.label || 'Microphone'})) || [];
        const outputDevices = state?.outputDevices.map(device => ({id: device.deviceId, label: device.label || 'Speaker'})) || [];
        return [
            this.deviceControl('microphone', 'Microphone input', state?.selectedInputID || '', [{id: '', label: 'Current microphone'}, ...inputDevices], !state?.localStream),
            this.deviceControl('speaker', 'Speaker output', state?.selectedOutputID || '', [{id: '', label: 'System default'}, ...outputDevices], !state?.localStream || !state.outputDevices.length),
            this.deviceControl('quality', 'Presentation quality', this.groupScreenQuality, this.qualityOptions(), Boolean(state?.sharing || state?.shareTransitioning)),
        ];
    }

    public groupCallActions(): readonly CallPresentationAction[] {
        const state = this.groupCall?.state;
        if (!state?.localStream) return [];
        return [
            {id: 'mute', label: state.muted ? 'Unmute microphone' : 'Mute microphone', active: state.muted, disabled: false},
            {id: 'screen-share', label: state.presentation ? 'Stop presenting' : 'Present screen', active: Boolean(state.presentation), disabled: state.shareTransitioning},
        ];
    }

    public onGroupCallControlChange(change: CallPresentationControlChange): void {
        if (change.id === 'microphone') this.onGroupInputDeviceChange(change.value);
        if (change.id === 'speaker') this.onGroupOutputDeviceChange(change.value);
        if (change.id === 'quality') this.onGroupScreenQualityChange(change.value);
    }

    public onGroupCallAction(action: CallPresentationActionID): void {
        if (action === 'mute') this.groupCall?.toggleMute();
        if (action === 'screen-share') {
            if (this.groupCall?.state.presentation) this.groupCall.stopPresentation();
            else this.startGroupPresentation();
        }
    }

    public onGroupCallSurfaceIntent(intent: GroupCallSurfaceIntent): void {
        switch (intent.type) {
            case 'collapse': this.minimizeGroupCall(); break;
            case 'join': this.joinGroupCall(); break;
            case 'enable-sound': this.groupCall?.enableRemoteAudio(); break;
            case 'action': this.onGroupCallAction(intent.actionID); break;
            case 'control-change': this.onGroupCallControlChange(intent.change); break;
            case 'screen-share-audio-change': this.groupCall?.setScreenShareAudioEnabled(intent.enabled); break;
            case 'leave': this.groupCall?.leave(); break;
            case 'end': this.groupCall?.end(); break;
            case 'presentation-ready': this.playGroupPresentation(intent.event); break;
        }
    }

    public trackConversation(_index: number, conversation: Conversation): string { return conversation.id; }

    public alignGroupListEnd(event: Event): void {
        const list = event.currentTarget;
        if (!(list instanceof HTMLElement) || list.scrollTop + list.clientHeight < list.scrollHeight - 70) return;

        const footer = list.querySelector<HTMLElement>('.group-page-error, .load-more-groups');
        const footerStyle = footer ? getComputedStyle(footer) : undefined;
        const footerExtent = footer && footerStyle
            ? footer.getBoundingClientRect().height + (Number.parseFloat(footerStyle.marginTop) || 0) + (Number.parseFloat(footerStyle.marginBottom) || 0)
            : 0;
        const listStyle = getComputedStyle(list);
        const bottomPadding = Number.parseFloat(listStyle.paddingBottom) || 0;
        const rowsExtent = Math.max(1, list.clientHeight - footerExtent - bottomPadding);
        const visibleRows = Math.max(1, Math.floor(rowsExtent / 70));
        const rowHeight = `${(Math.floor((rowsExtent / visibleRows) * 64) / 64).toFixed(5)}px`;
        if (list.style.getPropertyValue('--people-row-aligned-height') !== rowHeight) {
            list.style.setProperty('--people-row-aligned-height', rowHeight);
            list.style.setProperty('--people-end-alignment-offset', '0px');
            list.scrollTop = list.scrollHeight;
        }

        const listTop = list.getBoundingClientRect().top;
        const clippedRow = Array.from(list.querySelectorAll<HTMLElement>('.person-option')).find(row => {
            const bounds = row.getBoundingClientRect();
            return bounds.top < listTop && bounds.bottom > listTop;
        });
        if (!clippedRow) return;

        const clippedPixels = clippedRow.getBoundingClientRect().bottom - listTop;
        list.style.setProperty('--people-end-alignment-offset', `${clippedPixels}px`);
        list.scrollTop = list.scrollHeight;
    }
    public trackUserResult(_index: number, user: UserSearchResult): string { return user.id; }
    public trackGroupMember(_index: number, member: GroupConversation['members'][number]): string { return member.userId; }
    public trackGroupPeer(_index: number, peer: GroupCallPeer): string { return `${peer.userID}:${peer.deviceID}`; }
    public trackMessage(_index: number, message: Message): string { return `${message.senderId}:${message.clientMessageId}`; }

    public playGroupPresentation(event: Event): void {
        if (event.target instanceof HTMLVideoElement) void event.target.play().catch(() => undefined);
    }

    public groupCallConversation(): GroupConversation | undefined {
        const conversationID = this.groupCall?.state.room?.conversation_id;
        const conversation = this.conversations.getValue().find(item => item.id === conversationID);
        return conversation?.kind === 'group' ? conversation : undefined;
    }

    public groupParticipantName(userID: string): string {
        return this.groupCallConversation()?.members.find(member => member.userId === userID)?.displayName || 'Group participant';
    }

    public directCallProfile(): CallPresentationProfile {
        const state = this.call.state;
        const status = state.phase === 'error' && state.statusLabel === 'Call unavailable: call unavailable' && this.isSelectedUserOffline()
            ? 'Call unavailable: recipient is offline'
            : state.statusLabel;
        return {
            name: this.callDisplayName(),
            status,
            initials: this.callInitials(),
            duration: state.phase === 'active' ? this.callDurationLabel() : undefined,
            error: Boolean(state.errorLabel),
        };
    }

    public groupCallProfile(): CallPresentationProfile {
        const state = this.groupCall?.state;
        return {
            name: this.conversationName(this.groupCallConversation()) || 'Group audio call',
            status: state?.statusLabel || 'Group call',
            isGroup: true,
            error: Boolean(state?.errorLabel),
        };
    }

    public groupCallParticipants(): readonly CallPresentationParticipants[] {
        return (this.groupCall?.state.room?.participants || []).map(participant => ({id: participant.user_id, name: this.groupParticipantName(participant.user_id)}));
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
        if (conversation && this.selectedConversation?.id !== conversation.id) this.selectConversation(conversation, true);
        this.changeDetector.markForCheck();
    }

    public onCallInputDeviceChange(deviceID: string): void {
        if (deviceID) void this.call.selectInputDevice(deviceID);
    }

    public directCallControls(): readonly CallPresentationControl[] {
        const inputDevices = this.call.inputDevices.map(device => ({id: device.deviceID, label: device.label}));
        const outputDevices = this.call.outputDevices.map(device => ({id: device.deviceID, label: device.label}));
        return [
            this.deviceControl('microphone', 'Microphone input', this.call.selectedInputDeviceID, [{id: '', label: 'Current microphone'}, ...inputDevices], false),
            this.deviceControl('speaker', 'Speaker output', this.call.selectedOutputDeviceID, [{id: '', label: 'System default'}, ...outputDevices], !this.call.outputSelectionSupported || !this.call.outputDevices.length),
            this.deviceControl('quality', 'Screen share quality', this.call.screenShareQuality, this.qualityOptions(), this.call.state.screenShareTransition),
        ];
    }

    public directCallActions(): readonly CallPresentationAction[] {
        return [
            {id: 'mute', label: this.call.state.muted ? 'Unmute microphone' : 'Mute microphone', active: this.call.state.muted, disabled: false},
            {id: 'screen-share', label: this.call.state.screenShareStream ? 'Stop sharing' : 'Share screen', active: Boolean(this.call.state.screenShareStream), disabled: !this.call.screenShareSupported() || this.call.state.screenShareTransition},
        ];
    }

    public onDirectCallControlChange(change: CallPresentationControlChange): void {
        if (change.id === 'microphone') this.onCallInputDeviceChange(change.value);
        if (change.id === 'speaker') void this.call.selectOutputDevice(change.value);
        if (change.id === 'quality') this.onScreenQualityChange(change.value);
    }

    public onDirectCallAction(action: CallPresentationActionID): void {
        if (action === 'mute') this.call.toggleMute();
        if (action === 'screen-share') this.call.toggleScreenShare();
    }

    public onDirectCallSurfaceIntent(intent: DirectCallSurfaceIntent): void {
        switch (intent.type) {
            case 'accept': this.call.accept(); break;
            case 'decline': this.call.decline(); break;
            case 'cancel': this.call.cancel(); break;
            case 'enable-sound': this.call.enableRemoteAudio(); break;
            case 'end': this.call.end(); break;
            case 'collapse': this.minimizeCall(); break;
            case 'action': this.onDirectCallAction(intent.actionID); break;
            case 'control-change': this.onDirectCallControlChange(intent.change); break;
            case 'remote-audio-ready': this.call.playRemoteAudio(intent.event); break;
            case 'remote-screen-ready': this.call.playRemoteScreen(intent.event); break;
            case 'screen-share-audio-change': this.call.setScreenShareAudioEnabled(intent.enabled); break;
        }
    }

    public callSelectPanelClass(): string {
        return document.documentElement.classList.contains('light-theme') ? 'call-select-panel call-select-panel-light' : 'call-select-panel call-select-panel-dark';
    }

    private qualityOptions(): readonly CallPresentationDevice[] {
        return [
            {id: '360p', label: '360p · economy'}, {id: '720p', label: '720p · balanced'},
            {id: '1080p', label: '1080p · detail'}, {id: '2k', label: '2K · ultra'},
        ];
    }

    private deviceControl(id: CallPresentationControl['id'], label: string, value: string, options: readonly CallPresentationDevice[], disabled: boolean): CallPresentationControl {
        return {id, label, value, options, disabled};
    }

    public onCallOutputDeviceChange(deviceID: string): void {
        void this.call.selectOutputDevice(deviceID);
    }

    public onScreenQualityChange(quality: string): void {
        switch (quality) {
            case '360p':
                void this.call.selectScreenShareQuality('360p');
                break;
            case '720p':
                void this.call.selectScreenShareQuality('720p');
                break;
            case '1080p':
                void this.call.selectScreenShareQuality('1080p');
                break;
            case '2k':
                void this.call.selectScreenShareQuality('2k');
                break;
        }
    }

    public isCallSurfaceVisible(): boolean {
        return this.isOngoingCall() && !this.callMinimized;
    }

    public isCallMinimized(): boolean {
        return this.isOngoingCall() && this.callMinimized;
    }

    public isOngoingCall(): boolean {
        return this.call.state?.phase === 'connecting' || this.call.state?.phase === 'active';
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
        if (state.phase === 'idle' || state.phase === 'ended' || state.phase === 'error') this.pendingIncomingCallConversation = undefined;
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
        return this.conversationName(this.callConversation()) || (this.call.state.phase === 'incoming' ? 'Incoming caller' : 'Audio call');
    }

    public callInitials(): string {
        const conversation = this.callConversation();
        return conversation ? this.initials(conversation) : '??';
    }

    public headerDisplayName(): string {
        return this.conversationName(this.selectedConversation) || this.conversationName(this.callConversation()) || 'Choose a conversation';
    }

    public headerInitials(): string {
        return this.selectedConversation ? this.initials(this.selectedConversation) : this.callConversation() ? this.callInitials() : 'L';
    }

    public initials(conversation: Conversation): string {
        return this.conversationName(conversation).slice(0, 2).toUpperCase();
    }

    public conversationName(conversation?: Conversation): string { return conversation?.kind === 'group' ? conversation.name : conversation?.otherDisplayName || ''; }
    public conversationSubtitle(conversation: Conversation): string { return conversation.kind === 'group' ? (conversation.accessNeedsVerification ? 'Access verification required' : `${conversation.members.length} members`) : conversation.otherEmail; }
    public isGroup(conversation = this.selectedConversation): conversation is GroupConversation { return conversation?.kind === 'group'; }
    public get groupSelected(): GroupConversation | undefined { return this.selectedConversation?.kind === 'group' && !this.selectedConversation.accessNeedsVerification ? this.selectedConversation : undefined; }
    public currentRole(): GroupRole | undefined { return this.selectedConversation?.kind === 'group' ? this.selectedConversation.members.find(member => member.userId === this.profile?.id)?.role : undefined; }
    public canManageGroup(): boolean { const role = this.currentRole(); return role === 'owner' || role === 'admin'; }
    public canTransferOwnership(): boolean { return this.currentRole() === 'owner'; }
    public canDeleteGroup(): boolean { return this.currentRole() === 'owner'; }

    public groupMemberActions(member: GroupMember): readonly GroupMemberAction[] {
        const group = this.groupSelected;
        const actorRole = this.currentRole();
        if (!group || (actorRole !== 'owner' && actorRole !== 'admin') || member.userId === this.profile?.id || member.userId === group.ownerId || member.role === 'owner') return [];

        const actions: GroupMemberAction[] = member.role === 'admin'
            ? [{id: 'make-member', label: 'Make member', ariaLabel: `Make ${member.displayName} a member`, icon: 'person'}]
            : [{id: 'make-admin', label: 'Make admin', ariaLabel: `Make ${member.displayName} an admin`, icon: 'badge'}];
        if (actorRole === 'owner') actions.push({id: 'transfer-owner', label: 'Transfer owner', ariaLabel: `Transfer ownership to ${member.displayName}`, icon: 'swap_horiz'});
        actions.push({id: 'remove-member', label: 'Remove', ariaLabel: `Remove ${member.displayName}`, icon: 'person_remove'});
        return actions;
    }

    public performGroupMemberAction(member: GroupMember, actionID: GroupMemberActionID): void {
        if (this.groupLoading || !this.groupMemberActions(member).some(action => action.id === actionID)) return;
        switch (actionID) {
            case 'make-admin': this.changeMemberRole(member.userId, 'admin'); break;
            case 'make-member': this.changeMemberRole(member.userId, 'member'); break;
            case 'transfer-owner': this.transferOwnership(member.userId); break;
            case 'remove-member': this.removeGroupMember(member.userId); break;
        }
    }

    public handleGroupMemberAction(intent: GroupMemberActionIntent): void {
        const member = this.groupSelected?.members.find(candidate => candidate.userId === intent.memberUserID);
        if (member) this.performGroupMemberAction(member, intent.actionID);
    }

    public dismissGroupMemberTooltips(): void { this.groupMemberList?.hideTooltips(); }

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
        if (message.kind === 'system') return false;
        const conversation = this.conversations.getValue().find(item => item.id === message.conversationId) || (this.selectedConversation?.id === message.conversationId ? this.selectedConversation : undefined);
        if (conversation?.kind === 'group') {
            if (message.pending || !this.isOwnMessage(message)) return false;
            const activeOtherMembers = conversation.members.filter(member => member.userId !== this.profile?.id);
            const cursors = this.groupPeerReadCursors.get(message.conversationId);
            const qualifies = (candidate: Message): boolean => activeOtherMembers.some(member => {
                const cursor = cursors?.get(member.userId);
                return cursor !== undefined && cursor.sequence >= candidate.sequence && cursor.visibleFromSequence <= candidate.sequence && member.visibleFromSequence <= candidate.sequence;
            });
            return qualifies(message) && !this.messages.some(item => item.conversationId === message.conversationId && this.isOwnMessage(item) && !item.pending && item.sequence > message.sequence && qualifies(item));
        }
        const readSequence = this.peerReadSequences.get(message.conversationId) || 0;
        if (message.pending || !this.isOwnMessage(message) || message.sequence > readSequence) return false;
        return !this.messages.some(item => this.isOwnMessage(item) && item.conversationId === message.conversationId && item.sequence > message.sequence && item.sequence <= readSequence);
    }

    public readReceiptLabel(message: Message): string {
        const conversation = this.conversations.getValue().find(item => item.id === message.conversationId) || (this.selectedConversation?.id === message.conversationId ? this.selectedConversation : undefined);
        return conversation?.kind === 'group' ? 'Read by at least one member' : 'Read by peer';
    }

    public senderName(message: Message): string {
        return messageSenderDisplayName(message, this.selectedConversation, this.profile?.id, this.profile?.display_name);
    }

    public messageDateLabel(message: Message): string { return messageDateLabel(message.createdAt); }
    public messageDateTimeLabel(message: Message): string { return messageDateTimeLabel(message.createdAt); }

    public peerPresenceLabel(): string {
        if (!this.selectedConversation) return this.socketReady ? 'Live connection' : 'Connecting…';
        if (this.selectedConversation.kind === 'group' && this.selectedConversation.accessNeedsVerification) return 'Group access needs verification';
        if (!this.socketReady) return 'Connection unavailable';
        if (!this.presenceReady) return 'Checking presence…';
        if (this.selectedConversation.kind === 'group') return `${this.selectedConversation.members.filter(member => this.onlineUserIDs.has(member.userId)).length} members online`;
        return this.onlineUserIDs.has(this.selectedConversation.otherUserId) ? 'Online' : 'Offline';
    }

    public isSelectedUserOffline(): boolean {
        return !!this.selectedConversation && this.selectedConversation.kind === 'direct' && this.presenceReady && !this.onlineUserIDs.has(this.selectedConversation.otherUserId);
    }

    public isSelectedPresenceNeutral(): boolean {
        if (!this.selectedConversation || !this.presenceReady) return false;
        if (this.selectedConversation.kind === 'direct') return this.isSelectedUserOffline();
        if (this.selectedConversation.kind === 'group') return !this.selectedConversation.members.some(member => this.onlineUserIDs.has(member.userId));
        return false;
    }

    public isSelectedUserTyping(): boolean {
        const selected = this.selectedConversation;
        if (!selected) return false;
        if (selected.kind !== 'group') return this.typingConversationID === selected.id;
        return selected.members.some(member => this.groupTypingTimeouts.has(member.userId));
    }

    public typingIndicatorText(): string | undefined {
        const selected = this.selectedConversation;
        if (!selected || !this.isSelectedUserTyping()) return undefined;
        if (selected.kind !== 'group') return `${selected.otherDisplayName} is typing…`;
        const names = selected.members
            .filter(member => member.userId !== this.profile?.id && this.groupTypingTimeouts.has(member.userId))
            .map(member => member.displayName.trim())
            .filter(Boolean)
            .sort((first, second) => first.localeCompare(second));
        if (names.length === 1) return `${names[0]} is typing…`;
        if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
        if (names.length > 2) return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]} are typing…`;
        return undefined;
    }

    public onDraftChange(): void {
        if (!this.selectedConversation || !this.socketReady) return;
        if (!this.draft.trim()) {
            this.stopTyping();
            return;
        }
        if (!this.isTyping || Date.now() - this.lastTypingStartAt >= 1_200) {
            this.isTyping = this.dataProvider.send({type: 'typing.start', payload: {conversation_id: this.selectedConversation.id}});
            if (this.isTyping) {
                this.typingTargetConversationID = this.selectedConversation.id;
                this.lastTypingStartAt = Date.now();
            }
        }
        window.clearTimeout(this.typingTimeout);
        this.typingTimeout = window.setTimeout(() => this.stopTyping(), 2_000);
    }

    public searchUsers(): void {
        const query = this.searchQuery.trim();
        const generation = ++this.userSearchGeneration;
        this.userSearchRequest?.unsubscribe();
        this.userSearchRequest = undefined;
        this.searchResults = [];
        if (query.length < 2) { this.searchState = 'idle'; this.changeDetector.markForCheck(); return; }
        this.searchState = 'loading';
        this.changeDetector.markForCheck();
        this.userSearchRequest = this.conversationService.searchUsers(query).subscribe({
            next: results => {
                if (generation !== this.userSearchGeneration) return;
                this.searchResults = results;
                this.searchState = results.length ? 'results' : 'empty';
                this.changeDetector.markForCheck();
            },
            error: () => {
                if (generation !== this.userSearchGeneration) return;
                this.searchResults = [];
                this.searchState = 'error';
                this.changeDetector.markForCheck();
            },
        });
    }

    public startConversation(user: UserSearchResult): void {
        this.conversationService.create(user.id).subscribe(conversation => {
            const items = this.conversations.getValue();
            this.conversations.next([conversation, ...items.filter(item => item.id !== conversation.id)]);
            this.searchResults = [];
            this.searchQuery = '';
            this.searchState = 'idle';
            this.userSearchGeneration++;
            this.userSearchRequest?.unsubscribe();
            this.selectConversation(conversation);
            this.dataProvider.send({type: 'presence.refresh'});
        });
    }

    public createGroup(): void {
        if (this.groupLoading) return;
        const name = this.groupName.trim();
        if (!name) { this.groupError = 'Enter a group name.'; return; }
        this.navigationIntentVersion++;
        this.runGroupMutation(this.conversationService.createGroup(name, []), group => {
            if (!this.upsertGroup(group)) return;
            this.groupName = '';
            this.isCreatingGroup = false;
            this.showGroupManager = true;
            this.selectConversation(group);
        }, 'Could not create the group.');
    }

    public clearGroupNameValidationError(name: string): void {
        if (name.trim() && this.groupError === 'Enter a group name.') this.groupError = '';
    }

    public openGroupCreation(): void {
        if (this.groupLoading) return;
        this.closeConversation();
        this.navigationIntentVersion++;
        this.groupName = '';
        this.groupError = '';
        this.isCreatingGroup = true;
        this.changeDetector.markForCheck();
    }

    public cancelGroupCreation(): void {
        if (this.groupLoading) return;
        this.navigationIntentVersion++;
        this.groupName = '';
        this.groupError = '';
        this.isCreatingGroup = false;
        this.changeDetector.markForCheck();
    }

    public toggleGroupManager(): void {
        this.showGroupManager = !this.showGroupManager;
        if (this.showGroupManager && this.selectedConversation?.kind === 'group') this.groupName = this.selectedConversation.name;
    }

    public searchGroupMembers(): void {
        const query = this.groupMemberQuery.trim();
        const generation = ++this.groupMemberSearchGeneration;
        this.groupMemberSearchRequest?.unsubscribe();
        this.groupMemberSearchRequest = undefined;
        this.selectedGroupMember = undefined;
        this.groupMemberResults = [];
        if (query.length < 2) { this.groupMemberSearchState = 'idle'; this.changeDetector.markForCheck(); return; }
        this.groupMemberSearchState = 'loading';
        this.groupMemberSearchRequest = this.conversationService.searchUsers(query).subscribe({
            next: results => {
                if (generation !== this.groupMemberSearchGeneration) return;
                this.groupMemberResults = results;
                this.groupMemberSearchState = results.length ? 'results' : 'empty';
                this.changeDetector.markForCheck();
            },
            error: () => {
                if (generation !== this.groupMemberSearchGeneration) return;
                this.groupMemberResults = [];
                this.groupMemberSearchState = 'error';
                this.changeDetector.markForCheck();
            },
        });
    }

    public selectGroupMember(user: UserSearchResult): void {
        this.selectedGroupMember = user;
        this.groupMemberQuery = user.display_name;
        this.groupMemberResults = [];
        this.groupMemberSearchState = 'idle';
        this.groupMemberSearchGeneration++;
        this.groupMemberSearchRequest?.unsubscribe();
    }

    public addGroupMember(): void {
        if (this.groupLoading) return;
        const group = this.selectedConversation; const user = this.selectedGroupMember;
        if (!group || group.kind !== 'group' || !user) { this.groupError = 'Choose a person from search results.'; return; }
        this.mutateGroup(this.conversationService.addGroupMember(group.id, user.id), () => { this.groupMemberQuery = ''; this.selectedGroupMember = undefined; });
    }
    public renameGroup(): void {
        if (this.groupLoading) return;
        const group = this.selectedConversation;
        const name = this.groupName.trim();
        if (group?.kind === 'group' && name) this.mutateGroup(this.conversationService.renameGroup(group.id, name));
    }
    public removeGroupMember(userID: string): void {
        if (this.groupLoading) return;
        const group = this.selectedConversation;
        if (group?.kind === 'group' && window.confirm('Remove this member?')) this.mutateGroup(this.conversationService.removeGroupMember(group.id, userID));
    }
    public changeMemberRole(userID: string, role: GroupRole): void {
        if (this.groupLoading) return;
        const group = this.selectedConversation;
        if (group?.kind === 'group') this.mutateGroup(this.conversationService.changeGroupRole(group.id, userID, role));
    }
    public transferOwnership(userID: string): void {
        if (this.groupLoading) return;
        const group = this.selectedConversation;
        if (group?.kind === 'group' && window.confirm('Transfer ownership?')) this.mutateGroup(this.conversationService.transferGroupOwnership(group.id, userID));
    }
    public leaveGroup(): void {
        if (this.groupLoading) return;
        const group = this.selectedConversation;
        if (group?.kind === 'group' && window.confirm('Leave this group?')) {
            this.runGroupDeparture(group.id, this.conversationService.leaveGroup(group.id));
        }
    }
    public deleteGroup(): void {
        if (this.groupLoading) return;
        const group = this.selectedConversation;
        if (group?.kind === 'group' && window.confirm('Delete this group for all members?')) {
            this.runGroupDeparture(group.id, this.conversationService.deleteGroup(group.id));
        }
    }

    public selectConversation(conversation: Conversation, preserveCallSurface = false): void {
        this.navigationIntentVersion++;
        this.selectConversationInternal(conversation, preserveCallSurface);
    }

    private selectConversationInternal(conversation: Conversation, preserveCallSurface: boolean): void {
        this.stopTyping();
        this.clearRemoteTypingState();
        if (!preserveCallSurface && this.isOngoingCall()) this.minimizeCall();
        const selectedConversation = {...conversation};
        this.isCreatingGroup = false;
        if (selectedConversation.kind === 'group') this.groupName = selectedConversation.name;
        this.selectedConversation = selectedConversation;
        this.showDepartedGroupStatus = false;
        if (selectedConversation.kind === 'group' && selectedConversation.accessNeedsVerification) {
            this.messages = [];
            this.showDepartedGroupStatus = true;
            this.groupAccess.verifyQuarantined(selectedConversation.id, this.groupAccessContext(selectedConversation.id));
            this.changeDetector.markForCheck();
            return;
        }
        if (selectedConversation.kind === 'group') this.groupAccess.markAuthorized(selectedConversation.id, selectedConversation.membershipRevision);
        if (selectedConversation.kind === 'group') this.requestGroupPresenceRefresh();
        this.notifications?.setSelectedConversationID?.(conversation.id);
        window.localStorage.setItem(this.selectedConversationKey, conversation.id);
        this.conversations.next(this.conversations.getValue().map(item => item.id === conversation.id ? selectedConversation : item));
        this.messages = [];
        this.historyCursor = undefined;
        this.loadHistory();
        if (this.connectionState === 'recovering') this.reconcileSelectedConversation();
    }

    public closeConversation(trackNavigationIntent = true): void {
        if (trackNavigationIntent) this.navigationIntentVersion++;
        this.showDepartedGroupStatus = false;
        this.stopTyping();
        this.clearRemoteTypingState();
        this.historyLoadID++;
        this.selectedConversation = undefined;
        this.notifications?.setSelectedConversationID?.(undefined);
        this.messages = [];
        this.historyCursor = undefined;
        this.isHistoryLoading = false;
        this.recoveryGeneration += 1;
        window.localStorage.removeItem(this.selectedConversationKey);
        if (this.connectionState === 'recovering') this.dataProvider.finishRecovery();
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
        const timeout = window.setTimeout(() => this.markMessageUncertain(requestID), 10_000);
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
            this.groupAccess.conversationCreated(event.payload.conversation_id, this.groupAccessContext(event.payload.conversation_id));
            this.dataProvider.send({type: 'presence.refresh'});
            return;
        }
        if (event.type === 'group.membership.changed') {
            const groupID = event.payload.conversation_id;
            this.groupAccess.membershipChanged(groupID, event.payload.membership_revision, event.payload.deleted, this.groupAccessContext(groupID));
            return;
        }
        if (event.type === 'conversation.read') {
            if (event.payload.user_id === this.profile?.id) {
                const sequence = this.ownReadSequences.get(event.payload.conversation_id) || 0;
                if (event.payload.sequence > sequence) this.ownReadSequences.set(event.payload.conversation_id, event.payload.sequence);
                this.clearConversationUnreadCount(event.payload.conversation_id);
            } else if (this.conversations.getValue().some(item => item.id === event.payload.conversation_id && item.kind !== 'group' && item.otherUserId === event.payload.user_id)) {
                const sequence = this.peerReadSequences.get(event.payload.conversation_id) || 0;
                if (event.payload.sequence > sequence) this.peerReadSequences.set(event.payload.conversation_id, event.payload.sequence);
            } else if (event.payload.visible_from_sequence !== undefined) {
                const wireCursor = {user_id: event.payload.user_id, sequence: event.payload.sequence, visible_from_sequence: event.payload.visible_from_sequence};
                const cursor = toGroupPeerReadCursor(wireCursor);
                const candidate = this.conversations.getValue().find(item => item.id === event.payload.conversation_id) || (this.selectedConversation?.id === event.payload.conversation_id ? this.selectedConversation : undefined);
                const group = candidate?.kind === 'group' ? candidate : undefined;
                if (cursor && group?.members.some(member => member.userId === cursor.userId && member.userId !== this.profile?.id)) this.storeGroupPeerReadCursor(event.payload.conversation_id, cursor);
            }
            this.changeDetector.markForCheck();
            return;
        }
        if (event.type === 'conversation.reconciled') {
            this.applyReconciliation(event);
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
            const selected = this.selectedConversation;
            if (!selected || event.payload.conversation_id !== selected.id) return;
            if (selected.kind === 'group') {
                const member = selected.members.find(candidate => candidate.userId === event.payload.user_id);
                if (!member || member.userId === this.profile?.id) return;
                window.clearTimeout(this.groupTypingTimeouts.get(member.userId));
                const timeout = window.setTimeout(() => {
                    if (this.selectedConversation?.id !== selected.id) return;
                    this.groupTypingTimeouts.delete(member.userId);
                    this.changeDetector.markForCheck();
                }, 5_000);
                this.groupTypingTimeouts.set(member.userId, timeout);
            } else if (event.payload.user_id === selected.otherUserId) {
                this.typingConversationID = selected.id;
                window.clearTimeout(this.remoteTypingTimeout);
                this.remoteTypingTimeout = window.setTimeout(() => {
                    this.typingConversationID = undefined;
                    this.changeDetector.markForCheck();
                }, 5_000);
            }
            this.changeDetector.markForCheck();
            return;
        }
        if (event.type === 'typing.stopped') {
            const selected = this.selectedConversation;
            if (!selected || event.payload.conversation_id !== selected.id) return;
            if (selected.kind === 'group') {
                const member = selected.members.find(candidate => candidate.userId === event.payload.user_id);
                if (member && member.userId !== this.profile?.id) {
                    const timeout = this.groupTypingTimeouts.get(member.userId);
                    if (timeout === undefined) return;
                    window.clearTimeout(timeout);
                    this.groupTypingTimeouts.delete(member.userId);
                    this.changeDetector.markForCheck();
                }
                return;
            }
            if (event.payload.user_id === selected.otherUserId && this.typingConversationID === selected.id) {
                this.typingConversationID = undefined;
                window.clearTimeout(this.remoteTypingTimeout);
                this.changeDetector.markForCheck();
            }
            return;
        }
        if (event.type === 'message.rejected') {
            if (event.request_id && event.request_id === this.reconciliationRequest?.requestID) {
                this.reconciliationRequest = undefined;
                this.loadHistory();
                this.changeDetector.markForCheck();
                return;
            }
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
        if (this.selectedConversation.kind === 'group' && this.selectedConversation.accessNeedsVerification) return;
        const pendingIndex = this.isOwnMessage(message) ? this.messages.findIndex(item => item.clientMessageId === message.clientMessageId) : -1;
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
        const generation = ++this.conversationRefreshGeneration;
        this.cancelGroupPageRequest();
        this.groupPageLoading = false;
        this.groupSnapshotLoading = true;
        this.refreshConversationsAttempt(generation, 2);
    }

    public retryConnection(): void {
        this.dataProvider.retryNow();
    }

    public refreshChats(): void {
        this.groupAccess.retryQuarantined();
        this.refreshConversations();
    }

    public canLoadMoreGroups(): boolean { return this.groupNextCursor !== null; }
    public get groupsExhausted(): boolean { return this.groupPageLoaded && this.groupNextCursor === null && this.conversations.getValue().some(item => item.kind === 'group'); }

    public groupRefreshStatusVisible(): boolean {
        const groupID = this.groupMembershipRefreshErrorConversationID;
        return this.groupAccess.hasQuarantinedGroups || (!!groupID && this.selectedConversation?.id === groupID && this.selectedConversation.kind === 'group');
    }

    public get departedGroupRefreshFailed(): boolean {
        return this.groupAccess.hasFailedQuarantines;
    }

    public get departedGroupRefreshPending(): boolean {
        return this.groupAccess.hasQuarantinedGroups && !this.departedGroupRefreshFailed;
    }

    private currentGroupProjection(groupID: string): GroupConversation | undefined {
        const listed = this.conversations.getValue().find(item => item.id === groupID);
        if (listed?.kind === 'group') return listed;
        return this.selectedConversation?.id === groupID && this.selectedConversation.kind === 'group' ? this.selectedConversation : undefined;
    }

    private completeInitialRecovery(): void {
        if (this.connectionState !== 'recovering' || this.hasEstablishedConnection || this.initialConversationLoadState === 'pending') return;
        if (this.initialConversationLoadState === 'failed') {
            this.dataProvider.failRecovery();
            return;
        }
        if (this.selectedConversation) this.reconcileSelectedConversation();
        else this.dataProvider.finishRecovery();
    }

    private loadInitialConversations(generation: number, retriesRemaining: number, projectionGeneration = this.groupAccess.projectionGeneration): void {
        const request = this.homeSnapshot().subscribe({
            next: snapshot => {
                const conversations = [...snapshot.direct, ...snapshot.groups.items];
                if (generation !== this.conversationRefreshGeneration) return;
                if (projectionGeneration !== this.groupAccess.projectionGeneration) {
                    this.loadInitialConversations(generation, retriesRemaining);
                    return;
                }
                if (conversations.length === 0 && retriesRemaining > 0) {
                    this.conversationRefreshTimer = window.setTimeout(() => {
                        this.conversationRefreshTimer = undefined;
                        this.loadInitialConversations(generation, retriesRemaining - 1);
                    }, 250);
                    return;
                }
                this.groupNextCursor = snapshot.groups.nextCursor;
                this.groupPageError = false;
                this.groupPageLoaded = true;
                const projectedConversations = this.mergeConversationSnapshot(conversations, false);
                this.conversations.next(projectedConversations);
                this.restoreSelectedConversation(projectedConversations);
                this.selectPendingIncomingCallConversation(true);
                this.initialConversationLoadState = 'ready';
                this.completeInitialRecovery();
                this.isLoading = false;
                this.changeDetector.markForCheck();
            },
            error: () => {
                if (generation !== this.conversationRefreshGeneration) return;
                if (retriesRemaining > 0) {
                    this.conversationRefreshTimer = window.setTimeout(() => {
                        this.conversationRefreshTimer = undefined;
                        this.loadInitialConversations(generation, retriesRemaining - 1);
                    }, 250);
                    return;
                }
                this.initialConversationLoadState = 'failed';
                this.completeInitialRecovery();
                this.isLoading = false;
                this.changeDetector.markForCheck();
            },
        });
        this.listRequests.add(request);
    }

    private refreshConversationsForRecovery(generation = ++this.recoveryGeneration, retriesRemaining = 2, projectionGeneration = this.groupAccess.projectionGeneration): void {
        if (retriesRemaining === 2) {
            ++this.conversationRefreshGeneration;
            this.cancelGroupPageRequest();
            this.groupSnapshotLoading = true;
        }
        const request = this.homeSnapshot().subscribe({
            next: snapshot => {
                const conversations = [...snapshot.direct, ...snapshot.groups.items];
                if (generation !== this.recoveryGeneration || (this.connectionState !== 'recovering' && this.connectionState !== 'ready')) return;
                if (projectionGeneration !== this.groupAccess.projectionGeneration) {
                    this.refreshConversationsForRecovery(generation, retriesRemaining, this.groupAccess.projectionGeneration);
                    return;
                }
                if (conversations.length === 0 && retriesRemaining > 0) {
                    this.conversationRefreshTimer = window.setTimeout(() => {
                        this.conversationRefreshTimer = undefined;
                        this.refreshConversationsForRecovery(generation, retriesRemaining - 1);
                    }, 250);
                    return;
                }
                this.groupNextCursor = snapshot.groups.nextCursor;
                this.groupSnapshotLoading = false;
                this.groupPageError = false;
                this.groupPageLoaded = true;
                const projectedConversations = this.mergeConversationSnapshot(conversations, true);
                this.conversations.next(projectedConversations);
                this.restoreSelectedConversation(projectedConversations);
                this.selectPendingIncomingCallConversation(true);
                if (this.selectedConversation) {
                    const selected = projectedConversations.find(item => item.id === this.selectedConversation?.id);
                    if (selected) this.selectedConversation = selected;
                    else this.closeConversation();
                }
                if (this.selectedConversation) this.reconcileSelectedConversation(generation);
                else this.dataProvider.finishRecovery();
                this.changeDetector.markForCheck();
            },
            error: () => {
                if (generation === this.recoveryGeneration && retriesRemaining === 0) this.groupSnapshotLoading = false;
                if (generation === this.recoveryGeneration && this.connectionState === 'recovering') this.dataProvider.failRecovery();
            },
        });
        this.listRequests.add(request);
    }

    private reconcileSelectedConversation(generation = this.recoveryGeneration, afterSequence?: number): void {
        const conversation = this.selectedConversation;
        if (!conversation || this.connectionState !== 'recovering') return;
        if (conversation.kind === 'group' && conversation.accessNeedsVerification) {
            this.dataProvider.finishRecovery();
            return;
        }
        const cursor = afterSequence ?? Math.max(0, ...this.messages.filter(message => !message.pending && message.conversationId === conversation.id).map(message => message.sequence));
        const requestID = createRandomID();
        this.recoveryGeneration = generation;
        this.reconciliationRequest = {generation, requestID, conversationID: conversation.id};
        if (!this.dataProvider.recover(conversation.id, cursor, requestID)) {
            this.reconciliationRequest = undefined;
            this.dataProvider.failRecovery();
            return;
        }
    }

    private reconciliationRequest?: {generation: number; requestID: string; conversationID: string};

    private applyReconciliation(event: Extract<MessageSocketEvent, {type: 'conversation.reconciled'}>): void {
        const request = this.reconciliationRequest;
        if (!request || request.requestID !== event.request_id || request.generation !== this.recoveryGeneration || request.conversationID !== this.selectedConversation?.id || event.payload.conversation_id !== request.conversationID) return;
        if (this.selectedConversation?.kind === 'group' && this.selectedConversation.accessNeedsVerification) {
            this.reconciliationRequest = undefined;
            return;
        }
        this.reconciliationRequest = undefined;
        const messages = event.payload.messages.map(toMessage).filter((message): message is Message => message !== null);
        this.messages = this.mergeHistoryMessages(messages);
        this.historyCursor = event.payload.has_more ? String(event.payload.next_after_sequence) : undefined;
        this.ownReadSequences.set(request.conversationID, event.payload.own_read_sequence);
        const reconciledConversation = this.conversations.getValue().find(item => item.id === request.conversationID) || this.selectedConversation;
        if (reconciledConversation?.kind === 'group') {
            for (const wireCursor of event.payload.peer_read_cursors || []) {
                const cursor = toGroupPeerReadCursor(wireCursor);
                if (cursor && cursor.userId !== this.profile?.id && reconciledConversation.members.some(member => member.userId === cursor.userId)) this.storeGroupPeerReadCursor(request.conversationID, cursor);
            }
        } else {
            this.peerReadSequences.set(request.conversationID, event.payload.peer_read_sequence);
        }
        this.clearSelectedConversationUnreadCount();
        this.changeDetector.markForCheck();
        this.scrollToLatest();
        if (event.payload.has_more) {
            this.reconcileSelectedConversation(request.generation, event.payload.next_after_sequence);
        }
    }

    private storeGroupPeerReadCursor(conversationID: string, cursor: GroupPeerReadCursor): void {
        const cursors = this.groupPeerReadCursors.get(conversationID) || new Map<string, GroupPeerReadCursor>();
        const current = cursors.get(cursor.userId);
        if (!current || cursor.sequence > current.sequence) cursors.set(cursor.userId, cursor);
        this.groupPeerReadCursors.set(conversationID, cursors);
    }

    private clearRemoteTypingState(): void {
        this.typingConversationID = undefined;
        window.clearTimeout(this.remoteTypingTimeout);
        this.remoteTypingTimeout = undefined;
        for (const timeout of this.groupTypingTimeouts.values()) window.clearTimeout(timeout);
        this.groupTypingTimeouts.clear();
    }

    private pruneGroupTypingUsers(group: GroupConversation): void {
        const memberIDs = new Set(group.members.map(member => member.userId));
        for (const [userID, timeout] of this.groupTypingTimeouts) {
            if (memberIDs.has(userID) && userID !== this.profile?.id) continue;
            window.clearTimeout(timeout);
            this.groupTypingTimeouts.delete(userID);
        }
    }

    private clearEphemeralRecoveryState(): void {
        this.socketError = false;
        this.socketReady = false;
        this.presenceReady = false;
        this.onlineUserIDs.clear();
        this.clearRemoteTypingState();
    }

    private refreshConversationsAttempt(generation: number, retriesRemaining: number, projectionGeneration = this.groupAccess.projectionGeneration): void {
        const request = this.homeSnapshot().subscribe({
            next: snapshot => {
                const conversations = [...snapshot.direct, ...snapshot.groups.items];
                if (generation !== this.conversationRefreshGeneration) return;
                if (projectionGeneration !== this.groupAccess.projectionGeneration) {
                    this.refreshConversationsAttempt(generation, retriesRemaining, this.groupAccess.projectionGeneration);
                    return;
                }
                this.groupNextCursor = snapshot.groups.nextCursor;
                this.groupSnapshotLoading = false;
                this.groupPageError = false;
                this.groupPageLoaded = true;
                const projectedConversations = this.mergeConversationSnapshot(conversations, true);
                this.conversations.next(projectedConversations);
                const selected = this.selectedConversation;
                const refreshedSelected = selected
                    ? projectedConversations.find(conversation => conversation.id === selected.id && conversation.kind === selected.kind)
                    : undefined;
                if (refreshedSelected) {
                    this.selectedConversation = refreshedSelected;
                    if (refreshedSelected.kind === 'group' && refreshedSelected.accessNeedsVerification) {
                        this.messages = [];
                        this.historyCursor = undefined;
                        this.showGroupManager = false;
                    } else if (refreshedSelected.kind === 'group') this.pruneGroupTypingUsers(refreshedSelected);
                } else if (selected?.kind === 'group') {
                    // A successful authorized list is authoritative: this group is no longer
                    // available to the current user. A failed list request never reaches here.
                    const removalRevision = this.groupAccess.revisionFor(selected.id, selected.membershipRevision);
                    this.groupAccess.definitiveRemoval(selected.id, removalRevision);
                } else if (selected) {
                    // Preserve active call ownership, but discard selected-chat state that is
                    // no longer authorized by the successful conversation list.
                    this.ownReadSequences.delete(selected.id);
                    this.peerReadSequences.delete(selected.id);
                    if (this.typingConversationID === selected.id) {
                        this.typingConversationID = undefined;
                        window.clearTimeout(this.remoteTypingTimeout);
                    }
                    this.closeConversation();
                }
                if (this.groupMembershipRefreshErrorConversationID && projectedConversations.some(conversation => conversation.id === this.groupMembershipRefreshErrorConversationID && !(conversation.kind === 'group' && conversation.accessNeedsVerification))) {
                    this.groupMembershipRefreshError = '';
                    this.groupMembershipRefreshErrorConversationID = undefined;
                }
                this.selectPendingIncomingCallConversation();
                this.changeDetector.markForCheck();
            },
            error: () => {
                if (generation !== this.conversationRefreshGeneration) return;
                if (retriesRemaining === 0) {
                    this.groupSnapshotLoading = false;
                    this.changeDetector.markForCheck();
                    return;
                }
                this.conversationRefreshTimer = window.setTimeout(() => {
                    this.conversationRefreshTimer = undefined;
                    this.refreshConversationsAttempt(generation, retriesRemaining - 1);
                }, 250);
            },
        });
        this.listRequests.add(request);
    }

    private mergeConversationSnapshot(incoming: readonly Conversation[], refresh: boolean): Conversation[] {
        const currentGroups = this.currentGroupProjections();
        const incomingGroups = incoming.filter((item): item is GroupConversation => item.kind === 'group');
        const authorizedGroups = this.groupAccess.projectConversationList(incomingGroups, currentGroups, false);
        const groupByID = new Map<string, GroupConversation>();
        for (const conversation of currentGroups) {
            if (refresh && !incomingGroups.some(group => group.id === conversation.id)) {
                const groupID = conversation.id;
                const context = this.groupAccessContext(groupID);
                this.staleGroupIDs.add(groupID);
                this.clearGroupProjectionLocally(groupID);
                this.groupAccess.quarantineForVerification(groupID, context);
                if (context.selected) this.groupAccess.verifyQuarantined(groupID, context);
                if (this.groupAccess.isQuarantined(groupID)) groupByID.set(groupID, this.groupVerificationPlaceholder(groupID));
            } else groupByID.set(conversation.id, conversation);
        }
        for (const group of authorizedGroups) {
            if (group.kind === 'group') groupByID.set(group.id, group);
        }
        const direct = incoming.filter(item => item.kind !== 'group');
        const merged = [...direct, ...groupByID.values()];
        return merged.sort(compareConversationActivityDescending);
    }

    private homeSnapshot(): Observable<{direct: Conversation[]; groups: {items: GroupConversation[]; nextCursor: string | null}}> {
        return this.conversationService.listHomeSnapshot();
    }

    private groupVerificationPlaceholder(groupID: string): GroupConversation {
        return {
            kind: 'group',
            id: groupID,
            name: 'Group access needs verification',
            avatarSeed: '',
            ownerId: '',
            membershipRevision: this.groupAccess.revisionFor(groupID),
            createdAt: '',
            lastMessageAt: '',
            unreadCount: 0,
            members: [],
            otherUserId: '',
            otherDisplayName: '',
            otherEmail: '',
            accessNeedsVerification: true,
        };
    }

    public loadMoreGroups(): void {
        if (this.groupPageLoading || this.groupSnapshotLoading || this.groupPageRequest || this.groupNextCursor === null) return;
        this.groupPageLoading = true;
        this.groupPageError = false;
        const generation = this.conversationRefreshGeneration;
        const cursor = this.groupNextCursor;
        const projectionGeneration = this.groupAccess.projectionGeneration;
        const request = this.conversationService.listGroupPage(cursor).pipe(finalize(() => {
            this.groupPageLoading = false;
            this.groupPageRequest = undefined;
        })).subscribe({
            next: page => {
                if (generation !== this.conversationRefreshGeneration) return;
                if (projectionGeneration !== this.groupAccess.projectionGeneration) {
                    this.groupPageLoading = false;
                    this.loadMoreGroups();
                    return;
                }
                this.groupNextCursor = page.nextCursor;
                const projected = this.groupAccess.projectConversationList(page.items, this.currentGroupProjections(), false);
                this.mergeGroupPage(projected);
                this.groupPageLoading = false;
                this.changeDetector.markForCheck();
            },
            error: () => {
                if (generation !== this.conversationRefreshGeneration) return;
                this.groupPageLoading = false;
                this.groupPageError = true;
                this.changeDetector.markForCheck();
            },
        });
        this.groupPageRequest = request.closed ? undefined : request;
        this.listRequests.add(request);
    }

    private cancelGroupPageRequest(): void {
        this.groupPageRequest?.unsubscribe();
        this.groupPageRequest = undefined;
    }

    private mergeGroupPage(groups: readonly Conversation[]): void {
        const byID = new Map(this.conversations.getValue().map(item => [item.id, item]));
        for (const group of groups) byID.set(group.id, group);
        this.conversations.next([...byID.values()].sort(compareConversationActivityDescending));
    }

    private mutateGroup(request: Observable<GroupConversation>, onSuccess?: () => void): void {
        if (this.groupLoading) return;
        this.runGroupMutation(request, group => {
            if (!this.upsertGroup(group)) return;
            onSuccess?.();
        }, 'Group changes could not be saved.');
    }

    private runGroupDeparture(groupID: string, request: Observable<void>): void {
        if (this.groupLoading) return;
        this.groupError = '';
        this.groupLoading = true;
        this.changeDetector.markForCheck();
        this.groupAccess.depart(groupID, request, this.currentGroupProjection(groupID)?.membershipRevision || 0, this.groupAccessContext(groupID));
    }

    private runGroupMutation<T>(request: Observable<T>, onSuccess: (value: T) => void, errorMessage: string, onFinished?: () => void, errorGroupID?: string): Subscription | undefined {
        if (this.groupLoading) return;
        this.groupLoading = true;
        this.groupError = '';
        this.changeDetector.markForCheck();
        const subscription = request.pipe(finalize(() => {
            this.groupLoading = false;
            onFinished?.();
            this.changeDetector.markForCheck();
        })).subscribe({
            next: value => {
                onSuccess(value);
                this.changeDetector.markForCheck();
            },
            error: () => {
                if (!errorGroupID || this.selectedConversation?.id === errorGroupID) this.groupError = errorMessage;
                this.changeDetector.markForCheck();
            },
        });
        this.groupMutationSubscriptions.add(subscription);
        return subscription;
    }
    private upsertGroup(group: GroupConversation): boolean {
        if (this.groupAccess.isQuarantined(group.id)) return false;
        if (!this.groupAccess.acceptProjection(group.id, group.membershipRevision)) {
            const current = this.currentGroupProjection(group.id);
            if (!current || current.membershipRevision < group.membershipRevision) return false;
        }
        this.clearedGroupProjections.delete(group.id);
        const previous = this.conversations.getValue().find(item => item.id === group.id);
        const membershipChanged = previous?.kind === 'group' && previous.membershipRevision !== group.membershipRevision;
        const selected = this.selectedConversation?.id === group.id;
        if (selected) {
            this.selectedConversation = group;
            this.pruneGroupTypingUsers(group);
        }
        this.conversations.next([group, ...this.conversations.getValue().filter(item => item.id !== group.id)]);
        if (selected) this.loadHistory();
        if (selected && membershipChanged) this.requestGroupPresenceRefresh();
        this.changeDetector.markForCheck();
        return true;
    }

    private requestGroupPresenceRefresh(): void {
        if (this.selectedConversation?.kind !== 'group' || !this.socketReady) return;
        const minimumInterval = 1_000;
        const elapsed = this.lastGroupPresenceRefreshAt === undefined ? minimumInterval : Date.now() - this.lastGroupPresenceRefreshAt;
        if (elapsed >= minimumInterval) {
            this.lastGroupPresenceRefreshAt = Date.now();
            this.dataProvider.send({type: 'presence.refresh'});
            return;
        }
        if (this.groupPresenceRefreshTimer !== undefined) return;
        this.groupPresenceRefreshTimer = window.setTimeout(() => {
            this.groupPresenceRefreshTimer = undefined;
            if (this.selectedConversation?.kind !== 'group' || !this.socketReady) return;
            this.lastGroupPresenceRefreshAt = Date.now();
            this.dataProvider.send({type: 'presence.refresh'});
        }, minimumInterval - elapsed);
    }


    private removeGroupLocally(groupID: string, membershipRevision = this.groupAccess.revisionFor(groupID, this.currentGroupProjection(groupID)?.membershipRevision || 0)): void {
        this.groupAccess.definitiveRemoval(groupID, membershipRevision);
    }

    private clearGroupProjectionLocally(groupID: string): void {
        if (this.clearedGroupProjections.has(groupID)) {
            this.conversations.next(this.conversations.getValue().filter(item => item.id !== groupID));
            this.changeDetector.markForCheck();
            return;
        }
        this.clearedGroupProjections.add(groupID);
        this.groupAccess.markProjectionChanged();
        this.groupPeerReadCursors.delete(groupID);
        this.ownReadSequences.delete(groupID);
        this.peerReadSequences.delete(groupID);
        if (this.groupMembershipRefreshErrorConversationID === groupID) {
            this.groupMembershipRefreshError = '';
            this.groupMembershipRefreshErrorConversationID = undefined;
        }
        for (const [requestID, pending] of this.pendingRequests) {
            const message = this.messages.find(item => item.clientMessageId === pending.clientMessageID);
            if (message?.conversationId !== groupID) continue;
            window.clearTimeout(pending.timeout);
            this.pendingRequests.delete(requestID);
        }
        this.conversations.next(this.conversations.getValue().filter(item => item.id !== groupID));
        if (this.selectedConversation?.id === groupID) {
            this.showGroupManager = false;
            this.stopTyping();
            this.draft = '';
            this.closeConversation(false);
            this.groupError = '';
        }
        this.changeDetector.markForCheck();
    }

    private currentGroupProjections(): GroupConversation[] {
        const groups = new Map<string, GroupConversation>();
        for (const conversation of this.conversations.getValue()) if (conversation.kind === 'group') groups.set(conversation.id, conversation);
        if (this.selectedConversation?.kind === 'group') groups.set(this.selectedConversation.id, this.selectedConversation);
        return [...groups.values()];
    }

    private groupAccessContext(groupID: string): HomeGroupAccessContext {
        return {
            selected: this.selectedConversation?.id === groupID && this.selectedConversation.kind === 'group',
            navigationIntentVersion: this.navigationIntentVersion,
            projectionRevision: this.currentGroupProjection(groupID)?.membershipRevision || 0,
        };
    }

    private handleGroupAccessOutcome(outcome: HomeGroupAccessOutcome): void {
        switch (outcome.type) {
            case 'quarantined':
                if (!this.staleGroupIDs.has(outcome.groupID) && this.currentGroupProjection(outcome.groupID)) this.clearGroupProjectionLocally(outcome.groupID);
                if (outcome.selected) this.showDepartedGroupStatus = true;
                break;
            case 'authorized': {
                this.staleGroupIDs.delete(outcome.group.id);
                this.clearedGroupProjections.delete(outcome.group.id);
                if (outcome.navigationIntentVersion === undefined && outcome.group.id === this.selectedConversation?.id && this.selectedConversation.kind === 'group') {
                    const wasQuarantined = this.selectedConversation.accessNeedsVerification === true;
                    if (wasQuarantined) {
                        this.groupMembershipRefreshError = '';
                        this.groupMembershipRefreshErrorConversationID = undefined;
                        this.showDepartedGroupStatus = false;
                        this.selectConversationInternal(outcome.group, true);
                        break;
                    }
                    this.selectedConversation = outcome.group;
                    this.conversations.next(this.conversations.getValue().map(item => item.id === outcome.group.id ? outcome.group : item));
                    this.groupMembershipRefreshError = '';
                    this.groupMembershipRefreshErrorConversationID = undefined;
                    break;
                }
                if (outcome.navigationIntentVersion === undefined && outcome.restoreSelected && !this.selectedConversation && !this.isCreatingGroup && this.showDepartedGroupStatus) {
                    this.conversations.next([outcome.group, ...this.conversations.getValue().filter(item => item.id !== outcome.group.id)]);
                    this.showDepartedGroupStatus = false;
                    this.selectConversationInternal(outcome.group, true);
                    break;
                }
                if (outcome.restoreSelected && outcome.navigationIntentVersion === this.navigationIntentVersion && !this.selectedConversation && !this.isCreatingGroup && (outcome.navigationIntentVersion !== undefined || this.showDepartedGroupStatus)) {
                    this.conversations.next([outcome.group, ...this.conversations.getValue().filter(item => item.id !== outcome.group.id)]);
                    this.showDepartedGroupStatus = false;
                    this.groupAccess.markAuthorized(outcome.group.id, outcome.group.membershipRevision);
                    this.selectConversationInternal(outcome.group, true);
                    break;
                }
                if (!this.upsertGroup(outcome.group)) break;
                if (outcome.restoreSelected) this.showDepartedGroupStatus = false;
                if (outcome.group.id === this.selectedConversation?.id && this.selectedConversation.kind === 'group') this.selectedConversation = outcome.group;
                if (outcome.restoreSelected) this.groupAccess.markAuthorized(outcome.group.id, outcome.group.membershipRevision);
                this.groupMembershipRefreshError = '';
                this.groupMembershipRefreshErrorConversationID = undefined;
                this.showDepartedGroupStatus = this.groupAccess.hasQuarantinedGroups && outcome.restoreSelected;
                break;
            }
            case 'removed':
                this.staleGroupIDs.delete(outcome.groupID);
                const removedCallMatches = this.groupCall?.state.room?.conversation_id === outcome.groupID || this.groupCall?.canRejoin?.(outcome.groupID) === true;
                if (this.currentGroupProjection(outcome.groupID) || removedCallMatches) this.clearGroupProjectionLocally(outcome.groupID);
                if (removedCallMatches && !this.abortedGroupCallConversations.has(outcome.groupID) && this.groupCall?.abort(outcome.groupID)) {
                    this.abortedGroupCallConversations.add(outcome.groupID);
                    this.groupCallMinimized = false;
                }
                if (!this.groupAccess.hasQuarantinedGroups) this.showDepartedGroupStatus = false;
                break;
            case 'retryable':
                if (outcome.quarantined) {
                    this.groupMembershipRefreshError = outcome.reason === 'sessionExpired'
                        ? 'Your session may have expired. Reconnect or sign in again to refresh group membership.'
                        : 'Could not refresh group membership. Try refreshing chats.';
                    this.groupMembershipRefreshErrorConversationID = outcome.groupID;
                    if (this.currentGroupProjection(outcome.groupID) && !this.currentGroupProjection(outcome.groupID)?.accessNeedsVerification) this.clearGroupProjectionLocally(outcome.groupID);
                    else if (this.groupCall?.isOngoing && this.groupCall.state.room?.conversation_id === outcome.groupID) this.clearGroupProjectionLocally(outcome.groupID);
                    this.showDepartedGroupStatus = this.groupAccess.hasQuarantinedGroups;
                }
                else if (outcome.reason === 'sessionExpired') {
                    this.groupMembershipRefreshError = 'Your session may have expired. Reconnect or sign in again to refresh group membership.';
                    this.groupMembershipRefreshErrorConversationID = outcome.groupID;
                } else {
                    this.groupMembershipRefreshError = 'Could not refresh group membership. Try refreshing chats.';
                    this.groupMembershipRefreshErrorConversationID = outcome.groupID;
                }
                break;
            case 'departure-pending':
                break;
            case 'departure-finished':
                this.groupLoading = false;
                if (outcome.failed && this.selectedConversation?.id === outcome.groupID) this.groupError = 'Could not complete group departure.';
                break;
        }
        this.changeDetector.markForCheck();
    }

    private selectIncomingCallConversation(conversationID: string): void {
        this.pendingIncomingCallConversation = {conversationID, navigationIntentVersion: this.navigationIntentVersion};
        this.selectPendingIncomingCallConversation();
    }

    private selectPendingIncomingCallConversation(conversationListResolved = false): void {
        const pending = this.pendingIncomingCallConversation;
        if (!pending) return;
        if (pending.navigationIntentVersion !== this.navigationIntentVersion) {
            this.pendingIncomingCallConversation = undefined;
            return;
        }
        const conversation = this.conversations.getValue().find(item => item.id === pending.conversationID);
        if (!conversation) {
            if (conversationListResolved) this.pendingIncomingCallConversation = undefined;
            return;
        }
        this.pendingIncomingCallConversation = undefined;
        if (this.selectedConversation?.id !== conversation.id) this.selectConversationInternal(conversation, true);
    }

    private stopTyping(): void {
        window.clearTimeout(this.typingTimeout);
        this.typingTimeout = undefined;
        const conversationID = this.typingTargetConversationID;
        if (this.isTyping && conversationID) this.dataProvider.send({type: 'typing.stop', payload: {conversation_id: conversationID}});
        this.isTyping = false;
        this.typingTargetConversationID = undefined;
        this.lastTypingStartAt = 0;
    }

    public loadOlderMessages(): void {
        if (this.historyCursor && !this.isHistoryLoading) {
            this.loadHistory(this.historyCursor, true);
        }
    }

    private loadHistory(before?: string, prepend = false): void {
        if (!this.selectedConversation || (this.selectedConversation.kind === 'group' && this.selectedConversation.accessNeedsVerification)) {
            return;
        }
        const conversationID = this.selectedConversation.id;
        const historyLoadID = ++this.historyLoadID;
        this.isHistoryLoading = true;
        this.conversationService.history(conversationID, before).subscribe({
            next: history => {
                if (!this.isCurrentHistoryLoad(historyLoadID, conversationID)) return;
                this.messages = this.mergeHistoryMessages([...history.messages].reverse());
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

    private mergeHistoryMessages(historyMessages: Message[]): Message[] {
        const historyMessageIDs = new Set(historyMessages.map(message => message.id));
        const durableOwnClientMessageIDs = new Set(historyMessages.filter(message => this.isOwnMessage(message)).map(message => message.clientMessageId));
        const liveMessages = this.messages.filter(message => !historyMessageIDs.has(message.id) && !(message.senderId === this.profile?.id && durableOwnClientMessageIDs.has(message.clientMessageId)));
        return [...historyMessages, ...liveMessages].sort((left, right) => {
            if (left.sequence > 0 && right.sequence > 0) return left.sequence - right.sequence;
            if (left.sequence > 0) return -1;
            if (right.sequence > 0) return 1;
            return left.createdAt.localeCompare(right.createdAt);
        });
    }

    private markSelectedConversationRead(): boolean {
        if (!this.socketReady || !this.selectedConversation || this.messages.length === 0) return false;
        if (this.selectedConversation.kind === 'group' && this.selectedConversation.accessNeedsVerification) return false;
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

    private markMessageUncertain(requestID: string): void {
        const pending = this.pendingRequests.get(requestID);
        if (!pending) return;
        window.clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestID);
        this.messages = this.messages.map(message => message.clientMessageId === pending.clientMessageID ? {...message, pending: false, uncertain: true} : message);
        this.sendStatus = 'Message acknowledgement delayed. It will retry when the connection is ready.';
        this.changeDetector.markForCheck();
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

    private replayUncertainMessages(): void {
        for (const message of this.messages.filter(item => item.uncertain && !item.pending && item.senderId === this.profile?.id)) {
            const requestID = createRandomID();
            if (!this.dataProvider.send({
                type: 'message.send',
                request_id: requestID,
                payload: {conversation_id: message.conversationId, client_message_id: message.clientMessageId, body: message.body},
            })) continue;
            const timeout = window.setTimeout(() => this.markMessageUncertain(requestID), 10_000);
            this.pendingRequests.set(requestID, {clientMessageID: message.clientMessageId, timeout});
            this.messages = this.messages.map(item => item.clientMessageId === message.clientMessageId ? {...item, pending: true} : item);
        }
        if (this.pendingRequests.size > 0) this.sendStatus = '';
    }

    private restoreSelectedConversation(conversations: Conversation[]): void {
        const selectedConversationID = window.localStorage.getItem(this.selectedConversationKey);
        if (!selectedConversationID) return;
        const selectedConversation = conversations.find(item => item.id === selectedConversationID);
        if (selectedConversation) {
            this.selectConversationInternal(selectedConversation, true);
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
