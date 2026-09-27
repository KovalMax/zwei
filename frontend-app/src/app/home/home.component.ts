import {ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, Optional, ViewChild} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {BehaviorSubject, finalize, Observable, Subscription} from 'rxjs';
import {Conversation, GroupConversation, GroupMember, GroupPeerReadCursor, GroupRole} from './conversation.model';
import {ConversationService} from './conversation.service';
import {Message, messageDateLabel, messageDateTimeLabel} from './message.model';
import {UserSearchResult} from './user.model';
import {ConnectionState, DataProviderService, MessageSocketEvent} from './data-provider.service';
import {createRandomID} from '../login/login';
import {AuthService} from '../auth/auth.service';
import {Profile} from '../auth/profile.model';
import {messageSenderDisplayName, toGroupPeerReadCursor, toMessage} from './wire.mapper';
import {CallFacade, CallState} from './call-facade.service';
import {GroupCallFacade, GroupCallPeer} from './group-call-facade.service';
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
    providers: [DataProviderService, CallFacade, GroupCallFacade, HomeNotificationService],
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
    public groupName = '';
    public groupMemberQuery = '';
    public groupMemberResults: UserSearchResult[] = [];
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
    public groupScreenQuality: '360p' | '720p' | '1080p' | '2k' = '720p';
    private typingTimeout?: number;
    private typingTargetConversationID?: string;
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
    // These per-Home high-water marks retain only the latest revision. A strictly newer
    // membership replaces its removal fence, so this is not a permanent group-ID blacklist.
    private readonly groupMembershipRevisions = new Map<string, number>();
    // Cleared when an accepted projection has a membership revision greater than this value.
    private readonly removedGroupMembershipRevisions = new Map<string, number>();
    private groupProjectionGeneration = 0;
    private recoveryGeneration = 0;
    @ViewChild('messageHistory') private messageHistory?: ElementRef<HTMLElement>;
    @ViewChild(GroupMemberListComponent) private groupMemberList?: GroupMemberListComponent;

    constructor(private conversationService: ConversationService, private authService: AuthService, private changeDetector: ChangeDetectorRef, private dataProvider: DataProviderService, public call: CallFacade, @Optional() private readonly notifications?: HomeNotificationService, @Optional() public groupCall?: GroupCallFacade) {
    }

    public ngOnInit(): void {
        this.authService.profile().subscribe({next: profile => {
            this.profile = profile;
            this.notifications?.setUserID(profile.id);
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
            if (state.phase === 'idle' || state.phase === 'ended' || state.phase === 'error') this.groupCallMinimized = false;
            this.changeDetector.markForCheck();
        });
    }

    public ngOnDestroy(): void {
        for (const pending of this.pendingRequests.values()) window.clearTimeout(pending.timeout);
        this.stopTyping();
        window.clearTimeout(this.remoteTypingTimeout);
        window.clearTimeout(this.groupPresenceRefreshTimer);
        window.clearTimeout(this.conversationRefreshTimer);
        this.callStateSubscription?.unsubscribe();
        this.groupCallStateSubscription?.unsubscribe();
        this.stopCallTimer();
        this.call.close();
        this.groupCall?.close();
        this.dataProvider.close();
    }

    public startCall(): void {
        if (this.selectedConversation?.kind === 'direct') void this.call.start(this.selectedConversation.id, this.selectedConversation.otherUserId);
    }

    public startGroupCall(): void {
        if (this.selectedConversation?.kind !== 'group' || !this.profile?.id || !this.groupCall) return;
        // The facade publishes requesting state before awaiting microphone access.
        // Schedule this OnPush view in the same click turn so the initiator sees
        // the call card before a room event can arrive from the socket.
        void this.groupCall.start(this.selectedConversation.id, this.profile.id);
        this.changeDetector.markForCheck();
    }

    public joinGroupCall(): void {
        const room = this.groupCall?.state.room;
        if (room && this.profile?.id) void this.groupCall?.join(room, this.profile.id);
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
            case 'leave': this.groupCall?.leave(); break;
            case 'end': this.groupCall?.end(); break;
            case 'presentation-ready': this.playGroupPresentation(intent.event); break;
        }
    }

    public trackConversation(_index: number, conversation: Conversation): string { return conversation.id; }
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
        return {
            name: this.callDisplayName(),
            status: state.statusLabel,
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
    public conversationSubtitle(conversation: Conversation): string { return conversation.kind === 'group' ? `${conversation.members.length} members` : conversation.otherEmail; }
    public isGroup(conversation = this.selectedConversation): conversation is GroupConversation { return conversation?.kind === 'group'; }
    public get groupSelected(): GroupConversation | undefined { return this.selectedConversation?.kind === 'group' ? this.selectedConversation : undefined; }
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

    public createGroup(): void {
        if (this.groupLoading) return;
        const name = this.groupName.trim();
        if (!name) { this.groupError = 'Enter a group name.'; return; }
        this.runGroupMutation(this.conversationService.createGroup(name, []), group => {
            if (!this.upsertGroup(group)) return;
            this.groupName = '';
            this.isCreatingGroup = false;
            this.showGroupManager = true;
            this.selectConversation(group);
        }, 'Could not create the group.');
    }

    public openGroupCreation(): void {
        if (this.groupLoading) return;
        this.closeConversation();
        this.groupName = '';
        this.groupError = '';
        this.isCreatingGroup = true;
        this.changeDetector.markForCheck();
    }

    public cancelGroupCreation(): void {
        if (this.groupLoading) return;
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
        this.selectedGroupMember = undefined;
        if (query.length < 2) { this.groupMemberResults = []; return; }
        this.conversationService.searchUsers(query).subscribe({next: results => { this.groupMemberResults = results; this.changeDetector.markForCheck(); }});
    }

    public selectGroupMember(user: UserSearchResult): void {
        this.selectedGroupMember = user;
        this.groupMemberQuery = user.display_name;
        this.groupMemberResults = [];
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
            this.runGroupMutation(this.conversationService.leaveGroup(group.id), () => this.removeGroupLocally(group.id), 'Could not leave the group.');
        }
    }
    public deleteGroup(): void {
        if (this.groupLoading) return;
        const group = this.selectedConversation;
        if (group?.kind === 'group' && window.confirm('Delete this group for all members?')) {
            this.runGroupMutation(this.conversationService.deleteGroup(group.id), () => this.removeGroupLocally(group.id), 'Could not delete the group.');
        }
    }

    public selectConversation(conversation: Conversation, preserveCallSurface = false): void {
        this.stopTyping();
        if (!preserveCallSurface && this.isOngoingCall()) this.minimizeCall();
        const selectedConversation = {...conversation};
        this.isCreatingGroup = false;
        if (selectedConversation.kind === 'group') this.groupName = selectedConversation.name;
        this.selectedConversation = selectedConversation;
        if (selectedConversation.kind === 'group') this.requestGroupPresenceRefresh();
        this.notifications?.setSelectedConversationID(conversation.id);
        window.localStorage.setItem(this.selectedConversationKey, conversation.id);
        this.conversations.next(this.conversations.getValue().map(item => item.id === conversation.id ? selectedConversation : item));
        this.messages = [];
        this.historyCursor = undefined;
        this.loadHistory();
        if (this.connectionState === 'recovering') this.reconcileSelectedConversation();
    }

    public closeConversation(): void {
        this.stopTyping();
        this.historyLoadID++;
        this.selectedConversation = undefined;
        this.notifications?.setSelectedConversationID(undefined);
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
            const getGroup = this.conversationService.getGroup;
            if (typeof getGroup === 'function') {
                const conversationID = event.payload.conversation_id;
                const requestRevision = this.currentGroupProjectionRevision(conversationID);
                getGroup.call(this.conversationService, conversationID).subscribe({next: group => {
                    if (group.id === conversationID) this.upsertGroup(group);
                }, error: error => {
                    if (this.currentGroupProjectionRevision(conversationID) !== requestRevision) return;
                    if (this.isConfirmedGroupProjectionRemoval(error)) {
                        if (this.currentGroupProjection(conversationID) || this.groupMembershipRevisions.has(conversationID)) this.removeGroupLocally(conversationID, requestRevision);
                    } else {
                        this.reportGroupProjectionRefreshError(conversationID, error);
                    }
                }});
            }
            this.dataProvider.send({type: 'presence.refresh'});
            return;
        }
        if (event.type === 'group.membership.changed') {
            const currentRevision = this.currentGroupProjectionRevision(event.payload.conversation_id);
            if (event.payload.membership_revision <= currentRevision) return;
            this.groupMembershipRevisions.set(event.payload.conversation_id, event.payload.membership_revision);
            if (event.payload.deleted) {
                this.removedGroupMembershipRevisions.set(event.payload.conversation_id, event.payload.membership_revision);
                this.groupProjectionGeneration++;
                if (this.groupMembershipRefreshErrorConversationID === event.payload.conversation_id) {
                    this.groupMembershipRefreshError = '';
                    this.groupMembershipRefreshErrorConversationID = undefined;
                }
                this.removeGroupLocally(event.payload.conversation_id, event.payload.membership_revision);
                return;
            }
            this.removedGroupMembershipRevisions.delete(event.payload.conversation_id);
            this.groupProjectionGeneration++;
            this.conversationService.getGroup(event.payload.conversation_id).subscribe({
                next: group => {
                    if (group.id !== event.payload.conversation_id || group.membershipRevision < event.payload.membership_revision) return;
                    if (!this.upsertGroup(group)) return;
                    if (this.groupMembershipRefreshErrorConversationID === group.id) {
                        this.groupMembershipRefreshError = '';
                        this.groupMembershipRefreshErrorConversationID = undefined;
                    }
                    this.groupError = '';
                },
                error: error => {
                    if (this.currentGroupProjectionRevision(event.payload.conversation_id) !== event.payload.membership_revision || this.removedGroupMembershipRevisions.has(event.payload.conversation_id)) return;
                    if (this.isConfirmedGroupProjectionRemoval(error)) {
                        this.removeGroupLocally(event.payload.conversation_id, event.payload.membership_revision);
                        return;
                    }
                    this.reportGroupProjectionRefreshError(event.payload.conversation_id, error);
                },
            });
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
            if (event.payload.conversation_id === this.selectedConversation?.id && (this.selectedConversation.kind === 'group' ? event.payload.user_id !== this.profile?.id : event.payload.user_id === this.selectedConversation.otherUserId)) {
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
            const selected = this.selectedConversation;
            const isSelectedDirectPeer = selected !== undefined && selected.kind !== 'group' && event.payload.user_id === selected.otherUserId;
            const isSelectedGroupPeer = selected?.kind === 'group' && event.payload.user_id !== this.profile?.id;
            if (event.payload.conversation_id === this.typingConversationID && (isSelectedDirectPeer || isSelectedGroupPeer)) {
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
        this.refreshConversationsAttempt(generation, 2);
    }

    public retryConnection(): void {
        this.dataProvider.retryNow();
    }

    public refreshChats(): void {
        this.refreshConversations();
    }

    private isConfirmedGroupProjectionRemoval(error: unknown): boolean {
        return error instanceof HttpErrorResponse && [403, 404].includes(error.status);
    }

    private currentGroupProjectionRevision(groupID: string): number {
        const projected = this.currentGroupProjection(groupID)?.membershipRevision || 0;
        return Math.max(this.groupMembershipRevisions.get(groupID) || 0, this.removedGroupMembershipRevisions.get(groupID) || 0, projected);
    }

    private currentGroupProjection(groupID: string): GroupConversation | undefined {
        const listed = this.conversations.getValue().find(item => item.id === groupID);
        if (listed?.kind === 'group') return listed;
        return this.selectedConversation?.id === groupID && this.selectedConversation.kind === 'group' ? this.selectedConversation : undefined;
    }

    private acceptGroupProjectionRevision(groupID: string, membershipRevision: number): boolean {
        const currentRevision = this.groupMembershipRevisions.get(groupID);
        const removedRevision = this.removedGroupMembershipRevisions.get(groupID);
        if (currentRevision !== undefined && membershipRevision < currentRevision) return false;
        if (removedRevision !== undefined && membershipRevision <= removedRevision) return false;

        const revisionAdvanced = currentRevision === undefined || membershipRevision > currentRevision;
        if (revisionAdvanced) this.groupMembershipRevisions.set(groupID, membershipRevision);
        if (removedRevision !== undefined && membershipRevision > removedRevision) this.removedGroupMembershipRevisions.delete(groupID);
        if (revisionAdvanced || removedRevision !== undefined) this.groupProjectionGeneration++;
        return true;
    }

    private markGroupProjectionRemoved(groupID: string, membershipRevision: number): void {
        const removalRevision = Math.max(membershipRevision, this.currentGroupProjectionRevision(groupID));
        const removedRevision = this.removedGroupMembershipRevisions.get(groupID);
        if (removedRevision !== undefined && removedRevision >= removalRevision) return;
        this.groupMembershipRevisions.set(groupID, removalRevision);
        this.removedGroupMembershipRevisions.set(groupID, removalRevision);
        this.groupProjectionGeneration++;
    }

    private projectConversationList(conversations: readonly Conversation[]): Conversation[] {
        const currentGroups = new Map<string, GroupConversation>();
        for (const conversation of this.conversations.getValue()) {
            if (conversation.kind === 'group') currentGroups.set(conversation.id, conversation);
        }
        if (this.selectedConversation?.kind === 'group') currentGroups.set(this.selectedConversation.id, this.selectedConversation);

        const incomingGroupIDs = new Set<string>();
        const projected: Conversation[] = [];
        for (const conversation of conversations) {
            if (conversation.kind !== 'group') {
                projected.push(conversation);
                continue;
            }
            incomingGroupIDs.add(conversation.id);
            if (this.acceptGroupProjectionRevision(conversation.id, conversation.membershipRevision)) {
                projected.push(conversation);
                continue;
            }
            const current = currentGroups.get(conversation.id);
            if (current && !this.removedGroupMembershipRevisions.has(conversation.id)) projected.push(current);
        }

        for (const [groupID, group] of currentGroups) {
            if (!incomingGroupIDs.has(groupID) && !this.removedGroupMembershipRevisions.has(groupID)) {
                this.markGroupProjectionRemoved(groupID, group.membershipRevision);
            }
        }
        return projected;
    }

    private reportGroupProjectionRefreshError(groupID: string, error: unknown): void {
        if (this.selectedConversation?.id !== groupID || this.selectedConversation.kind !== 'group') return;
        this.groupMembershipRefreshError = error instanceof HttpErrorResponse && error.status === 401
            ? 'Your session may have expired. Reconnect or sign in again to refresh group membership. Your group remains selected.'
            : 'Could not refresh group membership. Your group remains selected.';
        this.groupMembershipRefreshErrorConversationID = groupID;
        this.changeDetector.markForCheck();
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

    private loadInitialConversations(generation: number, retriesRemaining: number, projectionGeneration = this.groupProjectionGeneration): void {
        this.conversationService.list().subscribe({
            next: conversations => {
                if (generation !== this.conversationRefreshGeneration) return;
                if (projectionGeneration !== this.groupProjectionGeneration) {
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
                const projectedConversations = this.projectConversationList(conversations);
                this.conversations.next(projectedConversations);
                this.restoreSelectedConversation(projectedConversations);
                this.selectPendingIncomingCallConversation();
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
    }

    private refreshConversationsForRecovery(generation = ++this.recoveryGeneration, retriesRemaining = 2, projectionGeneration = this.groupProjectionGeneration): void {
        if (retriesRemaining === 2) ++this.conversationRefreshGeneration;
        this.conversationService.list().subscribe({
            next: conversations => {
                if (generation !== this.recoveryGeneration || (this.connectionState !== 'recovering' && this.connectionState !== 'ready')) return;
                if (projectionGeneration !== this.groupProjectionGeneration) {
                    this.refreshConversationsForRecovery(generation, retriesRemaining, this.groupProjectionGeneration);
                    return;
                }
                if (conversations.length === 0 && retriesRemaining > 0) {
                    this.conversationRefreshTimer = window.setTimeout(() => {
                        this.conversationRefreshTimer = undefined;
                        this.refreshConversationsForRecovery(generation, retriesRemaining - 1);
                    }, 250);
                    return;
                }
                const projectedConversations = this.projectConversationList(conversations);
                this.conversations.next(projectedConversations);
                this.restoreSelectedConversation(projectedConversations);
                this.selectPendingIncomingCallConversation();
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
                if (generation === this.recoveryGeneration && this.connectionState === 'recovering') this.dataProvider.failRecovery();
            },
        });
    }

    private reconcileSelectedConversation(generation = this.recoveryGeneration, afterSequence?: number): void {
        const conversation = this.selectedConversation;
        if (!conversation || this.connectionState !== 'recovering') return;
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

    private clearEphemeralRecoveryState(): void {
        this.socketError = false;
        this.socketReady = false;
        this.presenceReady = false;
        this.onlineUserIDs.clear();
        this.typingConversationID = undefined;
        window.clearTimeout(this.remoteTypingTimeout);
    }

    private refreshConversationsAttempt(generation: number, retriesRemaining: number, projectionGeneration = this.groupProjectionGeneration): void {
        this.conversationService.list().subscribe({
            next: conversations => {
                if (generation !== this.conversationRefreshGeneration) return;
                if (projectionGeneration !== this.groupProjectionGeneration) {
                    this.refreshConversationsAttempt(generation, retriesRemaining, this.groupProjectionGeneration);
                    return;
                }
                const projectedConversations = this.projectConversationList(conversations);
                this.conversations.next(projectedConversations);
                const selected = this.selectedConversation;
                const refreshedSelected = selected
                    ? projectedConversations.find(conversation => conversation.id === selected.id && conversation.kind === selected.kind)
                    : undefined;
                if (refreshedSelected) {
                    this.selectedConversation = refreshedSelected;
                } else if (selected?.kind === 'group') {
                    // A successful authorized list is authoritative: this group is no longer
                    // available to the current user. A failed list request never reaches here.
                    this.removeGroupLocally(selected.id);
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
                if (this.groupMembershipRefreshErrorConversationID && projectedConversations.some(conversation => conversation.id === this.groupMembershipRefreshErrorConversationID)) {
                    this.groupMembershipRefreshError = '';
                    this.groupMembershipRefreshErrorConversationID = undefined;
                }
                this.selectPendingIncomingCallConversation();
                this.changeDetector.markForCheck();
            },
            error: () => {
                if (generation !== this.conversationRefreshGeneration || retriesRemaining === 0) return;
                this.conversationRefreshTimer = window.setTimeout(() => {
                    this.conversationRefreshTimer = undefined;
                    this.refreshConversationsAttempt(generation, retriesRemaining - 1);
                }, 250);
            },
        });
    }

    private mutateGroup(request: Observable<GroupConversation>, onSuccess?: () => void): void {
        if (this.groupLoading) return;
        this.runGroupMutation(request, group => {
            if (!this.upsertGroup(group)) return;
            onSuccess?.();
        }, 'Group changes could not be saved.');
    }

    private runGroupMutation<T>(request: Observable<T>, onSuccess: (value: T) => void, errorMessage: string): void {
        if (this.groupLoading) return;
        this.groupLoading = true;
        this.groupError = '';
        this.changeDetector.markForCheck();
        request.pipe(finalize(() => {
            this.groupLoading = false;
            this.changeDetector.markForCheck();
        })).subscribe({
            next: value => {
                onSuccess(value);
                this.changeDetector.markForCheck();
            },
            error: () => {
                this.groupError = errorMessage;
                this.changeDetector.markForCheck();
            },
        });
    }
    private upsertGroup(group: GroupConversation): boolean {
        if (!this.acceptGroupProjectionRevision(group.id, group.membershipRevision)) return false;
        this.groupProjectionGeneration++;
        const previous = this.conversations.getValue().find(item => item.id === group.id);
        const membershipChanged = previous?.kind === 'group' && previous.membershipRevision !== group.membershipRevision;
        const selected = this.selectedConversation?.id === group.id;
        if (selected) this.selectedConversation = group;
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
    private removeGroupLocally(groupID: string, membershipRevision = this.currentGroupProjectionRevision(groupID)): void {
        this.markGroupProjectionRemoved(groupID, membershipRevision);
        this.groupPeerReadCursors.delete(groupID);
        this.ownReadSequences.delete(groupID);
        this.peerReadSequences.delete(groupID);
        if (this.groupMembershipRefreshErrorConversationID === groupID) {
            this.groupMembershipRefreshError = '';
            this.groupMembershipRefreshErrorConversationID = undefined;
        }
        if (this.groupCall?.abort(groupID)) this.groupCallMinimized = false;
        for (const [requestID, pending] of this.pendingRequests) {
            const message = this.messages.find(item => item.clientMessageId === pending.clientMessageID);
            if (message?.conversationId !== groupID) continue;
            window.clearTimeout(pending.timeout);
            this.pendingRequests.delete(requestID);
        }
        this.conversations.next(this.conversations.getValue().filter(item => item.id !== groupID));
        this.showGroupManager = false;
        if (this.selectedConversation?.id === groupID) {
            this.stopTyping();
            this.draft = '';
            this.closeConversation();
        }
        this.groupError = '';
        this.changeDetector.markForCheck();
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
        if (!this.selectedConversation) {
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
